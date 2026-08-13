/**
 * Demand order / inter-branch transfer — Phase 5 reshape.
 *
 * The three-step handshake (SPECS §6):
 *
 *   ORDER      demand_order   a branch asks head office for stock
 *   DISPATCH   do_request     the WAREHOUSE approves (less than asked), sets the
 *                             wholesale price and grade per line, and stock
 *                             leaves ready stock   → posts BTINV
 *   RECEIPT    do_received    the branch confirms what arrived — received, short
 *                             and damaged per line   → posts DORINV
 *
 * Every dispatched line carries TWO prices: wholesale (the branch's charge,
 * which it sees) and production cost (the warehouse's true cost, which a branch
 * never sees). Debt arises on confirmed receipt, at wholesale value; short and
 * damaged units are expensed as stock loss and never become the branch's debt
 * (PRINCIPLES §17.6, decided in Phase 5).
 *
 * On receipt, `branch_product.wholesale_cost` is recalculated as a weighted
 * average (PRINCIPLES §17.9). Branch-to-branch transfer is refused — only the
 * warehouse dispatches.
 */
import { db, withTransaction, type Tx } from '../../core/db/index.js';
import { add, dec, money, mul, qty, sub, type MoneyString } from '../../core/money.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { assertBranchAccess, type Principal } from '../../core/rbac.js';
import { issueDocumentNumber } from '../../core/numbering.js';
import { VTYPE } from '../../accounting/accounts.js';
import { postTransferIn, postTransferOut, type StockKind } from '../../accounting/rules/transfer.js';
import { postJournal, repostDocument } from '../../accounting/post.js';
import { fmt } from '../../accounting/journal.js';

export type Stage = 'ORDER' | 'REQUEST' | 'RECEIVE';

export const STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  DESPATCHED: 'DESPATCHED',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED',
} as const;

/**
 * Legacy form/action codes, so existing role assignments keep working.
 * See migration 1700000000003.
 */
export const DO_FORMS: Record<Stage, Record<StockKind, { formId: number; formCode: number; label: string }>> = {
  ORDER: {
    RAW: { formId: 17, formCode: 501, label: 'Demand Order' },
    FINISH: { formId: 20, formCode: 504, label: 'DO Finish' },
  },
  REQUEST: {
    RAW: { formId: 18, formCode: 502, label: 'DO Request' },
    FINISH: { formId: 21, formCode: 505, label: 'DO Finish Request' },
  },
  RECEIVE: {
    RAW: { formId: 41, formCode: 509, label: 'DO Received' },
    FINISH: { formId: 49, formCode: 510, label: 'DO Finish Received' },
  },
};

/** Which catalog a stock kind draws from. */
export function catalogTable(kind: StockKind): 'raw_product' | 'product' {
  return kind === 'RAW' ? 'raw_product' : 'product';
}

export interface LineInput {
  pid: number;
  qty: string;
  price?: string | undefined;
}

export interface PricedLine extends LineInput {
  pname: string;
  price: MoneyString;
  total: MoneyString;
}

/**
 * Price lines at COST from the catalog. A transfer is an internal movement, so
 * it is always valued at cost — a branch cannot mark up stock it sends.
 */
export async function priceLines(
  tx: Tx,
  kind: StockKind,
  lines: readonly LineInput[],
): Promise<{ lines: PricedLine[]; total: MoneyString }> {
  if (lines.length === 0) throw badRequest('Add at least one item');

  const ids = [...new Set(lines.map((l) => l.pid))];

  const products =
    kind === 'RAW'
      ? await tx.selectFrom('raw_product').select(['id', 'name', 'price']).where('id', 'in', ids).execute()
      : await tx.selectFrom('product').select(['id', 'name', 'price']).where('id', 'in', ids).execute();

  const byId = new Map(products.map((p) => [p.id, p]));
  const missing = ids.filter((id) => !byId.has(id));

  if (missing.length > 0) {
    throw badRequest(`Unknown ${kind === 'RAW' ? 'raw item' : 'product'} id(s): ${missing.join(', ')}`);
  }

  const priced: PricedLine[] = [];
  let total = '0.00';

  for (const [i, line] of lines.entries()) {
    if (!gtQty(line.qty)) {
      throw badRequest(`Line ${i + 1}: quantity must be greater than zero`);
    }

    const product = byId.get(line.pid)!;
    const price = money(product.price);
    const lineTotal = mul(line.qty, price);

    priced.push({ ...line, pname: product.name ?? '', price, total: lineTotal });
    total = add(total, lineTotal);
  }

  return { lines: priced, total };
}

function gtQty(q: string): boolean {
  return dec(q).gt(0);
}

// ---------------------------------------------------------------------------
// Stage 1 — the order (a branch asks)
// ---------------------------------------------------------------------------

export interface OrderInput {
  date: string;
  kind: StockKind;
  /** The branch that will supply the stock. */
  fromBranchId: number;
  /** The branch asking for it. */
  toBranchId: number;
  note?: string | null | undefined;
  lines: LineInput[];
}

export async function createOrder(
  principal: Principal,
  input: OrderInput,
): Promise<{ id: number }> {
  if (input.fromBranchId === input.toBranchId) {
    throw badRequest('A branch cannot raise a demand order against itself');
  }

  // The requesting branch raises the order, so that is the one to check.
  assertBranchAccess(principal, input.toBranchId);

  return withTransaction(async (tx) => {
    const { lines, total } = await priceLines(tx, input.kind, input.lines);

    // Numbered against the requesting branch (to_branch), which raises it.
    const { docNumber } = await issueDocumentNumber(tx, input.toBranchId, 'DEMAND_ORDER');

    const order = await tx
      .insertInto('demand_order')
      .values({
        date: input.date,
        doc_number: docNumber,
        from_branch: input.fromBranchId,
        to_branch: input.toBranchId,
        type: input.kind,
        status: STATUS.PENDING,
        note: input.note ?? null,
        gross: total,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('demand_order_detail')
      .values(
        lines.map((l) => ({
          inv_id: order.id,
          pid: l.pid,
          pname: l.pname,
          qty: l.qty,
          inv_qty: '0',
          price: l.price,
          total: l.total,
          status: STATUS.PENDING,
        })),
      )
      .execute();

    await writeAudit(
      principal,
      {
        form: DO_FORMS.ORDER[input.kind].label,
        action: 'New',
        detail:
          `DO:${order.id} | New ${input.kind} demand order | ` +
          `From branch ${input.fromBranchId} to ${input.toBranchId} | Value ${fmt(total)}`,
        invId: order.id,
      },
      tx,
    );

    return { id: order.id };
  });
}

// ---------------------------------------------------------------------------
// Stage 2 — dispatch. The warehouse approves, prices, and stock leaves.
// ---------------------------------------------------------------------------

export interface DispatchLine {
  pid: number;
  /** Quantity actually approved — never more than asked. */
  qty: string;
  /** The branch's charge per unit. */
  wholesalePrice: string;
  /** NEW or REPAIRED — travels with the unit. */
  grade?: 'NEW' | 'REPAIRED' | undefined;
}

export interface DispatchInput {
  date: string;
  kind: StockKind;
  /** The demand order being fulfilled. */
  doId: number;
  note?: string | null | undefined;
  lines: DispatchLine[];
}

export async function dispatchOrder(
  principal: Principal,
  input: DispatchInput,
): Promise<{ id: number; transId: number }> {
  const order = await db
    .selectFrom('demand_order')
    .selectAll()
    .where('id', '=', input.doId)
    .executeTakeFirst();

  if (!order) throw notFound('Demand order');
  assertBranchAccess(principal, order.from_branch);

  // Only the warehouse dispatches — branch-to-branch is refused (PRINCIPLES §17.15).
  const supplier = await db
    .selectFrom('branch')
    .select(['id', 'type'])
    .where('id', '=', order.from_branch)
    .executeTakeFirst();
  if (!supplier || supplier.type !== 'WAREHOUSE') {
    throw badRequest('Only the warehouse can dispatch stock');
  }

  if (order.status !== STATUS.PENDING) {
    throw conflict(`This order is ${order.status?.toLowerCase()} and cannot be dispatched`);
  }

  const kind = (order.type ?? input.kind) as StockKind;

  return withTransaction(async (tx) => {
    const { lines, total } = await priceLines(tx, kind, input.lines);

    // Approve less, never more, than the branch asked.
    const ordered = await tx
      .selectFrom('demand_order_detail')
      .select(['pid', 'qty'])
      .where('inv_id', '=', order.id)
      .execute();

    const orderedByPid = new Map(ordered.map((o) => [o.pid, dec(o.qty)]));
    for (const line of lines) {
      const asked = orderedByPid.get(line.pid);
      if (!asked) throw badRequest(`Item ${line.pid} was not in the demand order`);
      if (dec(line.qty).gt(asked)) {
        throw badRequest(`Dispatch of ${line.qty} exceeds the ${asked} asked for item ${line.pid}`);
      }
    }

    const { docNumber } = await issueDocumentNumber(tx, order.from_branch, 'DISPATCH');

    const request = await tx
      .insertInto('do_request')
      .values({
        do_id: order.id,
        doc_number: docNumber,
        date: input.date,
        from_branch: order.from_branch,
        to_branch: order.to_branch,
        type: kind,
        status: STATUS.DESPATCHED,
        is_req: true,
        note: input.note ?? null,
        gross: total,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const wholesaleByPid = new Map(input.lines.map((l) => [l.pid, l]));

    await tx
      .insertInto('do_request_detail')
      .values(
        lines.map((l) => {
          const w = wholesaleByPid.get(l.pid)!;
          return {
            inv_id: request.id,
            pid: l.pid,
            pname: l.pname,
            qty: l.qty,
            inv_qty: '0',
            wholesale_price: money(w.wholesalePrice),
            production_cost: l.price,
            grade: w.grade ?? 'NEW',
            price: l.price,
            total: l.total,
            status: STATUS.DESPATCHED,
          };
        }),
      )
      .execute();

    const branches = await branchNames(tx, [order.from_branch, order.to_branch]);

    // Stock leaves the warehouse at production cost.
    const posted = await postJournal(
      tx,
      postTransferOut({
        invId: request.id,
        date: input.date,
        fromBranchId: order.from_branch,
        toBranchId: order.to_branch,
        fromBranchName: branches.get(order.from_branch) ?? '',
        toBranchName: branches.get(order.to_branch) ?? '',
        kind,
        value: total,
      }),
    );

    await tx
      .updateTable('demand_order')
      .set({ status: STATUS.DESPATCHED, updated_at: new Date() })
      .where('id', '=', order.id)
      .execute();

    await writeAudit(
      principal,
      {
        form: DO_FORMS.REQUEST[kind].label,
        action: 'Approve',
        detail:
          `${docNumber} | Dispatched ${kind} stock | ` +
          `${branches.get(order.from_branch)} -> ${branches.get(order.to_branch)} | Value ${fmt(total)}`,
        invId: request.id,
      },
      tx,
    );

    return { id: request.id, transId: posted.transId };
  });
}

// ---------------------------------------------------------------------------
// Stage 3 — receipt. The branch confirms what arrived.
// ---------------------------------------------------------------------------

export interface ReceiveLine {
  pid: number;
  receivedQty: string;
  shortQty: string;
  damagedQty: string;
}

export interface ReceiveInput {
  date: string;
  requestId: number;
  freight: string;
  freightPaidInCash: boolean;
  note?: string | null | undefined;
  receivedBy?: string | null | undefined;
  /** Omit to receive exactly what was despatched. */
  lines?: ReceiveLine[] | undefined;
}

export async function receiveTransfer(
  principal: Principal,
  input: ReceiveInput,
): Promise<{ id: number; transId: number }> {
  const request = await db
    .selectFrom('do_request')
    .selectAll()
    .where('id', '=', input.requestId)
    .executeTakeFirst();

  if (!request) throw notFound('Transfer request');
  assertBranchAccess(principal, request.to_branch);

  if (request.status !== STATUS.DESPATCHED) {
    throw conflict(
      request.status === STATUS.RECEIVED
        ? 'This transfer has already been received'
        : 'Stock cannot be received before it has been despatched',
    );
  }

  const kind = (request.type ?? 'RAW') as StockKind;

  return withTransaction(async (tx) => {
    const despatched = await tx
      .selectFrom('do_request_detail')
      .select(['pid', 'pname', 'qty', 'production_cost', 'wholesale_price'])
      .where('inv_id', '=', input.requestId)
      .execute();

    // Default to receiving everything despatched.
    const sourceLines: ReceiveLine[] =
      input.lines ??
      despatched.map((d) => ({
        pid: d.pid,
        receivedQty: d.qty,
        shortQty: '0',
        damagedQty: '0',
      }));

    // Every despatched line must be accounted for: received + short + damaged.
    const despatchedByPid = new Map(despatched.map((d) => [d.pid, d]));
    let receivedTotal = '0.00';
    let lossTotal = '0.00';

    const receiptLines = sourceLines.map((l) => {
      const d = despatchedByPid.get(l.pid);
      if (!d) throw badRequest(`Item ${l.pid} was not in this dispatch`);

      const received = dec(l.receivedQty);
      const shortQ = dec(l.shortQty);
      const damaged = dec(l.damagedQty);

      if (received.add(shortQ).add(damaged).sub(dec(d.qty)).abs().gt('0.0005')) {
        throw badRequest(
          `Item ${l.pid}: received + short + damaged must equal the ${d.qty} despatched`,
        );
      }

      const prodCost = d.production_cost;
      const recvVal = mul(l.receivedQty, prodCost);
      const lossVal = mul(add(l.shortQty, l.damagedQty), prodCost);
      receivedTotal = add(receivedTotal, recvVal);
      lossTotal = add(lossTotal, lossVal);

      return {
        pid: l.pid,
        pname: d.pname,
        qty: d.qty,
        received_qty: qty(l.receivedQty),
        short_qty: qty(l.shortQty),
        damaged_qty: qty(l.damagedQty),
        price: d.wholesale_price,
        total: mul(l.receivedQty, d.wholesale_price),
      };
    });

    const branches = await branchNames(tx, [request.from_branch, request.to_branch]);
    const freight = money(input.freight);

    const { docNumber } = await issueDocumentNumber(tx, request.to_branch, 'RECEIPT');

    const received = await tx
      .insertInto('do_received')
      .values({
        do_req_id: input.requestId,
        doc_number: docNumber,
        from_branch: request.from_branch,
        to_branch: request.to_branch,
        date: input.date,
        type: kind,
        note: input.note ?? null,
        received_by: input.receivedBy ?? null,
        cargo_expense: freight,
        gross: receivedTotal,
        net: add(receivedTotal, freight),
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await tx.insertInto('do_received_detail').values(receiptLines.map((l) => ({ ...l, inv_id: received.id }))).execute();

    const posted = await postJournal(
      tx,
      postTransferIn({
        invId: received.id,
        date: input.date,
        fromBranchId: request.from_branch,
        toBranchId: request.to_branch,
        fromBranchName: branches.get(request.from_branch) ?? '',
        toBranchName: branches.get(request.to_branch) ?? '',
        kind,
        value: add(receivedTotal, lossTotal),
        receivedValue: receivedTotal,
        freight,
        freightPaidInCash: input.freightPaidInCash,
      }),
    );

    await tx
      .updateTable('do_request')
      .set({ status: STATUS.RECEIVED, updated_at: new Date() })
      .where('id', '=', input.requestId)
      .execute();

    await tx
      .updateTable('demand_order')
      .set({ status: STATUS.RECEIVED, updated_at: new Date() })
      .where('id', '=', request.do_id ?? -1)
      .execute();

    // Weighted-average wholesale cost (PRINCIPLES §17.9), FINISH goods only.
    if (kind === 'FINISH') {
      await updateWholesaleCosts(tx, request.to_branch, despatched, sourceLines);
    }

    await writeAudit(
      principal,
      {
        form: DO_FORMS.RECEIVE[kind].label,
        action: 'Approve',
        detail:
          `${docNumber} | Received ${kind} stock against dispatch ${request.doc_number} | ` +
          `${branches.get(request.from_branch)} -> ${branches.get(request.to_branch)} | ` +
          `Received ${fmt(receivedTotal)}, Loss ${fmt(lossTotal)}, Freight ${fmt(freight)}`,
        invId: received.id,
      },
      tx,
    );

    return { id: received.id, transId: posted.transId };
  });
}

/**
 * Recalculate `branch_product.wholesale_cost` as a weighted average of what the
 * branch now holds (its existing stock at the old average, plus what just
 * arrived at this dispatch's wholesale price).
 */
async function updateWholesaleCosts(
  tx: Tx,
  branchId: number,
  despatched: Array<{ pid: number; wholesale_price: string }>,
  receivedLines: ReceiveLine[],
): Promise<void> {
  for (const d of despatched) {
    const line = receivedLines.find((l) => l.pid === d.pid);
    const receivedQty = dec(line?.receivedQty ?? '0');
    if (receivedQty.lte(0)) continue;

    const bp = await tx
      .selectFrom('branch_product')
      .select(['id', 'wholesale_cost'])
      .where('branch_id', '=', branchId)
      .where('product_id', '=', d.pid)
      .executeTakeFirst();
    if (!bp) continue;

    // Existing on-hand quantity at this branch, before this receipt lands.
    const prior = await tx
      .selectFrom('do_received_detail')
      .innerJoin('do_received', 'do_received.id', 'do_received_detail.inv_id')
      .select(({ fn }) => fn.sum<string>('do_received_detail.received_qty').as('qty'))
      .where('do_received.to_branch', '=', branchId)
      .where('do_received_detail.pid', '=', d.pid)
      .executeTakeFirst();
    const oldQty = dec(prior?.qty ?? '0');

    const oldCost = dec(bp.wholesale_cost);
    const newCost =
      oldQty.add(receivedQty).gt(0)
        ? oldQty.mul(oldCost).add(receivedQty.mul(dec(d.wholesale_price))).div(oldQty.add(receivedQty))
        : dec(d.wholesale_price);

    await tx
      .updateTable('branch_product')
      .set({ wholesale_cost: money(newCost), updated_at: new Date() })
      .where('id', '=', bp.id)
      .execute();
  }
}

/**
 * Reverse a receipt — used when goods are found damaged or miscounted after
 * the fact. Writes a reversal rather than deleting, so the original stays
 * visible.
 */
export async function reverseReceipt(
  principal: Principal,
  receivedId: number,
): Promise<{ id: number }> {
  const received = await db
    .selectFrom('do_received')
    .selectAll()
    .where('id', '=', receivedId)
    .executeTakeFirst();

  if (!received) throw notFound('Receipt');
  assertBranchAccess(principal, received.to_branch);

  return withTransaction(async (tx) => {
    // Posting an empty journal list reverses the existing entries and adds
    // nothing back.
    await repostDocument(tx, VTYPE.DO_RECEIVED, receivedId, []);

    if (received.do_req_id) {
      await tx
        .updateTable('do_request')
        .set({ status: STATUS.DESPATCHED, updated_at: new Date() })
        .where('id', '=', received.do_req_id)
        .execute();
    }

    await writeAudit(
      principal,
      {
        form: 'DO Received',
        action: 'Delete',
        detail: `RCV:${receivedId} | Reversed receipt | Value ${fmt(received.gross)}`,
        invId: receivedId,
      },
      tx,
    );

    return { id: receivedId };
  });
}

async function branchNames(tx: Tx, ids: readonly number[]): Promise<Map<number, string>> {
  const rows = await tx
    .selectFrom('branch')
    .select(['id', 'name'])
    .where('id', 'in', [...new Set(ids)])
    .execute();

  return new Map(rows.map((r) => [r.id, r.name]));
}
