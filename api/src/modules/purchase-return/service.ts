/**
 * Purchase return service.
 *
 * The mirror of a purchase: stock leaves and the supplier owes us. No COGS leg
 * — nothing was ever expensed, so nothing is un-expensed.
 *
 * The legacy PRINV entry already balanced; these rules are preserved.
 */
import { db, withTransaction, type Tx } from '../../core/db/index.js';
import { add, gt, money, mul, sub, type MoneyString } from '../../core/money.js';
import { badRequest, notFound, unprocessable } from '../../core/errors.js';
import { formatInvoiceAudit, writeAudit } from '../../core/audit.js';
import { assertBranchAccess, resolveBranchId, type Principal } from '../../core/rbac.js';
import { VTYPE } from '../../accounting/accounts.js';
import { postPurchaseReturn } from '../../accounting/rules/purchase.js';
import { postJournals, repostDocument } from '../../accounting/post.js';
import { fmt } from '../../accounting/journal.js';

export interface PurchaseReturnLineInput {
  pid: number;
  qty: string;
  price: string;
  discount: string;
}

export interface PurchaseReturnInput {
  date: string;
  supId: number;
  branchId?: number | undefined;
  discount: string;
  /** Freight on the return leg. Reduces the stock credit, as on a purchase. */
  rent: string;
  /** Cash refunded by the supplier. */
  received: string;
  notes?: string | null | undefined;
  lines: PurchaseReturnLineInput[];
}

export interface ComputedLine extends PurchaseReturnLineInput {
  pname: string;
  total: MoneyString;
  netTotal: MoneyString;
}

export interface PurchaseReturnTotals {
  lines: ComputedLine[];
  subTotal: MoneyString;
  lineDiscount: MoneyString;
  totalDiscount: MoneyString;
  rent: MoneyString;
  stockValue: MoneyString;
  netTotal: MoneyString;
  received: MoneyString;
  remaining: MoneyString;
}

export async function computeTotals(
  input: PurchaseReturnInput,
  executor: Tx | typeof db = db,
): Promise<PurchaseReturnTotals> {
  if (input.lines.length === 0) {
    throw badRequest('A purchase return needs at least one line item');
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
  const netTotal = sub(stockValue, totalDiscount);

  if (Number(netTotal) < 0) {
    throw unprocessable(
      `Discount ${fmt(totalDiscount)} exceeds the return value ${fmt(stockValue)}`,
    );
  }

  const received = money(input.received);

  if (gt(received, netTotal)) {
    throw unprocessable(`Refund ${fmt(received)} is more than the return total ${fmt(netTotal)}`);
  }

  return {
    lines,
    subTotal,
    lineDiscount,
    totalDiscount,
    rent,
    stockValue,
    netTotal,
    received,
    remaining: sub(netTotal, received),
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
      `Supplier "${supplier.name}" has no chart-of-accounts code, so the return cannot be posted`,
    );
  }

  return { accountId: supplier.account_no, label: supplier.name ?? '' };
}

async function writeLines(tx: Tx, returnId: number, lines: readonly ComputedLine[]): Promise<void> {
  await tx
    .insertInto('purchase_return_detail')
    .values(
      lines.map((l) => ({
        purchase_id: returnId,
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
  totals: PurchaseReturnTotals,
): string {
  return formatInvoiceAudit({
    invoiceId: id,
    action,
    module: 'Purchase Return',
    party: `Supplier: ${label}`,
    gross: fmt(totals.subTotal),
    discount: fmt(totals.totalDiscount),
    net: fmt(totals.netTotal),
    received: fmt(totals.received),
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

export async function createPurchaseReturn(
  principal: Principal,
  input: PurchaseReturnInput,
): Promise<{ id: number }> {
  const branchId = resolveBranchId(principal, input.branchId);
  assertBranchAccess(principal, branchId);

  return withTransaction(async (tx) => {
    const totals = await computeTotals(input, tx);
    const supplier = await resolveSupplier(input.supId, tx);

    const created = await tx
      .insertInto('purchase_return')
      .values({
        date: input.date,
        sup_id: input.supId,
        branch_id: branchId,
        gross_total: totals.subTotal,
        sub_total: totals.subTotal,
        discount: totals.totalDiscount,
        rent: totals.rent,
        net_total: totals.netTotal,
        received: totals.received,
        remaining: totals.remaining,
        notes: input.notes ?? null,
        inv_type: VTYPE.PURCHASE_RETURN,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await writeLines(tx, created.id, totals.lines);

    await postJournals(
      tx,
      postPurchaseReturn({
        invId: created.id,
        date: input.date,
        branchId,
        supplierAccountId: supplier.accountId,
        supplierLabel: supplier.label,
        subTotal: totals.subTotal,
        rent: totals.rent,
        discount: totals.totalDiscount,
        netTotal: totals.netTotal,
        received: totals.received,
      }),
    );

    await writeAudit(
      principal,
      {
        form: 'Purchase Return',
        action: 'New',
        detail: auditDetail(created.id, 'New', supplier.label, totals),
        invId: created.id,
      },
      tx,
    );

    return { id: created.id };
  });
}

export async function updatePurchaseReturn(
  principal: Principal,
  returnId: number,
  input: PurchaseReturnInput,
): Promise<{ id: number }> {
  const existing = await db
    .selectFrom('purchase_return')
    .select(['id', 'branch_id'])
    .where('id', '=', returnId)
    .executeTakeFirst();

  if (!existing) throw notFound('Purchase Return');
  assertBranchAccess(principal, existing.branch_id);

  const branchId = resolveBranchId(principal, input.branchId ?? existing.branch_id);

  return withTransaction(async (tx) => {
    const totals = await computeTotals(input, tx);
    const supplier = await resolveSupplier(input.supId, tx);

    await tx
      .updateTable('purchase_return')
      .set({
        date: input.date,
        sup_id: input.supId,
        branch_id: branchId,
        gross_total: totals.subTotal,
        sub_total: totals.subTotal,
        discount: totals.totalDiscount,
        rent: totals.rent,
        net_total: totals.netTotal,
        received: totals.received,
        remaining: totals.remaining,
        notes: input.notes ?? null,
        updated_at: new Date(),
        updated_by: principal.empId,
      })
      .where('id', '=', returnId)
      .execute();

    await tx
      .deleteFrom('purchase_return_detail')
      .where('purchase_id', '=', returnId)
      .execute();

    await writeLines(tx, returnId, totals.lines);

    const journals = postPurchaseReturn({
      invId: returnId,
      date: input.date,
      branchId,
      supplierAccountId: supplier.accountId,
      supplierLabel: supplier.label,
      subTotal: totals.subTotal,
      rent: totals.rent,
      discount: totals.totalDiscount,
      netTotal: totals.netTotal,
      received: totals.received,
    });

    await repostDocument(
      tx,
      VTYPE.PURCHASE_RETURN,
      returnId,
      journals.filter((j) => j.vtype === VTYPE.PURCHASE_RETURN),
    );

    await repostDocument(
      tx,
      VTYPE.CASH_RECEIPT,
      returnId,
      journals.filter((j) => j.vtype === VTYPE.CASH_RECEIPT),
    );

    await writeAudit(
      principal,
      {
        form: 'Purchase Return',
        action: 'Edit',
        detail: auditDetail(returnId, 'Edit', supplier.label, totals),
        invId: returnId,
      },
      tx,
    );

    return { id: returnId };
  });
}
