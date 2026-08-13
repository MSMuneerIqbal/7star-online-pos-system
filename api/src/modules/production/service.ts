/**
 * Production service (Phase 4 — reshape).
 *
 * The old single-table production is gone. Production is now the flow the
 * business actually runs: a cart of raw parts is issued to a named worker
 * (work in progress), and comes back as ready batteries plus damage.
 *
 *   ISSUE   production_issue       parts leave raw stock into WIP (no ledger)
 *   OUTPUT  production_output      ready batteries; ledger Dr finished / Cr raw
 *           used_stock             parts consumed
 *           damaged_stock          parts spoiled (no ledger, absorbed into ready)
 *
 * Damaged material is absorbed into the surviving batteries (per_unit = total
 * material ÷ ready count), so the voucher always balances with no damage leg.
 */
import { db, withTransaction, type Tx } from '../../core/db/index.js';
import { add, dec, money, mul, qty, type MoneyString } from '../../core/money.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { assertBranchAccess, resolveBranchId, type Principal } from '../../core/rbac.js';
import { issueDocumentNumber } from '../../core/numbering.js';
import { postProduction } from '../../accounting/rules/production.js';
import { postJournal } from '../../accounting/post.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IssueLineInput {
  pid: number;
  qty: string;
}

export interface IssueInput {
  date: string;
  workerId: number;
  branchId?: number | undefined;
  note?: string | null | undefined;
  lines: IssueLineInput[];
}

export interface DamagedLineInput {
  pid: number;
  qty: string;
  reason?: string | null | undefined;
}

export interface OutputInput {
  issueId: number;
  date: string;
  productId: number;
  /** Ready batteries. At least one — a fully-damaged cart records damage only. */
  qty: string;
  damaged?: DamagedLineInput[] | undefined;
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export async function createIssue(
  principal: Principal,
  input: IssueInput,
): Promise<{ id: number; docNumber: string }> {
  if (input.lines.length === 0) throw badRequest('Add at least one part to the cart');

  const branchId = resolveBranchId(principal, input.branchId);
  assertBranchAccess(principal, branchId);

  const worker = await db
    .selectFrom('worker')
    .select(['id', 'name'])
    .where('id', '=', input.workerId)
    .where('is_active', '=', true)
    .executeTakeFirst();
  if (!worker) throw badRequest(`Unknown or inactive worker id ${input.workerId}`);

  const ids = [...new Set(input.lines.map((l) => l.pid))];
  const raws = await db.selectFrom('raw_product').select(['id', 'name', 'price']).where('id', 'in', ids).execute();
  const byId = new Map(raws.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw badRequest(`Unknown raw item id(s): ${missing.join(', ')}`);

  return withTransaction(async (tx) => {
    const { docNumber } = await issueDocumentNumber(tx, branchId, 'PRODUCTION');

    const issue = await tx
      .insertInto('production_issue')
      .values({
        doc_number: docNumber,
        date: input.date,
        worker_id: input.workerId,
        branch_id: branchId,
        note: input.note ?? null,
        status: 'OPEN',
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const lines = input.lines.map((l) => {
      const raw = byId.get(l.pid)!;
      const total = mul(l.qty, raw.price);
      return {
        issue_id: issue.id,
        pid: l.pid,
        pname: raw.name ?? '',
        qty: qty(l.qty),
        price: money(raw.price),
        total: money(total),
        status: 'ISSUED',
      };
    });

    await tx.insertInto('production_issue_detail').values(lines).execute();

    await writeAudit(
      principal,
      {
        form: 'Production',
        action: 'New',
        detail: `Issue ${docNumber}: issued ${input.lines.length} part line(s) to ${worker.name}`,
        invId: issue.id,
      },
      tx,
    );

    return { id: issue.id, docNumber };
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export async function recordOutput(
  principal: Principal,
  input: OutputInput,
): Promise<{ id: number; perUnit: MoneyString; totalCost: MoneyString }> {
  const issue = await db
    .selectFrom('production_issue')
    .selectAll()
    .where('id', '=', input.issueId)
    .executeTakeFirst();
  if (!issue) throw notFound('Production issue');
  assertBranchAccess(principal, issue.branch_id);

  if (issue.status !== 'OPEN') throw conflict('This issue is already closed');

  const detail = await db
    .selectFrom('production_issue_detail')
    .selectAll()
    .where('issue_id', '=', input.issueId)
    .execute();
  if (detail.length === 0) throw badRequest('This issue has no parts');

  const readyQty = dec(input.qty);
  if (readyQty.lte(0)) throw badRequest('Record at least one ready battery');

  const product = await db
    .selectFrom('product')
    .select(['id', 'name'])
    .where('id', '=', input.productId)
    .executeTakeFirst();
  if (!product) throw badRequest(`Unknown product id ${input.productId}`);

  // Total material issued — the batteries absorb all of it, damage included.
  const totalMaterial = detail.reduce((acc, l) => add(acc, l.total), '0.00');
  const perUnit = money(dec(totalMaterial).div(readyQty));

  // Damaged parts: each must be in the cart, and no more than was issued.
  const damaged = input.damaged ?? [];
  const damagedByPid = new Map<number, number>();
  for (const d of damaged) {
    const line = detail.find((l) => l.pid === d.pid);
    if (!line) throw badRequest(`Part ${d.pid} was not in this cart`);
    const dq = dec(d.qty);
    if (dq.lte(0)) throw badRequest('Damaged quantity must be greater than zero');
    const already = damagedByPid.get(d.pid) ?? 0;
    const totalDamaged = dq.add(already);
    if (totalDamaged.gt(dec(line.qty))) {
      throw badRequest(`Damaged ${totalDamaged} of part ${d.pid} is more than the ${line.qty} issued`);
    }
    damagedByPid.set(d.pid, totalDamaged.toNumber());
  }

  return withTransaction(async (tx) => {
    const output = await tx
      .insertInto('production_output')
      .values({
        date: input.date,
        issue_id: input.issueId,
        worker_id: issue.worker_id,
        product_id: input.productId,
        branch_id: issue.branch_id,
        qty: qty(input.qty),
        per_unit: perUnit,
        total_cost: money(totalMaterial),
        grade: 'NEW',
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Used parts: the cart minus what was damaged.
    for (const line of detail) {
      const damagedQty = damagedByPid.get(line.pid) ?? 0;
      const usedQty = dec(line.qty).minus(damagedQty);

      if (usedQty.gt(0)) {
        await tx
          .insertInto('used_stock')
          .values({
            issue_id: input.issueId,
            output_id: output.id,
            pid: line.pid,
            pname: line.pname,
            qty: qty(usedQty),
            price: line.price,
            total: money(usedQty.mul(dec(line.price))),
          })
          .execute();
      }

      await tx
        .updateTable('production_issue_detail')
        .set({ status: damagedQty > 0 ? 'DAMAGED' : 'USED' })
        .where('id', '=', line.id)
        .execute();
    }

    // Damaged parts — a record, never a ledger entry.
    for (const d of damaged) {
      const line = detail.find((l) => l.pid === d.pid)!;
      await tx
        .insertInto('damaged_stock')
        .values({
          date: input.date,
          worker_id: issue.worker_id,
          branch_id: issue.branch_id,
          issue_id: input.issueId,
          kind: 'PART',
          pid: d.pid,
          pname: line.pname,
          qty: qty(d.qty),
          value: money(mul(d.qty, line.price)),
          reason: d.reason ?? null,
          status: 'DAMAGED',
          created_by: principal.empId,
          updated_by: principal.empId,
        })
        .execute();
    }

    await tx
      .updateTable('production_issue')
      .set({ status: 'CLOSED', updated_at: new Date(), updated_by: principal.empId })
      .where('id', '=', input.issueId)
      .execute();

    await postJournal(
      tx,
      postProduction({
        invId: output.id,
        date: input.date,
        branchId: issue.branch_id,
        productName: product.name ?? '',
        materialCost: totalMaterial,
      }),
    );

    // The finished battery's company cost is its absorbed material cost —
    // warehouse-only, never shown to a branch.
    await tx
      .updateTable('product')
      .set({ price: perUnit, updated_at: new Date() })
      .where('id', '=', input.productId)
      .execute();

    await writeAudit(
      principal,
      {
        form: 'Production',
        action: 'Edit',
        detail:
          `Output #${output.id}: ${input.qty} x ${product.name} ready @ ${perUnit} ` +
          `(material ${totalMaterial}), ${damaged.length} damaged part line(s)`,
        invId: output.id,
      },
      tx,
    );

    return { id: output.id, perUnit, totalCost: money(totalMaterial) };
  });
}

// ---------------------------------------------------------------------------
// Damage and rework — records, no ledger
// ---------------------------------------------------------------------------

export async function damageBattery(
  principal: Principal,
  input: {
    date: string;
    productId: number;
    qty: string;
    workerId?: number | null | undefined;
    reason?: string | null | undefined;
    branchId?: number | undefined;
  },
): Promise<{ id: number }> {
  const branchId = resolveBranchId(principal, input.branchId);
  assertBranchAccess(principal, branchId);

  const product = await db
    .selectFrom('product')
    .select(['id', 'name', 'price'])
    .where('id', '=', input.productId)
    .executeTakeFirst();
  if (!product) throw badRequest(`Unknown product id ${input.productId}`);

  if (dec(input.qty).lte(0)) throw badRequest('Damaged quantity must be greater than zero');

  return withTransaction(async (tx) => {
    const row = await tx
      .insertInto('damaged_stock')
      .values({
        date: input.date,
        worker_id: input.workerId ?? null,
        branch_id: branchId,
        kind: 'BATTERY',
        product_id: input.productId,
        pname: product.name ?? '',
        qty: qty(input.qty),
        value: money(mul(input.qty, product.price)),
        reason: input.reason ?? null,
        status: 'DAMAGED',
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await writeAudit(
      principal,
      {
        form: 'Production',
        action: 'Edit',
        detail: `Damaged ${input.qty} x ${product.name} (battery)`,
        invId: row.id,
      },
      tx,
    );

    return { id: row.id };
  });
}

export async function reworkBattery(
  principal: Principal,
  input: {
    date: string;
    productId: number;
    workerId: number;
    qty: string;
    note?: string | null | undefined;
  },
): Promise<{ id: number }> {
  const product = await db
    .selectFrom('product')
    .select(['id', 'name'])
    .where('id', '=', input.productId)
    .executeTakeFirst();
  if (!product) throw badRequest(`Unknown product id ${input.productId}`);

  const worker = await db
    .selectFrom('worker')
    .select('id')
    .where('id', '=', input.workerId)
    .executeTakeFirst();
  if (!worker) throw badRequest(`Unknown worker id ${input.workerId}`);

  if (dec(input.qty).lte(0)) throw badRequest('Rework quantity must be greater than zero');

  return withTransaction(async (tx) => {
    const row = await tx
      .insertInto('rework')
      .values({
        date: input.date,
        product_id: input.productId,
        worker_id: input.workerId,
        qty: qty(input.qty),
        note: input.note ?? null,
        status: 'OPEN',
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await writeAudit(
      principal,
      {
        form: 'Production',
        action: 'Edit',
        detail: `Rework ${input.qty} x ${product.name} -> worker ${input.workerId}`,
        invId: row.id,
      },
      tx,
    );

    return { id: row.id };
  });
}
