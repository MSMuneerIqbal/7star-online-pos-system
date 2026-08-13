/**
 * Remittance — a branch sends cash or bank to the warehouse.
 *
 * The branch records the remittance (PENDING); the warehouse confirms it. On
 * confirmation both sides post — the branch's "due to warehouse" falls and its
 * cash falls; the warehouse's cash rises and its "due from branches" falls.
 * Moving money inside one company creates no revenue; the two sides cancel.
 */
import { db, withTransaction } from '../../core/db/index.js';
import { sql } from 'kysely';
import { dec, money } from '../../core/money.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { assertBranchAccess, type Principal } from '../../core/rbac.js';
import { issueDocumentNumber } from '../../core/numbering.js';
import { ACC } from '../../accounting/accounts.js';
import { postRemittance } from '../../accounting/rules/transfer.js';
import { postJournal } from '../../accounting/post.js';
import { fmt } from '../../accounting/journal.js';

export interface RemittanceInput {
  date: string;
  amount: string;
  method: 'CASH' | 'BANK';
  note?: string | null | undefined;
  /** The branch that is paying. A branch admin can only pay for itself. */
  fromBranchId?: number | undefined;
  /** The warehouse. Defaults to the WAREHOUSE branch. */
  toBranchId?: number | undefined;
}

async function warehouseBranchId(): Promise<number> {
  const w = await db
    .selectFrom('branch')
    .select('id')
    .where('type', '=', 'WAREHOUSE')
    .executeTakeFirst();
  if (!w) throw badRequest('No warehouse branch is configured');
  return w.id;
}

export async function createRemittance(
  principal: Principal,
  input: RemittanceInput,
): Promise<{ id: number; docNumber: string }> {
  const amount = dec(input.amount);
  if (amount.lte(0)) throw badRequest('Remittance amount must be greater than zero');

  const toBranchId = input.toBranchId ?? (await warehouseBranchId());
  const fromBranchId = principal.isSuperAdmin ? (input.fromBranchId ?? 0) : principal.branchId;

  if (fromBranchId === 0) {
    throw badRequest('Select the branch that is remitting');
  }
  if (fromBranchId === toBranchId) {
    throw badRequest('A branch cannot remit to itself');
  }
  assertBranchAccess(principal, fromBranchId);

  const branch = await db
    .selectFrom('branch')
    .select(['id', 'name'])
    .where('id', '=', fromBranchId)
    .executeTakeFirst();
  if (!branch) throw badRequest(`Unknown branch id ${fromBranchId}`);

  return withTransaction(async (tx) => {
    const { docNumber } = await issueDocumentNumber(tx, fromBranchId, 'REMITTANCE');

    const row = await tx
      .insertInto('remittance')
      .values({
        doc_number: docNumber,
        date: input.date,
        from_branch: fromBranchId,
        to_branch: toBranchId,
        amount: money(amount),
        method: input.method,
        note: input.note ?? null,
        status: 'PENDING',
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await writeAudit(
      principal,
      {
        form: 'Remittance',
        action: 'New',
        detail: `${docNumber} | ${branch.name} remitted ${fmt(money(amount))} by ${input.method}`,
        invId: row.id,
      },
      tx,
    );

    return { id: row.id, docNumber };
  });
}

export async function confirmRemittance(
  principal: Principal,
  id: number,
): Promise<{ id: number }> {
  const rem = await db.selectFrom('remittance').selectAll().where('id', '=', id).executeTakeFirst();
  if (!rem) throw notFound('Remittance');
  assertBranchAccess(principal, rem.to_branch);

  if (rem.status === 'CONFIRMED') throw conflict('This remittance is already confirmed');

  const branch = await db
    .selectFrom('branch')
    .select(['id', 'name', 'inter_branch_account'])
    .where('id', '=', rem.from_branch)
    .executeTakeFirst();
  if (!branch?.inter_branch_account) {
    throw badRequest('This branch has no inter-branch account');
  }

  return withTransaction(async (tx) => {
    for (const j of postRemittance({
      invId: rem.id,
      date: rem.date,
      branchId: rem.from_branch,
      warehouseBranchId: rem.to_branch,
      branchAccountId: branch.inter_branch_account!,
      warehouseAccountId: ACC.INTER_BRANCH_DUE,
      amount: rem.amount,
      method: (rem.method as 'CASH' | 'BANK') ?? 'CASH',
    })) {
      await postJournal(tx, j);
    }

    await tx
      .updateTable('remittance')
      .set({ status: 'CONFIRMED', confirmed_at: new Date(), updated_at: new Date(), updated_by: principal.empId })
      .where('id', '=', id)
      .execute();

    await writeAudit(
      principal,
      {
        form: 'Remittance',
        action: 'Approve',
        detail: `${rem.doc_number} | Confirmed ${fmt(rem.amount)} from ${branch.name}`,
        invId: id,
      },
      tx,
    );

    return { id };
  });
}

/**
 * The branch dues report (SPECS §7): what each branch received at wholesale,
 * what it has remitted, what is in transit, and what it still owes.
 */
export async function branchDues(): Promise<
  Array<{
    branchId: number;
    branchName: string;
    received: string;
    remitted: string;
    inTransit: string;
    stillOwed: string;
  }>
> {
  const branches = await db
    .selectFrom('branch')
    .select(['id', 'name'])
    .where('id', '>', 0)
    .where('type', '<>', 'WAREHOUSE')
    .orderBy('name')
    .execute();

  const receivedRows = await sql<{ branch_id: number; v: string }>`
    SELECT r.to_branch AS branch_id, COALESCE(SUM(d.received_qty * d.price), 0)::text AS v
    FROM   do_received_detail d
    JOIN   do_received r ON r.id = d.inv_id
    GROUP  BY r.to_branch
  `.execute(db);

  const remittedRows = await sql<{ branch_id: number; v: string }>`
    SELECT from_branch AS branch_id, COALESCE(SUM(amount), 0)::text AS v
    FROM   remittance
    WHERE  status = 'CONFIRMED'
    GROUP  BY from_branch
  `.execute(db);

  const transitRows = await sql<{ branch_id: number; v: string }>`
    SELECT r.to_branch AS branch_id, COALESCE(SUM(d.wholesale_price * d.qty), 0)::text AS v
    FROM   do_request_detail d
    JOIN   do_request r ON r.id = d.inv_id
    WHERE  r.status = 'DESPATCHED'
    GROUP  BY r.to_branch
  `.execute(db);

  const received = new Map(receivedRows.rows.map((r) => [r.branch_id, r.v ?? '0']));
  const remitted = new Map(remittedRows.rows.map((r) => [r.branch_id, r.v ?? '0']));
  const transit = new Map(transitRows.rows.map((r) => [r.branch_id, r.v ?? '0']));

  return branches.map((b) => {
    const rec = dec(received.get(b.id) ?? '0');
    const rem = dec(remitted.get(b.id) ?? '0');
    return {
      branchId: b.id,
      branchName: b.name,
      received: money(rec),
      remitted: money(rem),
      inTransit: money(dec(transit.get(b.id) ?? '0')),
      stillOwed: money(rec.minus(rem)),
    };
  });
}
