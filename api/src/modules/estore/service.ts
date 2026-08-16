/**
 * E-Store shipments (Phase 10). The website takes the order; a branch ships it.
 * Not a branch sale — for the branch it is one less battery on the shelf, moving
 * at wholesale. The branch's dues fall when the warehouse accepts.
 */
import { db, inTransaction, type Tx } from '../../core/db/index.js';
import { add, dec, money, mul, qty } from '../../core/money.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { assertBranchAccess, type Principal } from '../../core/rbac.js';
import { issueDocumentNumber } from '../../core/numbering.js';
import { ACC, VTYPE } from '../../accounting/accounts.js';
import { buildJournal, credit, debit } from '../../accounting/journal.js';
import { postJournal } from '../../accounting/post.js';
import { fmt } from '../../accounting/journal.js';

export interface ShipmentLine {
  productId: number;
  qty: string;
}

export async function recordShipment(
  principal: Principal,
  input: {
    orderReference: string;
    branchId: number;
    date: string;
    customerName?: string | null | undefined;
    shippingAddress?: string | null | undefined;
    note?: string | null | undefined;
    lines: ShipmentLine[];
  },
  outerTx?: Tx,
): Promise<{ id: number; docNumber: string }> {
  if (input.lines.length === 0) throw badRequest('Add at least one line');
  assertBranchAccess(principal, input.branchId);

  // A second shipment against the same website order is refused.
  const clash = await (outerTx ?? db)
    .selectFrom('estore_shipment')
    .select('id')
    .where('order_reference', '=', input.orderReference)
    .executeTakeFirst();
  if (clash) throw conflict(`Order reference "${input.orderReference}" has already been shipped`);

  return inTransaction(outerTx, async (tx) => {
    const { docNumber } = await issueDocumentNumber(tx, input.branchId, 'ESTORE');

    // Value each line at the branch's wholesale cost.
    const products = await tx
      .selectFrom('branch_product')
      .innerJoin('product', 'product.id', 'branch_product.product_id')
      .select(['product.id', 'product.name', 'product.price', 'branch_product.wholesale_cost'])
      .where('branch_product.branch_id', '=', input.branchId)
      .where('branch_product.product_id', 'in', input.lines.map((l) => l.productId))
      .execute();

    const byId = new Map(products.map((p) => [p.id, p]));
    const missing = input.lines.filter((l) => !byId.has(l.productId));
    if (missing.length > 0) throw badRequest(`Unknown product id(s): ${missing.map((m) => m.productId).join(', ')}`);

    const shipment = await tx
      .insertInto('estore_shipment')
      .values({
        doc_number: docNumber,
        order_reference: input.orderReference,
        branch_id: input.branchId,
        date: input.date,
        customer_name: input.customerName ?? null,
        shipping_address: input.shippingAddress ?? null,
        status: 'RAISED',
        recorded_by: principal.empId,
        recorded_at: new Date(),
        note: input.note ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const detail = input.lines.map((l) => {
      const p = byId.get(l.productId)!;
      const wholesale = p.wholesale_cost;
      return {
        shipment_id: shipment.id,
        product_id: l.productId,
        qty: qty(l.qty),
        wholesale_price: money(wholesale),
        total: money(mul(l.qty, wholesale)),
      };
    });

    await tx.insertInto('estore_shipment_detail').values(detail).execute();

    await writeAudit(
      principal,
      { form: 'E-Store', action: 'New', detail: `${docNumber} | Recorded shipment for order ${input.orderReference}`, invId: shipment.id },
      tx,
    );

    return { id: shipment.id, docNumber };
  });
}

export async function acceptShipment(
  principal: Principal,
  id: number,
  outerTx?: Tx,
): Promise<{ id: number }> {
  const shipment = await (outerTx ?? db).selectFrom('estore_shipment').selectAll().where('id', '=', id).executeTakeFirst();
  if (!shipment) throw notFound('E-Store shipment');

  if (shipment.status !== 'RAISED') throw conflict(`This shipment is ${shipment.status?.toLowerCase()}`);

  return inTransaction(outerTx, async (tx) => {
    const lines = await tx
      .selectFrom('estore_shipment_detail')
      .selectAll()
      .where('shipment_id', '=', id)
      .execute();

    const branch = await tx
      .selectFrom('branch')
      .select(['id', 'inter_branch_account'])
      .where('id', '=', shipment.branch_id)
      .executeTakeFirst();
    if (!branch?.inter_branch_account) throw badRequest('This branch has no inter-branch account');

    const products = await tx
      .selectFrom('product')
      .select(['id', 'name', 'price'])
      .where('id', 'in', lines.map((l) => l.product_id))
      .execute();
    const byId = new Map(products.map((p) => [p.id, p]));

    let wholesaleTotal = '0.00';
    let cogsTotal = '0.00';
    for (const l of lines) {
      wholesaleTotal = add(wholesaleTotal, l.total);
      const product = byId.get(l.product_id)!;
      cogsTotal = add(cogsTotal, mul(l.qty, product.price));
    }

    // The branch's dues fall by the wholesale value; the inventory falls at
    // production cost (the warehouse's true cost). No branch revenue.
    await postJournal(
      tx,
      buildJournal({
        vtype: VTYPE.ESTORE,
        date: shipment.date,
        invId: shipment.id,
        branchId: shipment.branch_id,
        legs: [
          debit(branch.inter_branch_account, money(wholesaleTotal), `E-Store shipment – ${shipment.doc_number}`),
          credit(ACC.INTER_BRANCH_DUE, money(wholesaleTotal), `E-Store dues reduced – ${shipment.doc_number}`),
          debit(ACC.COGS, money(cogsTotal), `E-Store cost of goods – ${shipment.doc_number}`),
          credit(ACC.INVENTORY_FINISH, money(cogsTotal), `Inventory shipped – E-Store ${shipment.doc_number}`),
        ],
      }),
    );

    await tx
      .updateTable('estore_shipment')
      .set({ status: 'ACCEPTED', accepted_by: principal.empId, accepted_at: new Date(), updated_at: new Date() })
      .where('id', '=', id)
      .execute();

    await writeAudit(
      principal,
      { form: 'E-Store', action: 'Approve', detail: `${shipment.doc_number} | Accepted — dues ${fmt(money(wholesaleTotal))}`, invId: id },
      tx,
    );

    return { id };
  });
}

export async function rejectShipment(
  principal: Principal,
  id: number,
  reason: string,
  outerTx?: Tx,
): Promise<{ id: number }> {
  const shipment = await (outerTx ?? db).selectFrom('estore_shipment').selectAll().where('id', '=', id).executeTakeFirst();
  if (!shipment) throw notFound('E-Store shipment');
  if (shipment.status !== 'RAISED') throw conflict(`This shipment is ${shipment.status?.toLowerCase()}`);
  if (!reason.trim()) throw badRequest('Give a reason for the rejection');

  await db
    .updateTable('estore_shipment')
    .set({ status: 'REJECTED', rejection_reason: reason.trim(), accepted_by: principal.empId, accepted_at: new Date(), updated_at: new Date() })
    .where('id', '=', id)
    .execute();

  await writeAudit(
    principal,
    { form: 'E-Store', action: 'Edit', detail: `${shipment.doc_number} | Rejected — ${reason.trim()}`, invId: id },
    db,
  );

  return { id };
}
