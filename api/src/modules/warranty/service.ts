/**
 * Warranty (Phase 9). The customer never waits — the branch replaces first and
 * claims after. The warehouse assesses each claimed unit and carries the cost as
 * a warranty expense; the branch is never charged and its dues do not move.
 */
import { db, withTransaction } from '../../core/db/index.js';
import { add, dec, money, mul, qty } from '../../core/money.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { assertBranchAccess, type Principal } from '../../core/rbac.js';
import { issueDocumentNumber } from '../../core/numbering.js';
import { ACC, VTYPE } from '../../accounting/accounts.js';
import { buildJournal, credit, debit } from '../../accounting/journal.js';
import { postJournal } from '../../accounting/post.js';
import { fmt } from '../../accounting/journal.js';

export interface ClaimLine {
  productId: number;
  qty: string;
}

export async function createClaim(
  principal: Principal,
  input: { date: string; branchId: number; note?: string | null | undefined; lines: ClaimLine[] },
): Promise<{ id: number; docNumber: string }> {
  if (input.lines.length === 0) throw badRequest('Add at least one claimed unit');
  assertBranchAccess(principal, input.branchId);

  return withTransaction(async (tx) => {
    const { docNumber } = await issueDocumentNumber(tx, input.branchId, 'WARRANTY');

    const claim = await tx
      .insertInto('warranty_claim')
      .values({
        doc_number: docNumber,
        branch_id: input.branchId,
        date: input.date,
        status: 'RAISED',
        note: input.note ?? null,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('warranty_claim_detail')
      .values(input.lines.map((l) => ({ claim_id: claim.id, product_id: l.productId, qty: qty(l.qty) })))
      .execute();

    await writeAudit(
      principal,
      { form: 'Warranty', action: 'New', detail: `${docNumber} | Claim raised for ${input.lines.length} line(s)`, invId: claim.id },
      tx,
    );

    return { id: claim.id, docNumber };
  });
}

export interface ResolutionLine {
  productId: number;
  qty: string;
  assessment: 'REPAIRABLE' | 'NOT_REPAIRABLE';
  /** Raw parts consumed, when repairable. */
  parts?: Array<{ pid: number; qty: string }> | undefined;
}

export async function resolveClaim(
  principal: Principal,
  input: { claimId: number; date: string; warehouseBranchId: number; lines: ResolutionLine[] },
): Promise<{ id: number }> {
  const claim = await db
    .selectFrom('warranty_claim')
    .selectAll()
    .where('id', '=', input.claimId)
    .executeTakeFirst();
  if (!claim) throw notFound('Warranty claim');
  assertBranchAccess(principal, input.warehouseBranchId);

  if (claim.status === 'CLOSED') throw conflict('This claim is already closed');

  return withTransaction(async (tx) => {
    for (const line of input.lines) {
      const product = await tx
        .selectFrom('product')
        .select(['id', 'name', 'price'])
        .where('id', '=', line.productId)
        .executeTakeFirst();
      if (!product) throw badRequest(`Unknown product id ${line.productId}`);

      if (line.assessment === 'REPAIRABLE') {
        // Repaired with raw parts — the same unit returns, graded Repaired.
        let partsCost = '0.00';
        for (const p of line.parts ?? []) {
          const raw = await tx
            .selectFrom('raw_product')
            .select(['id', 'name', 'price'])
            .where('id', '=', p.pid)
            .executeTakeFirst();
          if (!raw) throw badRequest(`Unknown raw item id ${p.pid}`);

          const total = mul(p.qty, raw.price);
          partsCost = add(partsCost, total);

          await tx
            .insertInto('warranty_part')
            .values({ claim_id: claim.id, pid: p.pid, pname: raw.name ?? '', qty: qty(p.qty), price: money(raw.price), total: money(total) })
            .execute();
        }

        await postJournal(
          tx,
          buildJournal({
            vtype: VTYPE.PURCHASE,
            date: input.date,
            invId: claim.id,
            branchId: input.warehouseBranchId,
            legs: [
              debit(ACC.WARRANTY_EXPENSE, money(partsCost), `Warranty repair – ${product.name}`),
              credit(ACC.INVENTORY_RAW, money(partsCost), `Parts used – warranty repair`),
            ],
          }),
        );

        await tx
          .updateTable('warranty_claim_detail')
          .set({ assessment: 'REPAIRABLE', outcome: 'RETURNED_REPAIRED', grade: 'REPAIRED' })
          .where('claim_id', '=', claim.id)
          .where('product_id', '=', line.productId)
          .execute();
      } else {
        // A new battery from ready stock — graded New.
        const cost = mul(line.qty, product.price);

        await postJournal(
          tx,
          buildJournal({
            vtype: VTYPE.PURCHASE,
            date: input.date,
            invId: claim.id,
            branchId: input.warehouseBranchId,
            legs: [
              debit(ACC.WARRANTY_EXPENSE, money(cost), `Warranty replacement – ${product.name}`),
              credit(ACC.INVENTORY_FINISH, money(cost), `Replacement issued from ready stock`),
            ],
          }),
        );

        await tx
          .updateTable('warranty_claim_detail')
          .set({ assessment: 'NOT_REPAIRABLE', outcome: 'REPLACED_NEW', grade: 'NEW' })
          .where('claim_id', '=', claim.id)
          .where('product_id', '=', line.productId)
          .execute();
      }
    }

    await tx
      .updateTable('warranty_claim')
      .set({ status: 'CLOSED', warehouse_branch_id: input.warehouseBranchId, updated_at: new Date(), updated_by: principal.empId })
      .where('id', '=', claim.id)
      .execute();

    await writeAudit(
      principal,
      { form: 'Warranty', action: 'Approve', detail: `${claim.doc_number} | Assessed and resolved`, invId: claim.id },
      tx,
    );

    return { id: claim.id };
  });
}
