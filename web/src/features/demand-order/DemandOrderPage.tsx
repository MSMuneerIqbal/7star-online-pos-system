import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Package, PackageCheck, Plus, Save, Truck, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { Field, PageHeader } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { emptyLine, type InvoiceLine } from '@/components/invoice/useInvoiceLines';

export type StockKind = 'raw' | 'finish';

/** The four stages of the transfer chain. Only the last two touch the ledger. */
type Tab = 'orders' | 'requests' | 'received';

const KIND_LABEL: Record<StockKind, string> = { raw: 'Raw Item', finish: 'Finish Item' };

/** Legacy form/action codes per kind and stage. */
const PERMS: Record<StockKind, Record<Tab, { formId: number; create: number; edit: number }>> = {
  raw: {
    orders: { formId: 17, create: 5012, edit: 5013 },
    requests: { formId: 18, create: 5022, edit: 5023 },
    received: { formId: 41, create: 5092, edit: 5093 },
  },
  finish: {
    orders: { formId: 20, create: 5042, edit: 5043 },
    requests: { formId: 21, create: 5052, edit: 5053 },
    received: { formId: 49, create: 5102, edit: 5103 },
  },
};

interface Branch {
  id: number;
  name: string;
}

interface FormData {
  products: { id: number; name: string | null; sale_price: string }[];
  branches: Branch[];
  kind: string;
}

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface OrderRow {
  id: number;
  date: string;
  from_branch: number;
  to_branch: number;
  status: string | null;
  gross: string;
  note: string | null;
}

interface RequestRow extends OrderRow {
  do_id: number | null;
}

interface ReceivedRow {
  id: number;
  do_req_id: number | null;
  date: string;
  from_branch: number;
  to_branch: number;
  gross: string;
  cargo_expense: string;
  net: string;
  received_by: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-sky-100 text-sky-800',
  DESPATCHED: 'bg-indigo-100 text-indigo-800',
  RECEIVED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-slate-200 text-slate-600',
};

const today = () => new Date().toISOString().slice(0, 10);

const StatusChip = ({ status }: { status: string | null }) => (
  <span
    className={cn(
      'inline-block rounded-sm px-1.5 py-0.5 text-xs font-medium',
      STATUS_STYLE[status ?? ''] ?? 'bg-slate-100 text-slate-600',
    )}
  >
    {status ?? '—'}
  </span>
);

/**
 * Demand order / inter-branch transfer.
 *
 * One page covering what the legacy system split across ten controllers. The
 * stock kind comes from the route; the four stages are tabs.
 */
export function DemandOrderPage({ kind }: { kind: StockKind }) {
  const { hasAction } = useAuth();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<Tab>('orders');
  const [page, setPage] = useState(1);
  const [composing, setComposing] = useState<'order' | 'request' | null>(null);
  const [receiving, setReceiving] = useState<RequestRow | null>(null);

  const formData = useQuery({
    queryKey: ['demand-orders', kind, 'form-data'],
    queryFn: () => api.get<FormData>(`/demand-orders/${kind}/form-data`),
  });

  const branchName = (id: number) =>
    formData.data?.branches.find((b) => b.id === id)?.name ?? `Branch ${id}`;

  const list = useQuery({
    queryKey: ['demand-orders', kind, tab, page],
    queryFn: () =>
      api.get<Paged<OrderRow & RequestRow & ReceivedRow>>(
        `/demand-orders/${kind}/${tab}?page=${page}&pageSize=20`,
      ),
    enabled: composing === null,
  });

  const despatch = useMutation({
    mutationFn: (row: RequestRow) =>
      api.post(`/demand-orders/${kind}/requests/${row.id}/despatch`),
    onSuccess: () => {
      toast.success('Stock despatched — inventory moved to in-transit');
      void queryClient.invalidateQueries({ queryKey: ['demand-orders', kind] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not despatch'),
  });

  const perms = PERMS[kind][tab];

  const commonColumns: readonly Column<OrderRow & RequestRow>[] = [
    { key: 'id', header: 'No.', numeric: true, width: '4.5rem' },
    { key: 'date', header: 'Date', width: '7.5rem' },
    { key: 'from_branch', header: 'From', cell: (r) => branchName(r.from_branch) },
    {
      key: 'arrow',
      header: '',
      width: '2rem',
      cell: () => <ArrowRight className="size-3 text-slate-400" />,
    },
    { key: 'to_branch', header: 'To', cell: (r) => branchName(r.to_branch) },
    { key: 'gross', header: 'Value', numeric: true, cell: (r) => fmtMoney(r.gross) },
    { key: 'status', header: 'Status', width: '8rem', cell: (r) => <StatusChip status={r.status} /> },
  ];

  const receivedColumns: readonly Column<ReceivedRow>[] = [
    { key: 'id', header: 'No.', numeric: true, width: '4.5rem' },
    { key: 'date', header: 'Date', width: '7.5rem' },
    { key: 'from_branch', header: 'From', cell: (r) => branchName(r.from_branch) },
    { key: 'to_branch', header: 'To', cell: (r) => branchName(r.to_branch) },
    { key: 'gross', header: 'Stock value', numeric: true, cell: (r) => fmtMoney(r.gross) },
    {
      key: 'cargo_expense',
      header: 'Freight',
      numeric: true,
      cell: (r) => fmtMoney(r.cargo_expense),
    },
    { key: 'received_by', header: 'Received by', cell: (r) => r.received_by ?? '—' },
  ];

  if (composing) {
    return (
      <TransferComposer
        kind={kind}
        mode={composing}
        branches={formData.data?.branches ?? []}
        products={formData.data?.products ?? []}
        onDone={() => setComposing(null)}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={`Demand Order — ${KIND_LABEL[kind]}`}
        subtitle="Move stock between your own branches"
        actions={
          tab !== 'received' &&
          hasAction(perms.formId, perms.create) && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => setComposing(tab === 'orders' ? 'order' : 'request')}
            >
              <Plus className="size-3.5" />
              New {tab === 'orders' ? 'Order' : 'Transfer'}
            </button>
          )
        }
      />

      {/* Stage tabs, in workflow order. */}
      <div className="no-print mb-3 flex gap-1 border-b border-slate-200">
        {(
          [
            ['orders', 'Orders', Package],
            ['requests', 'Transfers', Truck],
            ['received', 'Received', PackageCheck],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setTab(value);
              setPage(1);
            }}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm transition',
              tab === value
                ? 'border-brand-600 font-medium text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'received' ? (
        <DataTable
          columns={receivedColumns}
          rows={(list.data?.rows ?? []) as ReceivedRow[]}
          rowKey={(r) => r.id}
          loading={list.isPending}
          error={list.error ? (list.error as Error).message : null}
          emptyMessage="Nothing received yet"
        />
      ) : (
        <DataTable
          columns={commonColumns}
          rows={list.data?.rows ?? []}
          rowKey={(r) => r.id}
          loading={list.isPending}
          error={list.error ? (list.error as Error).message : null}
          emptyMessage={tab === 'orders' ? 'No demand orders yet' : 'No transfers yet'}
          actions={
            tab === 'requests' && hasAction(perms.formId, perms.edit)
              ? (row) => (
                  <div className="flex justify-end gap-1">
                    {row.status === 'PENDING' && (
                      <button
                        type="button"
                        title="Despatch — moves stock out of this branch"
                        className="rounded-sm p-1.5 text-slate-500 hover:bg-indigo-50 hover:text-indigo-700"
                        onClick={() => despatch.mutate(row)}
                      >
                        <Truck className="size-3.5" />
                      </button>
                    )}
                    {row.status === 'DESPATCHED' && (
                      <button
                        type="button"
                        title="Receive — brings stock into the destination branch"
                        className="rounded-sm p-1.5 text-slate-500 hover:bg-emerald-50 hover:text-emerald-700"
                        onClick={() => setReceiving(row)}
                      >
                        <PackageCheck className="size-3.5" />
                      </button>
                    )}
                  </div>
                )
              : undefined
          }
        />
      )}

      {list.data && (
        <Pagination
          page={list.data.page}
          pageSize={list.data.pageSize}
          total={list.data.total}
          onPageChange={setPage}
        />
      )}

      <ReceiveDialog
        kind={kind}
        request={receiving}
        branchName={branchName}
        onClose={() => setReceiving(null)}
      />
    </>
  );
}

function ReceiveDialog({
  kind,
  request,
  branchName,
  onClose,
}: {
  kind: StockKind;
  request: RequestRow | null;
  branchName: (id: number) => string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [freight, setFreight] = useState('0');
  const [paidInCash, setPaidInCash] = useState(true);
  const [receivedBy, setReceivedBy] = useState('');

  const receive = useMutation({
    mutationFn: () =>
      api.post(`/demand-orders/${kind}/received`, {
        date: today(),
        requestId: request?.id,
        freight,
        freightPaidInCash: paidInCash,
        receivedBy: receivedBy || null,
      }),
    onSuccess: () => {
      toast.success('Stock received');
      void queryClient.invalidateQueries({ queryKey: ['demand-orders', kind] });
      onClose();
      setFreight('0');
      setReceivedBy('');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not receive'),
  });

  return (
    <Modal
      open={request !== null}
      title={`Receive transfer #${request?.id ?? ''}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={receive.isPending}
            onClick={() => receive.mutate()}
          >
            {receive.isPending ? 'Receiving…' : 'Receive'}
          </button>
        </>
      }
    >
      {request && (
        <>
          <p className="mb-3 text-sm text-slate-600">
            {branchName(request.from_branch)} → {branchName(request.to_branch)}, value{' '}
            <strong className="tabular">{fmtMoney(request.gross)}</strong>.
          </p>

          <div className="space-y-3">
            <Field
              label="Freight / cargo"
              name="freight"
              type="number"
              step="any"
              min="0"
              value={freight}
              onChange={(e) => setFreight(e.target.value)}
              hint="Expensed at this branch, not added to stock value."
            />

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={paidInCash}
                onChange={(e) => setPaidInCash(e.target.checked)}
                className="rounded-sm border-slate-300"
              />
              Freight paid in cash now
            </label>

            <Field
              label="Received by"
              name="receivedBy"
              value={receivedBy}
              onChange={(e) => setReceivedBy(e.target.value)}
            />
          </div>
        </>
      )}
    </Modal>
  );
}

function TransferComposer({
  kind,
  mode,
  branches,
  products,
  onDone,
}: {
  kind: StockKind;
  mode: 'order' | 'request';
  branches: Branch[];
  products: { id: number; name: string | null; sale_price: string }[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();

  const [date, setDate] = useState(today());
  const [fromBranchId, setFromBranchId] = useState<number | null>(null);
  const [toBranchId, setToBranchId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<InvoiceLine[]>([emptyLine()]);

  const validLines = lines.filter((l) => l.pid !== null && Number(l.qty) > 0);

  const errors: string[] = [];
  if (validLines.length === 0) errors.push('Add at least one item');
  if (fromBranchId === null || toBranchId === null) errors.push('Choose both branches');
  if (fromBranchId !== null && fromBranchId === toBranchId) {
    errors.push('A branch cannot transfer stock to itself');
  }

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>(`/demand-orders/${kind}/${mode}s`, {
        date,
        fromBranchId,
        toBranchId,
        note: note || null,
        lines: validLines.map((l) => ({ pid: l.pid, qty: l.qty })),
      }),
    onSuccess: (result) => {
      toast.success(`${mode === 'order' ? 'Order' : 'Transfer'} #${result.id} created`);
      void queryClient.invalidateQueries({ queryKey: ['demand-orders', kind] });
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save'),
  });

  const update = (key: string, patch: Partial<InvoiceLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <>
      <PageHeader
        title={mode === 'order' ? `New ${KIND_LABEL[kind]} Order` : `New ${KIND_LABEL[kind]} Transfer`}
        subtitle={
          mode === 'order'
            ? 'Ask another branch to send stock — no ledger impact'
            : 'Commit to send stock — posts when despatched'
        }
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={onDone}>
              <X className="size-3.5" />
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={errors.length > 0 || save.isPending}
              onClick={() => save.mutate()}
            >
              <Save className="size-3.5" />
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      />

      <div className="card mb-3 grid gap-3 p-3 sm:grid-cols-4">
        <Field
          label="Date"
          name="date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />

        <div>
          <label htmlFor="from" className="field-label">
            From branch<span className="ml-0.5 text-red-500">*</span>
          </label>
          <select
            id="from"
            className="field-input"
            value={fromBranchId ?? ''}
            onChange={(e) => setFromBranchId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Select…</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="to" className="field-label">
            To branch<span className="ml-0.5 text-red-500">*</span>
          </label>
          <select
            id="to"
            className="field-input"
            value={toBranchId ?? ''}
            onChange={(e) => setToBranchId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Select…</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>

        <Field label="Note" name="note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      {/* Quantities only — a transfer is always valued at cost, server-side. */}
      <div className="card overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase">
              <th className="w-8 px-2 py-2 text-left">#</th>
              <th className="px-2 py-2 text-left">Item</th>
              <th className="w-32 px-2 py-2 text-right">Qty</th>
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={line.key} className="border-b border-slate-100 last:border-0">
                <td className="px-2 py-1 text-xs text-slate-400 tabular">{i + 1}</td>
                <td className="px-2 py-1">
                  <select
                    className="field-input py-1"
                    aria-label={`Item for line ${i + 1}`}
                    value={line.pid ?? ''}
                    onChange={(e) => {
                      const pid = Number(e.target.value);
                      const p = products.find((x) => x.id === pid);
                      update(line.key, { pid, pname: p?.name ?? '' });
                    }}
                  >
                    <option value="">Select an item…</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1">
                  <input
                    type="number"
                    step="any"
                    min="0"
                    className="field-input py-1 text-right tabular"
                    aria-label={`Quantity for line ${i + 1}`}
                    value={line.qty}
                    onChange={(e) => update(line.key, { qty: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    aria-label={`Remove line ${i + 1}`}
                    className="rounded-sm p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    onClick={() =>
                      setLines((ls) =>
                        ls.length === 1 ? [emptyLine()] : ls.filter((l) => l.key !== line.key),
                      )
                    }
                  >
                    <X className="size-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="border-t border-slate-200 px-2 py-1.5">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setLines((ls) => [...ls, emptyLine()])}
          >
            <Plus className="size-3.5" />
            Add item
          </button>
        </div>
      </div>

      {errors.length > 0 && (
        <div
          role="alert"
          className="card mt-3 flex gap-2 border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <ul className="space-y-0.5">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
