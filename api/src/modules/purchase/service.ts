/**
 * Purchase service.
 *
 * Mirrors the sale service, with three differences that come from the domain
 * rather than from style:
 *
 *   1. Purchases consume RAW products (`raw_product`), not finished goods —
 *      confirmed from PurchaseController.cs:69.
 *   2. There is no COGS leg. A purchase capitalises value into stock; nothing
 *      is expensed until the goods are sold.
 *   3. `rent` is inward freight and is capitalised into stock value, so the
 *      inventory debit is sub_total + rent rather than sub_total alone.
 *
 * The legacy PINV entry already balanced, so the posting rules are preserved.
 * What changes is that totals are recomputed here instead of being taken from
 * the browser.
 */
import { db, withTransaction, type Tx } from '../../core/db/index.js';
import { add, gt, money, mul, sub, type MoneyString } from '../../core/money.js';
import { badRequest, notFound, unprocessable } from '../../core/errors.js';
import { issueDocumentNumber } from '../../core/numbering.js';
import { formatInvoiceAudit, writeAudit } from '../../core/audit.js';
import { assertBranchAccess, resolveBranchId, type Principal } from '../../core/rbac.js';
import { VTYPE } from '../../accounting/accounts.js';
import { postPurchase } from '../../accounting/rules/purchase.js';
import { postJournals, repostDocument } from '../../accounting/post.js';
import { fmt } from '../../accounting/journal.js';

export interface PurchaseLineInput {
  pid: number;
  qty: string;
  price: string;
  discount: string;
}

export interface PurchaseInput {
  date: string;
  supId: number;
  branchId?: number | undefined;
  /** Invoice-level discount, on top of any per-line discounts. */
  discount: string;
  /** Inward freight. Capitalised into stock value, not expensed. */
  rent: string;
  paid: string;
  notes?: string | null | undefined;
  lines: PurchaseLineInput[];
}

export interface ComputedLine extends PurchaseLineInput {
  pname: string;
  total: MoneyString;
  netTotal: MoneyString;
}

export interface PurchaseTotals {
  lines: ComputedLine[];
  /** Sum of line totals before any discount. */
  subTotal: MoneyString;
  lineDiscount: MoneyString;
  totalDiscount: MoneyString;
  rent: MoneyString;
  /** What lands in inventory: sub_total + rent. */
  stockValue: MoneyString;
  netTotal: MoneyString;
  paid: MoneyString;
  remaining: MoneyString;
}

export async function computeTotals(
  input: PurchaseInput,
  executor: Tx | typeof db = db,
): Promise<PurchaseTotals> {
  if (input.lines.length === 0) {
    throw badRequest('A purchase needs at least one line item');
  }

  const ids = [...new Set(input.lines.map((l) => l.pid))];

  const products = await executor
    .selectFrom('raw_product')
    .select(['id', 'name'])
    .where('id', 'in', ids)
    .execute();

  const byId = new Map(products.map((p) => [p.id, p]));
  const missing = ids.filter((id) => !byId.has(id));

  if (missing.length > 0) {
    throw badRequest(`Unknown raw item id(s): ${missing.join(', ')}`);
  }

  const lines: ComputedLine[] = [];
  let subTotal = '0.00';
  let lineDiscount = '0.00';

  for (const [i, line] of input.lines.entries()) {
    const product = byId.get(line.pid)!;

    if (!gt(line.qty, '0.000')) {
      throw badRequest(`Line ${i + 1}: quantity must be greater than zero`);
    }
    if (Number(line.price) < 0 || Number(line.discount) < 0) {
      throw badRequest(`Line ${i + 1}: price and discount cannot be negative`);
    }

    const total = mul(line.qty, line.price);

    if (gt(line.discount, total)) {
      throw badRequest(
        `Line ${i + 1}: discount ${fmt(line.discount)} exceeds the line total ${fmt(total)}`,
      );
    }

    lines.push({
      ...line,
      pname: product.name ?? '',
      total,
      netTotal: sub(total, line.discount),
    });

    subTotal = add(subTotal, total);
    lineDiscount = add(lineDiscount, line.discount);
  }

  const totalDiscount = add(lineDiscount, input.discount);
  const rent = money(input.rent);
  const stockValue = add(subTotal, rent);

  // The posting rule asserts stockValue - discount === netTotal, so derive it
  // the same way rather than trusting a client-sent figure.
  const netTotal = sub(stockValue, totalDiscount);

  if (Number(netTotal) < 0) {
    throw unprocessable(
      `Discount ${fmt(totalDiscount)} exceeds the purchase value ${fmt(stockValue)}`,
    );
  }

  const paid = money(input.paid);

  if (gt(paid, netTotal)) {
    throw unprocessable(`Paid ${fmt(paid)} is more than the invoice total ${fmt(netTotal)}`);
  }

  return {
    lines,
    subTotal,
    lineDiscount,
    totalDiscount,
    rent,
    stockValue,
    netTotal,
    paid,
    remaining: sub(netTotal, paid),
  };
}

async function resolveSupplier(
  supId: number,
  executor: Tx,
): Promise<{ accountId: number; label: string }> {
  const supplier = await executor
    .selectFrom('supplier')
    .select(['id', 'name', 'account_no'])
    .where('id', '=', supId)
    .executeTakeFirst();

  if (!supplier) throw badRequest(`Unknown supplier id ${supId}`);

  if (!supplier.account_no) {
    throw unprocessable(
      `Supplier "${supplier.name}" has no chart-of-accounts code, so the purchase cannot be posted`,
    );
  }

  return { accountId: supplier.account_no, label: supplier.name ?? '' };
}

async function writeLines(
  tx: Tx,
  purchaseId: number,
  lines: readonly ComputedLine[],
): Promise<void> {
  await tx
    .insertInto('purchase_detail')
    .values(
      lines.map((l) => ({
        purchase_id: purchaseId,
        pid: l.pid,
        pname: l.pname,
        price: l.price,
        qty: l.qty,
        total: l.total,
        discount: l.discount,
        net_total: l.netTotal,
      })),
    )
    .execute();
}

function auditDetail(
  id: number,
  action: 'New' | 'Edit',
  label: string,
  totals: PurchaseTotals,
): string {
  return formatInvoiceAudit({
    invoiceId: id,
    action,
    module: 'Purchase',
    party: `Supplier: ${label}`,
    gross: fmt(totals.subTotal),
    discount: fmt(totals.totalDiscount),
    net: fmt(totals.netTotal),
    received: fmt(totals.paid),
    remaining: fmt(totals.remaining),
    items: totals.lines.map((l) => ({
      pid: l.pid,
      qty: l.qty,
      price: fmt(l.price),
      total: fmt(l.total),
      discount: fmt(l.discount),
      netTotal: fmt(l.netTotal),
    })),
  });
}

// ---------------------------------------------------------------------------

export async function createPurchase(
  principal: Principal,
  input: PurchaseInput,
): Promise<{ id: number }> {
  const branchId = resolveBranchId(principal, input.branchId);
  assertBranchAccess(principal, branchId);

  return withTransaction(async (tx) => {
    const totals = await computeTotals(input, tx);
    const supplier = await resolveSupplier(input.supId, tx);

    const { docNumber } = await issueDocumentNumber(tx, branchId, 'PURCHASE');

    const purchase = await tx
      .insertInto('purchase')
      .values({
        date: input.date,
        doc_number: docNumber,
        sup_id: input.supId,
        branch_id: branchId,
        gross_total: totals.subTotal,
        sub_total: totals.subTotal,
        discount: totals.totalDiscount,
        rent: totals.rent,
        net_total: totals.netTotal,
        paid: totals.paid,
        remaining: totals.remaining,
        notes: input.notes ?? null,
        inv_type: VTYPE.PURCHASE,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await writeLines(tx, purchase.id, totals.lines);

    await postJournals(
      tx,
      postPurchase({
        invId: purchase.id,
        date: input.date,
        branchId,
        supplierAccountId: supplier.accountId,
        supplierLabel: supplier.label,
        subTotal: totals.subTotal,
        rent: totals.rent,
        discount: totals.totalDiscount,
        netTotal: totals.netTotal,
        paid: totals.paid,
      }),
    );

    await writeAudit(
      principal,
      {
        form: 'Purchase',
        action: 'New',
        detail: auditDetail(purchase.id, 'New', supplier.label, totals),
        invId: purchase.id,
      },
      tx,
    );

    return { id: purchase.id };
  });
}

export async function updatePurchase(
  principal: Principal,
  purchaseId: number,
  input: PurchaseInput,
): Promise<{ id: number }> {
  const existing = await db
    .selectFrom('purchase')
    .select(['id', 'branch_id'])
    .where('id', '=', purchaseId)
    .executeTakeFirst();

  if (!existing) throw notFound('Purchase');
  assertBranchAccess(principal, existing.branch_id);

  const branchId = resolveBranchId(principal, input.branchId ?? existing.branch_id);

  return withTransaction(async (tx) => {
    const totals = await computeTotals(input, tx);
    const supplier = await resolveSupplier(input.supId, tx);

    await tx
      .updateTable('purchase')
      .set({
        date: input.date,
        sup_id: input.supId,
        branch_id: branchId,
        gross_total: totals.subTotal,
        sub_total: totals.subTotal,
        discount: totals.totalDiscount,
        rent: totals.rent,
        net_total: totals.netTotal,
        paid: totals.paid,
        remaining: totals.remaining,
        notes: input.notes ?? null,
        updated_at: new Date(),
        updated_by: principal.empId,
      })
      .where('id', '=', purchaseId)
      .execute();

    await tx.deleteFrom('purchase_detail').where('purchase_id', '=', purchaseId).execute();
    await writeLines(tx, purchaseId, totals.lines);

    const journals = postPurchase({
      invId: purchaseId,
      date: input.date,
      branchId,
      supplierAccountId: supplier.accountId,
      supplierLabel: supplier.label,
      subTotal: totals.subTotal,
      rent: totals.rent,
      discount: totals.totalDiscount,
      netTotal: totals.netTotal,
      paid: totals.paid,
    });

    // Two voucher types, reversed independently — see the same note in the sale
    // service. Passing the whole list to both calls would post the payment twice.
    await repostDocument(
      tx,
      VTYPE.PURCHASE,
      purchaseId,
      journals.filter((j) => j.vtype === VTYPE.PURCHASE),
    );

    await repostDocument(
      tx,
      VTYPE.CASH_PAYMENT,
      purchaseId,
      journals.filter((j) => j.vtype === VTYPE.CASH_PAYMENT),
    );

    await writeAudit(
      principal,
      {
        form: 'Purchase',
        action: 'Edit',
        detail: auditDetail(purchaseId, 'Edit', supplier.label, totals),
        invId: purchaseId,
      },
      tx,
    );

    return { id: purchaseId };
  });
}
