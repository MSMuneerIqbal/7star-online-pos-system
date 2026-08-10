/**
 * Sale return service.
 *
 * The mirror of a sale: revenue is reversed and goods come back into stock, so
 * this still needs COGS from the product cost table.
 *
 * The legacy SRINV entry already balanced, so the posting rules are preserved
 * as-is. What changes is that totals are recomputed here rather than taken from
 * the browser, and the whole thing commits in one transaction.
 */
import { db, withTransaction, type Tx } from '../../core/db/index.js';
import { add, gt, money, mul, sub, type MoneyString } from '../../core/money.js';
import { badRequest, notFound, unprocessable } from '../../core/errors.js';
import { formatInvoiceAudit, writeAudit } from '../../core/audit.js';
import { assertBranchAccess, resolveBranchId, type Principal } from '../../core/rbac.js';
import { VTYPE, WALK_IN_CUSTOMER_ID } from '../../accounting/accounts.js';
import { postSaleReturn } from '../../accounting/rules/sale.js';
import { postJournals, repostDocument } from '../../accounting/post.js';
import { fmt } from '../../accounting/journal.js';

export interface SaleReturnLineInput {
  pid: number;
  qty: string;
  price: string;
  discount: string;
}

export interface SaleReturnInput {
  date: string;
  custId: number;
  /** The original invoice, when the return references one. */
  saleId?: number | null | undefined;
  branchId?: number | undefined;
  discount: string;
  /** Cash refunded to the customer. */
  paid: string;
  notes?: string | null | undefined;
  lines: SaleReturnLineInput[];
}

export interface ComputedLine extends SaleReturnLineInput {
  pname: string;
  total: MoneyString;
  netTotal: MoneyString;
  cost: MoneyString;
}

export interface SaleReturnTotals {
  lines: ComputedLine[];
  grossTotal: MoneyString;
  lineDiscount: MoneyString;
  totalDiscount: MoneyString;
  netTotal: MoneyString;
  /** Value of the goods coming back into stock. */
  cogs: MoneyString;
  paid: MoneyString;
  remaining: MoneyString;
}

export async function computeTotals(
  input: SaleReturnInput,
  executor: Tx | typeof db = db,
): Promise<SaleReturnTotals> {
  if (input.lines.length === 0) {
    throw badRequest('A sale return needs at least one line item');
  }

  const ids = [...new Set(input.lines.map((l) => l.pid))];

  const products = await executor
    .selectFrom('product')
    .select(['id', 'name', 'price'])
    .where('id', 'in', ids)
    .execute();

  const byId = new Map(products.map((p) => [p.id, p]));
  const missing = ids.filter((id) => !byId.has(id));

  if (missing.length > 0) {
    throw badRequest(`Unknown product id(s): ${missing.join(', ')}`);
  }

  const lines: ComputedLine[] = [];
  let grossTotal = '0.00';
  let lineDiscount = '0.00';
  let cogs = '0.00';

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
      cost: mul(line.qty, product.price),
    });

    grossTotal = add(grossTotal, total);
    lineDiscount = add(lineDiscount, line.discount);
    cogs = add(cogs, mul(line.qty, product.price));
  }

  const totalDiscount = add(lineDiscount, input.discount);
  // No service charge on a return — the credit is gross less discount.
  const netTotal = sub(grossTotal, totalDiscount);

  if (Number(netTotal) < 0) {
    throw unprocessable(
      `Discount ${fmt(totalDiscount)} exceeds the return value ${fmt(grossTotal)}`,
    );
  }

  const paid = money(input.paid);

  if (gt(paid, netTotal)) {
    throw unprocessable(`Refund ${fmt(paid)} is more than the return total ${fmt(netTotal)}`);
  }

  return {
    lines,
    grossTotal,
    lineDiscount,
    totalDiscount,
    netTotal,
    cogs,
    paid,
    remaining: sub(netTotal, paid),
  };
}

async function resolveCustomer(
  custId: number,
  executor: Tx,
): Promise<{ accountId: number; label: string }> {
  const customer = await executor
    .selectFrom('customer')
    .select(['id', 'name', 'account_id'])
    .where('id', '=', custId)
    .executeTakeFirst();

  if (!customer) throw badRequest(`Unknown customer id ${custId}`);

  if (!customer.account_id) {
    throw unprocessable(
      `Customer "${customer.name}" has no chart-of-accounts code, so the return cannot be posted`,
    );
  }

  return {
    accountId: customer.account_id,
    label:
      custId === WALK_IN_CUSTOMER_ID
        ? 'Cash Customer'
        : `Customer: ${customer.name ?? ''}`,
  };
}

/**
 * A return may not credit more than the original invoice.
 *
 * The legacy system never checked this, so a customer could be credited
 * repeatedly against one sale.
 */
async function assertWithinOriginal(
  tx: Tx,
  saleId: number,
  netTotal: MoneyString,
  excludeReturnId?: number,
): Promise<void> {
  const sale = await tx
    .selectFrom('sale')
    .select(['id', 'net_total'])
    .where('id', '=', saleId)
    .executeTakeFirst();

  if (!sale) throw badRequest(`Unknown sale invoice ${saleId}`);

  let prior = tx
    .selectFrom('sale_return')
    .select(({ fn }) => fn.sum<string>('net_total').as('total'))
    .where('sale_id', '=', saleId);

  if (excludeReturnId !== undefined) prior = prior.where('id', '!=', excludeReturnId);

  const returned = (await prior.executeTakeFirst())?.total ?? '0';
  const combined = add(returned, netTotal);

  if (gt(combined, sale.net_total)) {
    throw unprocessable(
      `Returning ${fmt(netTotal)} would bring total returns against invoice ${saleId} to ` +
        `${fmt(combined)}, more than the invoice value of ${fmt(sale.net_total)}`,
      { invoiceTotal: sale.net_total, alreadyReturned: returned },
    );
  }
}

async function writeLines(tx: Tx, returnId: number, lines: readonly ComputedLine[]): Promise<void> {
  await tx
    .insertInto('sale_return_detail')
    .values(
      lines.map((l) => ({
        sale_id: returnId,
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
  totals: SaleReturnTotals,
): string {
  return formatInvoiceAudit({
    invoiceId: id,
    action,
    module: 'Sale Return',
    party: label,
    gross: fmt(totals.grossTotal),
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

export async function createSaleReturn(
  principal: Principal,
  input: SaleReturnInput,
): Promise<{ id: number }> {
  const branchId = resolveBranchId(principal, input.branchId);
  assertBranchAccess(principal, branchId);

  return withTransaction(async (tx) => {
    const totals = await computeTotals(input, tx);
    const customer = await resolveCustomer(input.custId, tx);

    if (input.saleId) await assertWithinOriginal(tx, input.saleId, totals.netTotal);

    const created = await tx
      .insertInto('sale_return')
      .values({
        date: input.date,
        sale_id: input.saleId ?? null,
        cust_id: input.custId,
        branch_id: branchId,
        gross_total: totals.grossTotal,
        sub_total: totals.grossTotal,
        discount: totals.totalDiscount,
        service: '0',
        net_total: totals.netTotal,
        paid: totals.paid,
        remaining: totals.remaining,
        notes: input.notes ?? null,
        inv_type: VTYPE.SALE_RETURN,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await writeLines(tx, created.id, totals.lines);

    await postJournals(
      tx,
      postSaleReturn({
        invId: created.id,
        date: input.date,
        branchId,
        customerAccountId: customer.accountId,
        customerLabel: customer.label,
        netTotal: totals.netTotal,
        cogs: totals.cogs,
        paid: totals.paid,
      }),
    );

    await writeAudit(
      principal,
      {
        form: 'Sale Return',
        action: 'New',
        detail: auditDetail(created.id, 'New', customer.label, totals),
        invId: created.id,
      },
      tx,
    );

    return { id: created.id };
  });
}

export async function updateSaleReturn(
  principal: Principal,
  returnId: number,
  input: SaleReturnInput,
): Promise<{ id: number }> {
  const existing = await db
    .selectFrom('sale_return')
    .select(['id', 'branch_id'])
    .where('id', '=', returnId)
    .executeTakeFirst();

  if (!existing) throw notFound('Sale Return');
  assertBranchAccess(principal, existing.branch_id);

  const branchId = resolveBranchId(principal, input.branchId ?? existing.branch_id);

  return withTransaction(async (tx) => {
    const totals = await computeTotals(input, tx);
    const customer = await resolveCustomer(input.custId, tx);

    if (input.saleId) {
      await assertWithinOriginal(tx, input.saleId, totals.netTotal, returnId);
    }

    await tx
      .updateTable('sale_return')
      .set({
        date: input.date,
        sale_id: input.saleId ?? null,
        cust_id: input.custId,
        branch_id: branchId,
        gross_total: totals.grossTotal,
        sub_total: totals.grossTotal,
        discount: totals.totalDiscount,
        net_total: totals.netTotal,
        paid: totals.paid,
        remaining: totals.remaining,
        notes: input.notes ?? null,
        updated_at: new Date(),
        updated_by: principal.empId,
      })
      .where('id', '=', returnId)
      .execute();

    await tx.deleteFrom('sale_return_detail').where('sale_id', '=', returnId).execute();
    await writeLines(tx, returnId, totals.lines);

    const journals = postSaleReturn({
      invId: returnId,
      date: input.date,
      branchId,
      customerAccountId: customer.accountId,
      customerLabel: customer.label,
      netTotal: totals.netTotal,
      cogs: totals.cogs,
      paid: totals.paid,
    });

    // Each voucher type reverses against its own (vtype, inv_id) key.
    await repostDocument(
      tx,
      VTYPE.SALE_RETURN,
      returnId,
      journals.filter((j) => j.vtype === VTYPE.SALE_RETURN),
    );

    await repostDocument(
      tx,
      VTYPE.CASH_PAYMENT,
      returnId,
      journals.filter((j) => j.vtype === VTYPE.CASH_PAYMENT),
    );

    await writeAudit(
      principal,
      {
        form: 'Sale Return',
        action: 'Edit',
        detail: auditDetail(returnId, 'Edit', customer.label, totals),
        invId: returnId,
      },
      tx,
    );

    return { id: returnId };
  });
}
