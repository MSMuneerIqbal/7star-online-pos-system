/**
 * Demand order / inter-branch transfer.
 *
 * ONE module replacing ten legacy controllers. The raw and finished chains were
 * near-identical copies differing only in which stock kind they moved and which
 * catalog they read:
 *
 *   raw:    DemandOrder 17, DemandOrderRequest 18, BranchTransfer 39,
 *           DemandOrderReceiving 19, DoReceived 41
 *   finish: DoFinish 20, DoFinishRequest 21, BranchTransferFinish 40,
 *           DoFinishReceiving 22, DoFinishReceived 49
 *
 * The workflow is a four-stage chain over three table pairs:
 *
 *   ORDER      demand_order   a branch asks head office for stock
 *   REQUEST    do_request     the supplying branch commits to send it
 *   DESPATCH   do_request     goods leave        → posts BTINV
 *   RECEIVE    do_received    goods arrive       → posts DORINV
 *
 * Only the last two touch the ledger. An order or a request is a promise, not a
 * movement, so nothing is posted until stock actually moves.
 */
import { db, withTransaction, type Tx } from '../../core/db/index.js';
import { add, gt, money, mul, type MoneyString } from '../../core/money.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { issueDocumentNumber } from '../../core/numbering.js';
import { writeAudit } from '../../core/audit.js';
import { assertBranchAccess, type Principal } from '../../core/rbac.js';
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
 * Price lines at COST from the catalog.
 *
 * A transfer is an internal movement, so it is always valued at cost —
 * a branch cannot mark up stock it sends to another branch.
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
    if (!gt(line.qty, '0.000')) {
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

// ---------------------------------------------------------------------------
// Stage 1 — the order
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
// Stage 2 — the request (supplying branch commits)
// ---------------------------------------------------------------------------

export interface RequestInput {
  date: string;
  kind: StockKind;
  /** The order being fulfilled, when there is one. */
  doId?: number | null | undefined;
  fromBranchId: number;
  toBranchId: number;
  note?: string | null | undefined;
  lines: LineInput[];
}

export async function createRequest(
  principal: Principal,
  input: RequestInput,
): Promise<{ id: number }> {
  if (input.fromBranchId === input.toBranchId) {
    throw badRequest('A branch cannot transfer stock to itself');
  }

  // The supplying branch raises the request.
  assertBranchAccess(principal, input.fromBranchId);

  return withTransaction(async (tx) => {
    const { lines, total } = await priceLines(tx, input.kind, input.lines);

    const request = await tx
      .insertInto('do_request')
      .values({
        do_id: input.doId ?? null,
        date: input.date,
        from_branch: input.fromBranchId,
        to_branch: input.toBranchId,
        type: input.kind,
        status: STATUS.PENDING,
        is_req: true,
        note: input.note ?? null,
        gross: total,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('do_request_detail')
      .values(
        lines.map((l) => ({
          inv_id: request.id,
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

    if (input.doId) {
      await tx
        .updateTable('demand_order')
        .set({ status: STATUS.APPROVED, updated_at: new Date() })
        .where('id', '=', input.doId)
        .execute();
    }

    await writeAudit(
      principal,
      {
        form: DO_FORMS.REQUEST[input.kind].label,
        action: 'New',
        detail:
          `REQ:${request.id} | New ${input.kind} transfer request | ` +
          `From branch ${input.fromBranchId} to ${input.toBranchId} | Value ${fmt(total)}`,
        invId: request.id,
      },
      tx,
    );

    return { id: request.id };
  });
}

// ---------------------------------------------------------------------------
// Stage 3 — despatch. FIRST ledger impact.
// ---------------------------------------------------------------------------

export async function despatchRequest(
  principal: Principal,
  requestId: number,
): Promise<{ id: number; transId: number }> {
  const request = await db
    .selectFrom('do_request')
    .selectAll()
    .where('id', '=', requestId)
    .executeTakeFirst();

  if (!request) throw notFound('Transfer request');
  assertBranchAccess(principal, request.from_branch);

  if (request.status === STATUS.DESPATCHED || request.status === STATUS.RECEIVED) {
    throw conflict('This request has already been despatched');
  }
  if (request.status === STATUS.CANCELLED) {
    throw conflict('This request was cancelled');
  }

  const kind = (request.type ?? 'RAW') as StockKind;

  return withTransaction(async (tx) => {
    const branches = await branchNames(tx, [request.from_branch, request.to_branch]);

    const posted = await postJournal(
      tx,
      postTransferOut({
        invId: requestId,
        date: request.date,
        fromBranchId: request.from_branch,
        toBranchId: request.to_branch,
        fromBranchName: branches.get(request.from_branch) ?? '',
        toBranchName: branches.get(request.to_branch) ?? '',
        kind,
        value: request.gross,
      }),
    );

    await tx
      .updateTable('do_request')
      .set({ status: STATUS.DESPATCHED, updated_at: new Date(), updated_by: principal.empId })
      .where('id', '=', requestId)
      .execute();

    await tx
      .updateTable('do_request_detail')
      .set({ status: STATUS.DESPATCHED })
      .where('inv_id', '=', requestId)
      .execute();

    await writeAudit(
      principal,
      {
        form: DO_FORMS.REQUEST[kind].label,
        action: 'Approve',
        detail:
          `REQ:${requestId} | Despatched ${kind} stock | ` +
          `${branches.get(request.from_branch)} -> ${branches.get(request.to_branch)} | ` +
          `Value ${fmt(request.gross)}`,
        invId: requestId,
      },
      tx,
    );

    return { id: requestId, transId: posted.transId };
  });
}

// ---------------------------------------------------------------------------
// Stage 4 — receipt. SECOND ledger impact.
// ---------------------------------------------------------------------------

export interface ReceiveInput {
  date: string;
  requestId: number;
  freight: string;
  freightPaidInCash: boolean;
  note?: string | null | undefined;
  receivedBy?: string | null | undefined;
  /** Omit to receive exactly what was despatched. */
  lines?: LineInput[] | undefined;
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
    // Default to the despatched lines — a short receipt is the exception.
    const sourceLines =
      input.lines ??
      (
        await tx
          .selectFrom('do_request_detail')
          .select(['pid', 'qty'])
          .where('inv_id', '=', input.requestId)
          .execute()
      ).map((l) => ({ pid: l.pid, qty: l.qty }));

    const { lines, total } = await priceLines(tx, kind, sourceLines);
    const branches = await branchNames(tx, [request.from_branch, request.to_branch]);
    const freight = money(input.freight);

    const received = await tx
      .insertInto('do_received')
      .values({
        do_req_id: input.requestId,
        from_branch: request.from_branch,
        to_branch: request.to_branch,
        date: input.date,
        type: kind,
        note: input.note ?? null,
        received_by: input.receivedBy ?? null,
        cargo_expense: freight,
        gross: total,
        net: add(total, freight),
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('do_received_detail')
      .values(
        lines.map((l) => ({
          inv_id: received.id,
          pid: l.pid,
          pname: l.pname,
          qty: l.qty,
          price: l.price,
          total: l.total,
        })),
      )
      .execute();

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
        value: total,
        freight,
        freightPaidInCash: input.freightPaidInCash,
      }),
    );

    await tx
      .updateTable('do_request')
      .set({ status: STATUS.RECEIVED, updated_at: new Date() })
      .where('id', '=', input.requestId)
      .execute();

    await writeAudit(
      principal,
      {
        form: DO_FORMS.RECEIVE[kind].label,
        action: 'Approve',
        detail:
          `RCV:${received.id} | Received ${kind} stock against REQ:${input.requestId} | ` +
          `${branches.get(request.from_branch)} -> ${branches.get(request.to_branch)} | ` +
          `Value ${fmt(total)}, Freight ${fmt(freight)}`,
        invId: received.id,
      },
      tx,
    );

    return { id: received.id, transId: posted.transId };
  });
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
