/**
 * Sale service.
 *
 * Where the posting engine meets real data. Everything a sale touches — header,
 * line items, walk-in customer, ledger journals and the audit row — happens
 * inside ONE transaction. The legacy `Sale.Save` issued several SaveChanges()
 * calls plus six unwrapped raw inserts, so a failure midway could leave
 * inventory issued with no revenue recorded.
 *
 * The other significant change: totals and COGS are recomputed here from the
 * line items and the product cost table. The legacy code posted whatever
 * numbers the browser sent, so a tampered or stale form wrote a wrong ledger.
 */
import { db, withTransaction, type Tx } from '../../core/db/index.js';
import { sql } from 'kysely';
import { add, gt, money, mul, sub, type MoneyString } from '../../core/money.js';
import { badRequest, notFound, unprocessable } from '../../core/errors.js';
import { issueDocumentNumber } from '../../core/numbering.js';
import { formatInvoiceAudit, writeAudit } from '../../core/audit.js';
import { assertBranchAccess, resolveBranchId, type Principal } from '../../core/rbac.js';
import { VTYPE, WALK_IN_CUSTOMER_ID } from '../../accounting/accounts.js';
import { postSale } from '../../accounting/rules/sale.js';
import { postJournals, repostDocument } from '../../accounting/post.js';
import { fmt } from '../../accounting/journal.js';

export interface SaleLineInput {
  /** PRODUCT (stock) or SERVICE (charge line — revenue, no stock movement). */
  lineType?: 'PRODUCT' | 'SERVICE' | undefined;
  /** 0 for service lines. */
  pid: number;
  /** Free-text name for a service line. */
  pname?: string | null | undefined;
  qty: string;
  price: string;
  discount: string;
}

/**
 * Optional fields are written `?: T | undefined` deliberately. Under
 * `exactOptionalPropertyTypes`, a Zod-parsed body carries these keys present
 * with an undefined value, which a bare `?: T` would reject.
 */
export interface SaleInput {
  date: string;
  custId: number;
  branchId?: number | undefined;
  /** Invoice-level discount, on top of any per-line discounts. */
  discount: string;
  service: string;
  received: string;
  notes?: string | null | undefined;
  lines: SaleLineInput[];
  /** Populated when custId is the walk-in customer. */
  walkIn?:
    | {
        name?: string | null | undefined;
        phone?: string | null | undefined;
        address?: string | null | undefined;
      }
    | undefined;
}

export interface ComputedLine extends SaleLineInput {
  lineType: 'PRODUCT' | 'SERVICE';
  pname: string;
  /** qty x price, before discount. */
  total: MoneyString;
  netTotal: MoneyString;
  /** Cost of goods sold contribution — zero for service lines. */
  cost: MoneyString;
}

export interface SaleTotals {
  lines: ComputedLine[];
  grossTotal: MoneyString;
  lineDiscount: MoneyString;
  /** Invoice discount + the sum of line discounts. */
  totalDiscount: MoneyString;
  service: MoneyString;
  netTotal: MoneyString;
  cogs: MoneyString;
  received: MoneyString;
  remaining: MoneyString;
}

/** The branch's current on-hand quantity of a finished product. */
async function branchStock(
  executor: Tx | typeof db,
  branchId: number,
  pid: number,
): Promise<string> {
  const row = await sql<{ qty: string }>`
    SELECT COALESCE(SUM(qty), 0)::text AS qty
    FROM   stock_movement
    WHERE  kind = 'FINISH' AND pid = ${pid} AND branch_id = ${branchId}
  `.execute(executor);
  return row.rows[0]?.qty ?? '0';
}

/**
 * Price and cost every line from the database, then derive the invoice totals.
 *
 * Selling price comes from the request, but it cannot drop below the branch's
 * minimum price, and it cannot exceed what the branch has on hand. COGS is the
 * branch's weighted-average wholesale cost — always read, never client-supplied.
 */
export async function computeTotals(
  input: SaleInput,
  branchId: number,
  executor: Tx | typeof db = db,
): Promise<SaleTotals> {
  if (input.lines.length === 0) {
    throw badRequest('A sale needs at least one line item');
  }

  const productLines = input.lines.filter((l) => (l.lineType ?? 'PRODUCT') === 'PRODUCT');
  const ids = [...new Set(productLines.map((l) => l.pid))];

  const [products, branchProducts] = await Promise.all([
    ids.length > 0
      ? executor.selectFrom('product').select(['id', 'name']).where('id', 'in', ids).execute()
      : Promise.resolve([]),
    ids.length > 0
      ? executor
          .selectFrom('branch_product')
          .select(['product_id', 'wholesale_cost', 'minimum_price'])
          .where('branch_id', '=', branchId)
          .where('product_id', 'in', ids)
          .execute()
      : Promise.resolve([]),
  ]);

  const byId = new Map(products.map((p) => [p.id, p]));
  const bpById = new Map(branchProducts.map((bp) => [bp.product_id, bp]));

  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw badRequest(`Unknown product id(s): ${missing.join(', ')}`);
  }

  // Total quantity demanded per product, so one product across two lines is
  // checked against stock once.
  const demanded = new Map<number, string>();
  for (const l of productLines) {
    demanded.set(l.pid, add(demanded.get(l.pid) ?? '0', l.qty));
  }

  const lines: ComputedLine[] = [];
  let grossTotal = '0.00';
  let lineDiscount = '0.00';
  let cogs = '0.00';

  for (const [i, line] of input.lines.entries()) {
    const isService = (line.lineType ?? 'PRODUCT') === 'SERVICE';

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

    let cost = '0.00';
    let pname = line.pname ?? '';

    if (!isService) {
      const product = byId.get(line.pid)!;
      const bp = bpById.get(line.pid);

      // Price floor: a salesman cannot discount below the branch's minimum.
      if (bp && Number(bp.minimum_price) > 0 && Number(line.price) < Number(bp.minimum_price)) {
        throw badRequest(
          `Line ${i + 1}: price ${fmt(line.price)} is below the minimum price ${fmt(bp.minimum_price)} for ${product.name}`,
        );
      }

      // Stock: quantity cannot exceed what the branch holds.
      const onHand = await branchStock(executor, branchId, line.pid);
      if (gt(demanded.get(line.pid) ?? '0', onHand)) {
        throw badRequest(
          `Line ${i + 1}: only ${onHand} of ${product.name} in stock, ${demanded.get(line.pid)} requested`,
        );
      }

      cost = mul(line.qty, bp?.wholesale_cost ?? '0');
      pname = product.name ?? '';
    }

    lines.push({
      ...line,
      lineType: isService ? 'SERVICE' : 'PRODUCT',
      pname,
      total,
      netTotal: sub(total, line.discount),
      cost,
    });

    grossTotal = add(grossTotal, total);
    lineDiscount = add(lineDiscount, line.discount);
    cogs = add(cogs, cost);
  }

  const totalDiscount = add(lineDiscount, input.discount);
  const service = money(input.service);

  // gross + service - discount, matching the posting rule's expectation.
  const netTotal = sub(add(grossTotal, service), totalDiscount);

  if (Number(netTotal) < 0) {
    throw unprocessable(
      `Discount ${fmt(totalDiscount)} exceeds the invoice value ${fmt(add(grossTotal, service))}`,
    );
  }

  const received = money(input.received);

  if (gt(received, netTotal)) {
    throw unprocessable(
      `Received ${fmt(received)} is more than the invoice total ${fmt(netTotal)}`,
    );
  }

  return {
    lines,
    grossTotal,
    lineDiscount,
    totalDiscount,
    service,
    netTotal,
    cogs,
    received,
    remaining: sub(netTotal, received),
  };
}

/** Resolve the customer's receivable account and a display label for the ledger. */
async function resolveCustomer(
  custId: number,
  walkIn: SaleInput['walkIn'],
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
      `Customer "${customer.name}" has no chart-of-accounts code, so the sale cannot be posted`,
    );
  }

  const label =
    custId === WALK_IN_CUSTOMER_ID && walkIn?.name
      ? `Cash Customer: ${walkIn.name}${walkIn.phone ? `, Ph: ${walkIn.phone}` : ''}`
      : `Customer: ${customer.name ?? ''}`;

  return { accountId: customer.account_id, label };
}

/** Insert or update the inline walk-in record, returning its id. */
async function upsertWalkIn(
  tx: Tx,
  branchId: number,
  walkIn: SaleInput['walkIn'],
  existingId: number | null,
): Promise<number | null> {
  if (!walkIn?.name && !walkIn?.phone) return existingId;

  if (existingId) {
    await tx
      .updateTable('sale_customer')
      .set({
        name: walkIn.name ?? null,
        phone: walkIn.phone ?? null,
        address: walkIn.address ?? null,
      })
      .where('id', '=', existingId)
      .execute();

    return existingId;
  }

  const created = await tx
    .insertInto('sale_customer')
    .values({
      name: walkIn.name ?? null,
      phone: walkIn.phone ?? null,
      address: walkIn.address ?? null,
      branch_id: branchId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return created.id;
}

async function writeLines(tx: Tx, saleId: number, lines: readonly ComputedLine[]): Promise<void> {
  await tx
    .insertInto('sale_detail')
    .values(
      lines.map((l) => ({
        sale_id: saleId,
        pid: l.lineType === 'SERVICE' ? 0 : l.pid,
        pname: l.pname,
        line_type: l.lineType,
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
  saleId: number,
  action: 'New' | 'Edit' | 'Delete',
  label: string,
  totals: SaleTotals,
): string {
  return formatInvoiceAudit({
    invoiceId: saleId,
    action,
    module: 'Sale',
    party: label,
    gross: fmt(totals.grossTotal),
    discount: fmt(totals.totalDiscount),
    service: fmt(totals.service),
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
// Operations
// ---------------------------------------------------------------------------

export async function createSale(principal: Principal, input: SaleInput): Promise<{ id: number }> {
  const branchId = resolveBranchId(principal, input.branchId);
  assertBranchAccess(principal, branchId);

  return withTransaction(async (tx) => {
    const totals = await computeTotals(input, branchId, tx);
    const customer = await resolveCustomer(input.custId, input.walkIn, tx);

    const saleCustId =
      input.custId === WALK_IN_CUSTOMER_ID
        ? await upsertWalkIn(tx, branchId, input.walkIn, null)
        : null;

    const { docNumber } = await issueDocumentNumber(
      tx,
      branchId,
      input.custId === WALK_IN_CUSTOMER_ID ? 'SALE_WALKIN' : 'SALE_CREDIT',
    );

    const sale = await tx
      .insertInto('sale')
      .values({
        date: input.date,
        doc_number: docNumber,
        cust_id: input.custId,
        sale_cust_id: saleCustId,
        branch_id: branchId,
        gross_total: totals.grossTotal,
        sub_total: totals.grossTotal,
        discount: totals.totalDiscount,
        service: totals.service,
        net_total: totals.netTotal,
        received: totals.received,
        remaining: totals.remaining,
        notes: input.notes ?? null,
        inv_type: VTYPE.SALE,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await writeLines(tx, sale.id, totals.lines);

    // Throws if the entry does not balance — nothing is committed.
    await postJournals(
      tx,
      postSale({
        invId: sale.id,
        date: input.date,
        branchId,
        customerAccountId: customer.accountId,
        customerLabel: customer.label,
        grossTotal: totals.grossTotal,
        discount: totals.totalDiscount,
        service: totals.service,
        netTotal: totals.netTotal,
        cogs: totals.cogs,
        received: totals.received,
      }),
    );

    await writeAudit(
      principal,
      {
        form: 'Sale',
        action: 'New',
        detail: auditDetail(sale.id, 'New', customer.label, totals),
        invId: sale.id,
      },
      tx,
    );

    return { id: sale.id };
  });
}

export async function updateSale(
  principal: Principal,
  saleId: number,
  input: SaleInput,
): Promise<{ id: number }> {
  const existing = await db
    .selectFrom('sale')
    .select(['id', 'branch_id', 'sale_cust_id'])
    .where('id', '=', saleId)
    .executeTakeFirst();

  if (!existing) throw notFound('Sale');
  assertBranchAccess(principal, existing.branch_id);

  const branchId = resolveBranchId(principal, input.branchId ?? existing.branch_id);

  return withTransaction(async (tx) => {
    const totals = await computeTotals(input, branchId, tx);
    const customer = await resolveCustomer(input.custId, input.walkIn, tx);

    const saleCustId =
      input.custId === WALK_IN_CUSTOMER_ID
        ? await upsertWalkIn(tx, branchId, input.walkIn, existing.sale_cust_id)
        : null;

    await tx
      .updateTable('sale')
      .set({
        date: input.date,
        cust_id: input.custId,
        sale_cust_id: saleCustId,
        branch_id: branchId,
        gross_total: totals.grossTotal,
        sub_total: totals.grossTotal,
        discount: totals.totalDiscount,
        service: totals.service,
        net_total: totals.netTotal,
        received: totals.received,
        remaining: totals.remaining,
        notes: input.notes ?? null,
        updated_at: new Date(),
        updated_by: principal.empId,
      })
      .where('id', '=', saleId)
      .execute();

    // Line items are fully replaced; the ledger is NOT — it is reversed and
    // re-posted so the original entries survive for audit.
    await tx.deleteFrom('sale_detail').where('sale_id', '=', saleId).execute();
    await writeLines(tx, saleId, totals.lines);

    const journals = postSale({
      invId: saleId,
      date: input.date,
      branchId,
      customerAccountId: customer.accountId,
      customerLabel: customer.label,
      grossTotal: totals.grossTotal,
      discount: totals.totalDiscount,
      service: totals.service,
      netTotal: totals.netTotal,
      cogs: totals.cogs,
      received: totals.received,
    });

    // A sale produces up to two vouchers of DIFFERENT types, and reversals are
    // looked up by (vtype, inv_id). Each type must therefore be reposted with
    // only its own journals — passing the whole list to both calls would post
    // the cash receipt twice.
    await repostDocument(
      tx,
      VTYPE.SALE,
      saleId,
      journals.filter((j) => j.vtype === VTYPE.SALE),
    );

    await repostDocument(
      tx,
      VTYPE.CASH_RECEIPT,
      saleId,
      journals.filter((j) => j.vtype === VTYPE.CASH_RECEIPT),
    );

    await writeAudit(
      principal,
      {
        form: 'Sale',
        action: 'Edit',
        detail: auditDetail(saleId, 'Edit', customer.label, totals),
        invId: saleId,
      },
      tx,
    );

    return { id: saleId };
  });
}
