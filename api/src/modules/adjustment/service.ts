/**
 * Stock adjustment — the manual "increase / decrease" document.
 *
 * Super-admin only: a physical count correction for one branch and one stock
 * kind. Each line carries a signed quantity (positive = found, negative =
 * missing). The document posts a single balanced journal at the net value and a
 * signed movement for every line, so the stock report and the ledger agree.
 */
import { db, withTransaction, type Tx } from '../../core/db/index.js';
import { add, dec, money, mul, qty, type MoneyString } from '../../core/money.js';
import { badRequest, forbidden, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { assertBranchAccess, resolveBranchId, type Principal } from '../../core/rbac.js';
import { issueDocumentNumber } from '../../core/numbering.js';
import { postStockAdjustment } from '../../accounting/rules/adjustment.js';
import { postJournal, repostDocument } from '../../accounting/post.js';
import { VTYPE } from '../../accounting/accounts.js';
import { fmt } from '../../accounting/journal.js';

export interface AdjustmentLineInput {
  pid: number;
  /** Signed: positive = increase, negative = decrease. */
  qty: string;
}

export interface AdjustmentInput {
  date: string;
  kind: 'RAW' | 'FINISH';
  branchId: number;
  reason: string;
  note?: string | null | undefined;
  lines: AdjustmentLineInput[];
}

interface PricedLine {
  pid: number;
  pname: string;
  qty: string;
  price: MoneyString;
  total: MoneyString;
}

/** Unit cost at a branch: finished goods carry the branch's wholesale cost. */
async function priceLines(
  tx: Tx,
  kind: 'RAW' | 'FINISH',
  branchId: number,
  lines: AdjustmentLineInput[],
): Promise<{ lines: PricedLine[]; netValue: MoneyString }> {
  if (lines.length === 0) throw badRequest('Add at least one line');

  const ids = [...new Set(lines.map((l) => l.pid))];

  if (kind === 'RAW') {
    const rows = await tx
      .selectFrom('raw_product')
      .select(['id', 'name', 'price'])
      .where('id', 'in', ids)
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) throw badRequest(`Unknown raw item id(s): ${missing.join(', ')}`);

    let netValue = '0.00';
    const priced = lines.map((l) => {
      const p = byId.get(l.pid)!;
      const price = money(p.price);
      return { pid: l.pid, pname: p.name ?? '', qty: l.qty, price, total: mul(l.qty, price) };
    });
    for (const l of priced) netValue = add(netValue, l.total);
    return { lines: priced, netValue };
  }

  const [products, branchProducts] = await Promise.all([
    tx.selectFrom('product').select(['id', 'name', 'price']).where('id', 'in', ids).execute(),
    tx
      .selectFrom('branch_product')
      .select(['product_id', 'wholesale_cost'])
      .where('branch_id', '=', branchId)
      .where('product_id', 'in', ids)
      .execute(),
  ]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const costById = new Map(branchProducts.map((b) => [b.product_id, b.wholesale_cost]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw badRequest(`Unknown product id(s): ${missing.join(', ')}`);

  let netValue = '0.00';
  const priced = lines.map((l) => {
    const p = byId.get(l.pid)!;
    const wholesale = costById.get(l.pid);
    // Branch cost is wholesale when known; otherwise the company cost.
    const price = money(wholesale && Number(wholesale) > 0 ? wholesale : p.price);
    return { pid: l.pid, pname: p.name ?? '', qty: l.qty, price, total: mul(l.qty, price) };
  });
  for (const l of priced) netValue = add(netValue, l.total);
  return { lines: priced, netValue };
}

export async function createAdjustment(
  principal: Principal,
  input: AdjustmentInput,
): Promise<{ id: number }> {
  if (!principal.isSuperAdmin) {
    throw forbidden('Only the super admin can adjust stock');
  }

  const branchId = resolveBranchId(principal, input.branchId);
  assertBranchAccess(principal, branchId);

  for (const l of input.lines) {
    if (dec(l.qty).eq(0)) throw badRequest(`Item ${l.pid}: quantity cannot be zero`);
  }

  return withTransaction((tx) => createAdjustmentInTx(tx, principal, input, branchId));
}

export async function createAdjustmentInTx(
  tx: Tx,
  principal: Principal,
  input: AdjustmentInput,
  branchId: number,
): Promise<{ id: number }> {
  const { lines, netValue } = await priceLines(tx, input.kind, branchId, input.lines);

  const { docNumber } = await issueDocumentNumber(tx, branchId, 'ADJUSTMENT');

  const adj = await tx
    .insertInto('stock_adjustment')
    .values({
      doc_number: docNumber,
      branch_id: branchId,
      date: input.date,
      kind: input.kind,
      reason: input.reason,
      note: input.note ?? null,
      created_by: principal.empId,
      updated_by: principal.empId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await tx
    .insertInto('stock_adjustment_detail')
    .values(
      lines.map((l) => ({
        adj_id: adj.id,
        pid: l.pid,
        pname: l.pname,
        qty: qty(l.qty),
        price: l.price,
        total: l.total,
      })),
    )
    .execute();

  const journal = postStockAdjustment({
    invId: adj.id,
    date: input.date,
    branchId,
    kind: input.kind,
    value: netValue,
  });
  if (journal) await postJournal(tx, journal);

  await writeAudit(
    principal,
    {
      form: 'Stock Adjustment',
      action: 'New',
      detail:
        `${docNumber} | Adjusted ${input.kind} stock | ` +
        `Value ${fmt(netValue)} | ${input.reason}`,
      invId: adj.id,
    },
    tx,
  );

  return { id: adj.id };
}

export async function listAdjustments(
  principal: Principal,
  opts: { kind?: string | undefined; page: number; pageSize: number },
) {
  let base = db.selectFrom('stock_adjustment');

  if (!principal.isSuperAdmin) {
    base = base.where('branch_id', '=', principal.branchId);
  }
  if (opts.kind) base = base.where('kind', '=', opts.kind);

  const offset = (opts.page - 1) * opts.pageSize;
  const [rows, count] = await Promise.all([
    base
      .select(['id', 'doc_number', 'date', 'branch_id', 'kind', 'reason', 'note'])
      .orderBy('date', 'desc')
      .orderBy('id', 'desc')
      .limit(opts.pageSize)
      .offset(offset)
      .execute(),
    base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
  ]);

  return { rows, total: Number(count.n), page: opts.page, pageSize: opts.pageSize };
}

export async function reverseAdjustment(principal: Principal, id: number): Promise<{ id: number }> {
  const existing = await db
    .selectFrom('stock_adjustment')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!existing) throw notFound('Stock adjustment');
  assertBranchAccess(principal, existing.branch_id);

  return withTransaction(async (tx) => {
    // Reversing posts the mirror journal and leaves the original row intact.
    await repostDocument(tx, VTYPE.STOCK_ADJUSTMENT, id, []);

    await writeAudit(
      principal,
      {
        form: 'Stock Adjustment',
        action: 'Delete',
        detail: `Reversed adjustment ${existing.doc_number}`,
        invId: id,
      },
      tx,
    );

    return { id };
  });
}
