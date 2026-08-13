/**
 * Lab — battery repair and servicing.
 *
 * DESIGNED, NOT PORTED. `LabController` was a stub: Index and Create only, no
 * Save action, so the Lab Invoice form had nothing to post to. The workflow
 * below is inferred from what the legacy code implies rather than from a spec:
 *
 *   - `LabReceivedController` is complete and has `Work`, `MakeInvoice` and
 *     `MakeInvoicePWise` actions, so intake and invoicing were meant to be
 *     separate steps with the invoice generated FROM the intake.
 *   - the `lab_used` table records raw materials consumed against a lab job.
 *   - `lab` / `lab_detail` are the invoice tables.
 *
 * So: a customer brings batteries in, a technician works on them consuming
 * materials, and the completed job is invoiced.
 *
 *   INTAKE     lab_received   items accepted for repair. No ledger impact —
 *                             the goods belong to the customer, not the business.
 *   WORK       lab_used       materials consumed. Posts material out of stock.
 *   INVOICE    lab            bill the customer. Posts service revenue.
 *
 * ACCOUNTING NOTE: lab work is a SERVICE, so revenue goes to Service Income
 * (4010102), not Sales (4010101). The customer's own battery is never the
 * business's inventory, so there is no COGS on the battery itself — only on the
 * materials consumed repairing it.
 *
 * If the real workflow differs, the shape to change is here; the posting rules
 * are in accounting/rules/lab.ts.
 */
import { db, withTransaction, type Tx } from '../../core/db/index.js';
import { add, gt, money, mul, type MoneyString } from '../../core/money.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { issueDocumentNumber } from '../../core/numbering.js';
import { writeAudit } from '../../core/audit.js';
import { assertBranchAccess, resolveBranchId, type Principal } from '../../core/rbac.js';
import { postLabInvoice, postLabMaterials } from '../../accounting/rules/lab.js';
import { postJournal, postJournals } from '../../accounting/post.js';
import { fmt } from '../../accounting/journal.js';

export const LAB_STATUS = {
  RECEIVED: 'RECEIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  READY: 'READY',
  INVOICED: 'INVOICED',
} as const;

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

export interface IntakeInput {
  date: string;
  custId: number;
  branchId?: number | undefined;
  note?: string | null | undefined;
  /** Items the customer has left for repair. */
  lines: Array<{
    pname: string;
    qty: string;
    /** Quoted repair charge, if agreed up front. */
    price?: string | undefined;
    detail?: string | null | undefined;
    ready?: string | null | undefined;
  }>;
}

export async function createIntake(
  principal: Principal,
  input: IntakeInput,
): Promise<{ id: number }> {
  if (input.lines.length === 0) throw badRequest('Record at least one item received');

  const branchId = resolveBranchId(principal, input.branchId);
  assertBranchAccess(principal, branchId);

  return withTransaction(async (tx) => {
    const customer = await tx
      .selectFrom('customer')
      .select(['id', 'name'])
      .where('id', '=', input.custId)
      .executeTakeFirst();

    if (!customer) throw badRequest(`Unknown customer id ${input.custId}`);

    let gross = '0.00';
    const lines = input.lines.map((l) => {
      const price = money(l.price ?? '0');
      const total = mul(l.qty, price);
      gross = add(gross, total);

      return {
        pid: 0, // customer's own goods — not a catalog item
        pname: l.pname,
        qty: l.qty,
        price,
        total,
        status: LAB_STATUS.RECEIVED,
        detail: l.detail ?? null,
        ready: l.ready ?? null,
      };
    });

    const { docNumber } = await issueDocumentNumber(tx, branchId, 'LAB_RECEIVED');

    const intake = await tx
      .insertInto('lab_received')
      .values({
        date: input.date,
        doc_number: docNumber,
        cust_id: input.custId,
        branch_id: branchId,
        note: input.note ?? null,
        status: LAB_STATUS.RECEIVED,
        gross,
        other: '0',
        net: gross,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('lab_received_detail')
      .values(lines.map((l) => ({ ...l, inv_id: intake.id })))
      .execute();

    // No ledger entry: the batteries belong to the customer. Accepting them
    // creates a custody obligation, not an asset.
    await writeAudit(
      principal,
      {
        form: 'Lab Receiving',
        action: 'New',
        detail:
          `Lab:${intake.id} | Received ${lines.length} item(s) from ${customer.name} | ` +
          `Quoted ${fmt(gross)}`,
        invId: intake.id,
      },
      tx,
    );

    return { id: intake.id };
  });
}

// ---------------------------------------------------------------------------
// Work — consume materials against a job
// ---------------------------------------------------------------------------

export interface ConsumeInput {
  labReceivedId: number;
  date: string;
  lines: Array<{ pid: number; qty: string }>;
}

export async function consumeMaterials(
  principal: Principal,
  input: ConsumeInput,
): Promise<{ id: number; materialCost: MoneyString }> {
  if (input.lines.length === 0) throw badRequest('Add at least one material');

  const intake = await db
    .selectFrom('lab_received')
    .selectAll()
    .where('id', '=', input.labReceivedId)
    .executeTakeFirst();

  if (!intake) throw notFound('Lab job');
  assertBranchAccess(principal, intake.branch_id);

  if (intake.status === LAB_STATUS.INVOICED) {
    throw conflict('This job has already been invoiced');
  }

  return withTransaction(async (tx) => {
    const ids = [...new Set(input.lines.map((l) => l.pid))];

    const raws = await tx
      .selectFrom('raw_product')
      .select(['id', 'name', 'price'])
      .where('id', 'in', ids)
      .execute();

    const byId = new Map(raws.map((r) => [r.id, r]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) throw badRequest(`Unknown raw item id(s): ${missing.join(', ')}`);

    let materialCost = '0.00';

    for (const line of input.lines) {
      if (!gt(line.qty, '0.000')) throw badRequest('Quantity must be greater than zero');

      const raw = byId.get(line.pid)!;
      const total = mul(line.qty, raw.price);
      materialCost = add(materialCost, total);

      await tx
        .insertInto('lab_used')
        .values({
          inv_id: input.labReceivedId,
          bid: intake.branch_id,
          pid: line.pid,
          pname: raw.name ?? '',
          date: input.date,
          price: money(raw.price),
          qty: line.qty,
          total,
        })
        .execute();
    }

    // Materials leave stock and become work-in-progress cost.
    await postJournal(
      tx,
      postLabMaterials({
        invId: input.labReceivedId,
        date: input.date,
        branchId: intake.branch_id,
        materialCost,
      }),
    );

    await tx
      .updateTable('lab_received')
      .set({ status: LAB_STATUS.IN_PROGRESS, updated_at: new Date() })
      .where('id', '=', input.labReceivedId)
      .execute();

    await writeAudit(
      principal,
      {
        form: 'Lab Receiving',
        action: 'Edit',
        detail: `Lab:${input.labReceivedId} | Consumed materials costing ${fmt(materialCost)}`,
        invId: input.labReceivedId,
      },
      tx,
    );

    return { id: input.labReceivedId, materialCost };
  });
}

// ---------------------------------------------------------------------------
// Invoice — bill the completed job
// ---------------------------------------------------------------------------

export interface LabInvoiceInput {
  labReceivedId: number;
  date: string;
  /** Repair charges per item. Defaults to what was quoted at intake. */
  lines?: Array<{ pname: string; qty: string; price: string }> | undefined;
  received: string;
}

export async function createLabInvoice(
  principal: Principal,
  input: LabInvoiceInput,
): Promise<{ id: number; net: MoneyString }> {
  const intake = await db
    .selectFrom('lab_received')
    .selectAll()
    .where('id', '=', input.labReceivedId)
    .executeTakeFirst();

  if (!intake) throw notFound('Lab job');
  assertBranchAccess(principal, intake.branch_id);

  if (intake.status === LAB_STATUS.INVOICED) {
    throw conflict('This job has already been invoiced');
  }

  return withTransaction(async (tx) => {
    const customer = await tx
      .selectFrom('customer')
      .select(['id', 'name', 'account_id'])
      .where('id', '=', intake.cust_id)
      .executeTakeFirstOrThrow();

    if (!customer.account_id) {
      throw conflict(
        `Customer "${customer.name}" has no chart-of-accounts code, so the job cannot be invoiced`,
      );
    }

    // Default to the charges agreed at intake.
    const source =
      input.lines ??
      (
        await tx
          .selectFrom('lab_received_detail')
          .select(['pname', 'qty', 'price'])
          .where('inv_id', '=', input.labReceivedId)
          .execute()
      ).map((l) => ({ pname: l.pname ?? '', qty: l.qty, price: l.price }));

    if (source.length === 0) throw badRequest('Nothing to invoice');

    let gross = '0.00';
    const lines = source.map((l) => {
      const total = mul(l.qty, l.price);
      gross = add(gross, total);
      return { pname: l.pname, qty: l.qty, price: money(l.price), total };
    });

    const received = money(input.received);
    if (gt(received, gross)) {
      throw conflict(`Received ${fmt(received)} is more than the invoice total ${fmt(gross)}`);
    }

    const { docNumber } = await issueDocumentNumber(tx, intake.branch_id, 'LAB');

    const invoice = await tx
      .insertInto('lab')
      .values({
        date: input.date,
        doc_number: docNumber,
        lab_id: input.labReceivedId,
        branch_id: intake.branch_id,
        cust_id: intake.cust_id,
        gross,
        received,
        remaining: add(gross, `-${received}`),
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('lab_detail')
      .values(
        lines.map((l) => ({
          inv_id: invoice.id,
          pid: 0,
          pname: l.pname,
          price: l.price,
          qty: l.qty,
          total: l.total,
        })),
      )
      .execute();

    // Two vouchers when cash is taken: the invoice and its receipt.
    await postJournals(
      tx,
      postLabInvoice({
        invId: invoice.id,
        date: input.date,
        branchId: intake.branch_id,
        customerAccountId: customer.account_id,
        customerLabel: `Customer: ${customer.name ?? ''}`,
        serviceCharge: gross,
        received,
      }),
    );

    await tx
      .updateTable('lab_received')
      .set({ status: LAB_STATUS.INVOICED, updated_at: new Date() })
      .where('id', '=', input.labReceivedId)
      .execute();

    await writeAudit(
      principal,
      {
        form: 'Lab Invoices',
        action: 'New',
        detail:
          `LabInv:${invoice.id} | Invoiced job ${input.labReceivedId} for ${customer.name} | ` +
          `Charges ${fmt(gross)}, Received ${fmt(received)}`,
        invId: invoice.id,
      },
      tx,
    );

    return { id: invoice.id, net: gross };
  });
}

/** Mark a job ready for collection. No ledger impact. */
export async function markReady(principal: Principal, labReceivedId: number): Promise<void> {
  const intake = await db
    .selectFrom('lab_received')
    .select(['id', 'branch_id', 'status'])
    .where('id', '=', labReceivedId)
    .executeTakeFirst();

  if (!intake) throw notFound('Lab job');
  assertBranchAccess(principal, intake.branch_id);

  if (intake.status === LAB_STATUS.INVOICED) {
    throw conflict('This job has already been invoiced');
  }

  await withTransaction(async (tx) => {
    await tx
      .updateTable('lab_received')
      .set({ status: LAB_STATUS.READY, updated_at: new Date() })
      .where('id', '=', labReceivedId)
      .execute();

    await writeAudit(
      principal,
      {
        form: 'Lab Receiving',
        action: 'Edit',
        detail: `Lab:${labReceivedId} | Marked ready for collection`,
        invId: labReceivedId,
      },
      tx,
    );
  });
}

export async function listIntakeLines(tx: Tx, labReceivedId: number) {
  return tx
    .selectFrom('lab_received_detail')
    .selectAll()
    .where('inv_id', '=', labReceivedId)
    .orderBy('id')
    .execute();
}
