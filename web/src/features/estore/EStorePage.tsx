/**
 * E-Store shipments — the Queue pattern (DESIGN §5).
 *
 * The website takes the order and the E-Store manager routes it to a branch near
 * the customer. That branch ships and records it here; the warehouse admin
 * accepts, and only then does the branch's balance move.
 *
 * This is NOT a branch sale. No branch revenue, no branch profit, nothing in the
 * branch day book — for the branch it is one less battery on the shelf, and its
 * dues fall by the wholesale value it was charged (PRINCIPLES §7).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { Field, PageHeader } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { StatusPill } from '@/components/ui/StatusPill';

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface ShipmentRow {
  id: number;
  doc_number: string;
  order_reference: string;
  date: string;
  status: string;
  customer_name: string | null;
  branch_name: string | null;
}

interface Option {
  id: number;
  name: string | null;
}

interface FormData {
  products: Option[];
  branches: Array<Option & { type: string }>;
  defaultBranchId: number | null;
}

/** Form 58 / code 513. */
const PERM = { formId: 58, view: 5131, create: 5132, edit: 5133 };

const today = () => new Date().toISOString().slice(0, 10);
const TABS = ['ALL', 'RAISED', 'ACCEPTED', 'REJECTED'] as const;
type Tab = (typeof TABS)[number];

export function EStorePage() {
  const { hasAction, user } = useAuth();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<Tab>('ALL');
  const [recording, setRecording] = useState(false);
  const [rejectingId, setRejectingId] = useState<number | null>(null);

  const form = useQuery({
    queryKey: ['estore', 'form-data'],
    queryFn: () => api.get<FormData>('/estore/form-data'),
  });

  const list = useQuery({
    queryKey: ['estore', page],
    queryFn: () => api.get<Paged<ShipmentRow>>(`/estore?page=${page}&pageSize=20`),
  });

  const rows = useMemo(() => {
    const all = list.data?.rows ?? [];
    return tab === 'ALL' ? all : all.filter((r) => r.status === tab);
  }, [list.data, tab]);

  const counts = useMemo(() => {
    const all = list.data?.rows ?? [];
    return {
      ALL: all.length,
      RAISED: all.filter((r) => r.status === 'RAISED').length,
      ACCEPTED: all.filter((r) => r.status === 'ACCEPTED').length,
      REJECTED: all.filter((r) => r.status === 'REJECTED').length,
    } satisfies Record<Tab, number>;
  }, [list.data]);

  const accept = useMutation({
    mutationFn: (id: number) => api.post(`/estore/${id}/accept`),
    onSuccess: () => {
      toast.success('Shipment accepted — the branch’s dues have fallen');
      void queryClient.invalidateQueries({ queryKey: ['estore'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not accept the shipment'),
  });

  const columns: readonly Column<ShipmentRow>[] = [
    { key: 'doc_number', header: 'No.', width: '8rem' },
    { key: 'order_reference', header: 'Order ref.', width: '9rem' },
    { key: 'date', header: 'Date', width: '7.5rem' },
    { key: 'branch_name', header: 'Shipped by', cell: (r) => r.branch_name ?? '—' },
    { key: 'customer_name', header: 'Customer', cell: (r) => r.customer_name ?? '—' },
    {
      key: 'status',
      header: 'Status',
      width: '8rem',
      cell: (r) => <StatusPill status={r.status} />,
    },
  ];

  const canCreate = hasAction(PERM.formId, PERM.create);
  // Only the warehouse admin accepts — nothing settles on the branch's word alone.
  const canDecide = hasAction(PERM.formId, PERM.edit) && (user?.isSuperAdmin ?? false);

  return (
    <>
      <PageHeader
        title="E-Store"
        subtitle="Website orders shipped by a branch, accepted by the warehouse. Not a branch sale."
        actions={
          canCreate && (
            <button type="button" className="btn-primary" onClick={() => setRecording(true)}>
              <Plus className="size-3.5" />
              Record Shipment
            </button>
          )
        }
      />

      <div className="mb-3 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px border-b-2 px-3 py-1.5 text-sm font-medium transition',
              tab === t
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {t === 'ALL' ? 'All' : t.charAt(0) + t.slice(1).toLowerCase()}
            <span className="ml-1.5 text-xs text-slate-400 tabular">{counts[t]}</span>
          </button>
        ))}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.error ? (list.error as Error).message : null}
        emptyMessage="No E-Store shipments yet"
        actions={
          canDecide
            ? (row) =>
                row.status === 'RAISED' ? (
                  <div className="flex gap-0.5">
                    <button
                      type="button"
                      title="Accept — the branch’s dues fall by the wholesale value"
                      className="rounded-sm p-1.5 text-slate-500 hover:bg-emerald-50 hover:text-[var(--color-status-good)]"
                      onClick={() => accept.mutate(row.id)}
                    >
                      <Check className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Reject — the stock returns to the branch"
                      className="rounded-sm p-1.5 text-slate-500 hover:bg-red-50 hover:text-[var(--color-status-critical)]"
                      onClick={() => setRejectingId(row.id)}
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ) : undefined
            : undefined
        }
      />

      {list.data && (
        <Pagination
          page={list.data.page}
          pageSize={list.data.pageSize}
          total={list.data.total}
          onPageChange={setPage}
        />
      )}

      {recording && form.data && (
        <RecordShipmentModal
          form={form.data}
          isSuper={user?.isSuperAdmin ?? false}
          onClose={() => setRecording(false)}
          onSaved={() => {
            setRecording(false);
            void queryClient.invalidateQueries({ queryKey: ['estore'] });
          }}
        />
      )}

      {rejectingId !== null && (
        <RejectModal
          shipmentId={rejectingId}
          onClose={() => setRejectingId(null)}
          onSaved={() => {
            setRejectingId(null);
            void queryClient.invalidateQueries({ queryKey: ['estore'] });
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function RecordShipmentModal({
  form,
  isSuper,
  onClose,
  onSaved,
}: {
  form: FormData;
  isSuper: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [orderReference, setOrderReference] = useState('');
  const [branchId, setBranchId] = useState<number | null>(form.defaultBranchId);
  const [date, setDate] = useState(today());
  const [customerName, setCustomerName] = useState('');
  const [shippingAddress, setShippingAddress] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Array<{ productId: number | null; qty: string }>>([
    { productId: null, qty: '1' },
  ]);

  const save = useMutation({
    mutationFn: () =>
      api.post('/estore', {
        orderReference: orderReference.trim(),
        branchId,
        date,
        customerName: customerName || null,
        shippingAddress: shippingAddress || null,
        note: note || null,
        lines: lines
          .filter((l) => l.productId !== null && Number(l.qty) > 0)
          .map((l) => ({ productId: l.productId, qty: l.qty })),
      }),
    onSuccess: () => {
      toast.success('Shipment recorded — stock has left the branch');
      onSaved();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the shipment'),
  });

  const valid =
    orderReference.trim().length > 0 &&
    branchId !== null &&
    lines.some((l) => l.productId !== null && Number(l.qty) > 0);

  return (
    <Modal
      open
      title="Record E-Store Shipment"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
          >
            <Save className="size-3.5" />
            Record
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Stock leaves the branch the moment this is recorded, because the battery physically leaves.
          The branch&rsquo;s dues fall only once the warehouse accepts it.
        </p>

        <Field
          label="Order reference"
          name="orderReference"
          required
          value={orderReference}
          onChange={(e) => setOrderReference(e.target.value)}
        />

        {isSuper && (
          <div>
            <label htmlFor="shipBranch" className="field-label">
              Shipping branch<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              id="shipBranch"
              className="field-input"
              value={branchId ?? ''}
              onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select a branch…</option>
              {form.branches
                .filter((b) => b.type !== 'WAREHOUSE')
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>
          </div>
        )}

        <Field label="Date" name="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        <Field
          label="Customer"
          name="customerName"
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
        />
        <Field
          label="Shipping address"
          name="shippingAddress"
          value={shippingAddress}
          onChange={(e) => setShippingAddress(e.target.value)}
        />

        <div className="space-y-1.5">
          <p className="field-label">Lines</p>
          {lines.map((line, i) => (
            <div key={i} className="flex gap-1.5">
              <select
                className="field-input flex-1"
                aria-label="Model"
                value={line.productId ?? ''}
                onChange={(e) =>
                  setLines(
                    lines.map((l, idx) =>
                      idx === i ? { ...l, productId: e.target.value ? Number(e.target.value) : null } : l,
                    ),
                  )
                }
              >
                <option value="">Select a model…</option>
                {form.products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                className="field-input w-20 text-right"
                type="number"
                min="0"
                step="any"
                aria-label="Quantity"
                value={line.qty}
                onChange={(e) => setLines(lines.map((l, idx) => (idx === i ? { ...l, qty: e.target.value } : l)))}
              />
              <button
                type="button"
                aria-label="Remove line"
                disabled={lines.length === 1}
                className="rounded-sm p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                onClick={() => setLines(lines.filter((_, idx) => idx !== i))}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setLines([...lines, { productId: null, qty: '1' }])}
          >
            <Plus className="size-3.5" />
            Add line
          </button>
        </div>

        <Field label="Note" name="note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Reject always asks for a reason (DESIGN §5, "Queue").
// ---------------------------------------------------------------------------

function RejectModal({
  shipmentId,
  onClose,
  onSaved,
}: {
  shipmentId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState('');

  const reject = useMutation({
    mutationFn: () => api.post(`/estore/${shipmentId}/reject`, { reason: reason.trim() }),
    onSuccess: () => {
      toast.success('Shipment rejected — the stock has returned to the branch');
      onSaved();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not reject the shipment'),
  });

  return (
    <Modal
      open
      title="Reject Shipment"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={reason.trim().length === 0 || reject.isPending}
            onClick={() => reject.mutate()}
          >
            Reject
          </button>
        </>
      }
    >
      <Field
        label="Reason"
        name="reason"
        required
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <p className="mt-2 text-xs text-slate-500">
        Rejecting returns the stock to the branch. The reason is recorded against the shipment.
      </p>
    </Modal>
  );
}
