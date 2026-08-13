import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FlaskConical, Plus, Receipt, Save, Wrench, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { addMoney, fmtMoney, mulMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { Field, PageHeader } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface Job {
  id: number;
  doc_number: string;
  date: string;
  status: string | null;
  gross: string;
  note: string | null;
  customer_name: string | null;
  customer_phone: string | null;
}

interface FormData {
  customers: { id: number; name: string | null; phone: string | null }[];
  rawMaterials: { id: number; name: string | null; price: string }[];
  branches: { id: number; name: string }[];
}

// Lab Receiving now has its own form id (52/521); it previously shared 49/510
// with DO Finish Received. Lab Invoices is 50/520.
const PERM = {
  receiving: { formId: 52, create: 5212, edit: 5213 },
  invoices: { formId: 50, create: 5202 },
};

const STATUS_STYLE: Record<string, string> = {
  RECEIVED: 'bg-sky-100 text-sky-800',
  IN_PROGRESS: 'bg-amber-100 text-amber-800',
  READY: 'bg-indigo-100 text-indigo-800',
  INVOICED: 'bg-emerald-100 text-emerald-800',
};

const today = () => new Date().toISOString().slice(0, 10);

let counter = 0;
const newRow = () => ({ key: `lr-${++counter}`, pname: '', qty: '1', price: '0', detail: '' });
const newMat = () => ({ key: `lm-${++counter}`, pid: null as number | null, qty: '1' });

/**
 * Lab — battery repair and servicing.
 *
 * The legacy Lab Invoice screen was a stub with no save action, so this
 * workflow was designed rather than ported. See api/src/modules/lab/service.ts
 * for the reasoning.
 */
export function LabPage() {
  const { hasAction } = useAuth();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [composing, setComposing] = useState(false);
  const [working, setWorking] = useState<Job | null>(null);
  const [invoicing, setInvoicing] = useState<Job | null>(null);

  const jobs = useQuery({
    queryKey: ['lab', 'jobs', page],
    queryFn: () => api.get<Paged<Job>>(`/lab/jobs?page=${page}&pageSize=20`),
    enabled: !composing,
  });

  const markReady = useMutation({
    mutationFn: (job: Job) => api.post(`/lab/jobs/${job.id}/ready`),
    onSuccess: () => {
      toast.success('Marked ready for collection');
      void queryClient.invalidateQueries({ queryKey: ['lab'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not update'),
  });

  const columns: readonly Column<Job>[] = [
    { key: 'doc_number', header: 'Job', width: '6rem' },
    { key: 'date', header: 'Date', width: '7.5rem' },
    { key: 'customer_name', header: 'Customer', cell: (r) => r.customer_name ?? '—' },
    { key: 'customer_phone', header: 'Phone', width: '9rem', cell: (r) => r.customer_phone ?? '—' },
    { key: 'gross', header: 'Quoted', numeric: true, cell: (r) => fmtMoney(r.gross) },
    {
      key: 'status',
      header: 'Status',
      width: '8.5rem',
      cell: (r) => (
        <span
          className={cn(
            'rounded-sm px-1.5 py-0.5 text-xs font-medium',
            STATUS_STYLE[r.status ?? ''] ?? 'bg-slate-100 text-slate-600',
          )}
        >
          {r.status?.replace('_', ' ') ?? '—'}
        </span>
      ),
    },
  ];

  if (composing) return <IntakeComposer onDone={() => setComposing(false)} />;

  return (
    <>
      <PageHeader
        title="Lab"
        subtitle="Battery repair and servicing"
        actions={
          hasAction(PERM.receiving.formId, PERM.receiving.create) && (
            <button type="button" className="btn-primary" onClick={() => setComposing(true)}>
              <Plus className="size-3.5" />
              Receive Items
            </button>
          )
        }
      />

      <DataTable
        columns={columns}
        rows={jobs.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={jobs.isPending}
        error={jobs.error ? (jobs.error as Error).message : null}
        emptyMessage="No lab jobs yet"
        actions={(row) =>
          row.status === 'INVOICED' ? null : (
            <div className="flex justify-end gap-1">
              {hasAction(PERM.receiving.formId, PERM.receiving.edit) && (
                <>
                  <button
                    type="button"
                    title="Record materials used"
                    className="rounded-sm p-1.5 text-slate-500 hover:bg-amber-50 hover:text-amber-700"
                    onClick={() => setWorking(row)}
                  >
                    <Wrench className="size-3.5" />
                  </button>
                  {row.status !== 'READY' && (
                    <button
                      type="button"
                      title="Mark ready for collection"
                      className="rounded-sm p-1.5 text-slate-500 hover:bg-indigo-50 hover:text-indigo-700"
                      onClick={() => markReady.mutate(row)}
                    >
                      <CheckCircle2 className="size-3.5" />
                    </button>
                  )}
                </>
              )}
              {hasAction(PERM.invoices.formId, PERM.invoices.create) && (
                <button
                  type="button"
                  title="Invoice this job"
                  className="rounded-sm p-1.5 text-slate-500 hover:bg-emerald-50 hover:text-emerald-700"
                  onClick={() => setInvoicing(row)}
                >
                  <Receipt className="size-3.5" />
                </button>
              )}
            </div>
          )
        }
      />

      {jobs.data && (
        <Pagination
          page={jobs.data.page}
          pageSize={jobs.data.pageSize}
          total={jobs.data.total}
          onPageChange={setPage}
        />
      )}

      <MaterialsDialog job={working} onClose={() => setWorking(null)} />
      <InvoiceDialog job={invoicing} onClose={() => setInvoicing(null)} />
    </>
  );
}

function MaterialsDialog({ job, onClose }: { job: Job | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState([newMat()]);

  const formData = useQuery({
    queryKey: ['lab', 'form-data'],
    queryFn: () => api.get<FormData>('/lab/form-data'),
  });

  const valid = rows.filter((r) => r.pid !== null && Number(r.qty) > 0);

  const cost = valid.reduce((acc, r) => {
    const m = formData.data?.rawMaterials.find((x) => x.id === r.pid);
    return m ? addMoney(acc, mulMoney(r.qty, m.price)) : acc;
  }, '0.00');

  const save = useMutation({
    mutationFn: () =>
      api.post(`/lab/jobs/${job?.id}/materials`, {
        date: today(),
        lines: valid.map((r) => ({ pid: r.pid, qty: r.qty })),
      }),
    onSuccess: () => {
      toast.success('Materials recorded — stock reduced');
      void queryClient.invalidateQueries({ queryKey: ['lab'] });
      onClose();
      setRows([newMat()]);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save'),
  });

  return (
    <Modal
      open={job !== null}
      title={`Materials used — job #${job?.id ?? ''}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={valid.length === 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            <Save className="size-3.5" />
            {save.isPending ? 'Saving…' : `Record ${fmtMoney(cost)}`}
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600">
        Raw materials consumed repairing this battery. Costed from the catalog and taken out of
        stock.
      </p>

      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={r.key} className="flex gap-2">
            <select
              className="field-input flex-1"
              aria-label={`Material ${i + 1}`}
              value={r.pid ?? ''}
              onChange={(e) =>
                setRows((rs) =>
                  rs.map((x) =>
                    x.key === r.key
                      ? { ...x, pid: e.target.value ? Number(e.target.value) : null }
                      : x,
                  ),
                )
              }
            >
              <option value="">Select a material…</option>
              {formData.data?.rawMaterials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>

            <input
              type="number"
              step="any"
              min="0"
              className="field-input w-24 text-right tabular"
              aria-label={`Quantity ${i + 1}`}
              value={r.qty}
              onChange={(e) =>
                setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, qty: e.target.value } : x)))
              }
            />

            <button
              type="button"
              aria-label={`Remove material ${i + 1}`}
              className="rounded-sm p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
              onClick={() =>
                setRows((rs) => (rs.length === 1 ? [newMat()] : rs.filter((x) => x.key !== r.key)))
              }
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="btn-secondary mt-3"
        onClick={() => setRows((rs) => [...rs, newMat()])}
      >
        <Plus className="size-3.5" />
        Add material
      </button>
    </Modal>
  );
}

function InvoiceDialog({ job, onClose }: { job: Job | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [received, setReceived] = useState('0');

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: number; net: string }>('/lab/invoices', {
        labReceivedId: job?.id,
        date: today(),
        received,
      }),
    onSuccess: (r) => {
      toast.success(`Lab invoice #${r.id} raised for ${fmtMoney(r.net)}`);
      void queryClient.invalidateQueries({ queryKey: ['lab'] });
      onClose();
      setReceived('0');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not invoice'),
  });

  return (
    <Modal
      open={job !== null}
      title={`Invoice job #${job?.id ?? ''}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            <FlaskConical className="size-3.5" />
            {save.isPending ? 'Invoicing…' : 'Raise Invoice'}
          </button>
        </>
      }
    >
      {job && (
        <>
          <p className="mb-3 text-sm text-slate-600">
            Billing <strong>{job.customer_name}</strong> the quoted{' '}
            <strong className="tabular">{fmtMoney(job.gross)}</strong>. Booked as service income,
            not a product sale.
          </p>

          <Field
            label="Received now"
            name="received"
            type="number"
            step="any"
            min="0"
            value={received}
            onChange={(e) => setReceived(e.target.value)}
            hint="Anything unpaid stays on the customer's account."
          />
        </>
      )}
    </Modal>
  );
}

function IntakeComposer({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [date, setDate] = useState(today());
  const [custId, setCustId] = useState<number | null>(null);
  const [branchId, setBranchId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [rows, setRows] = useState([newRow()]);

  const needsBranch = user?.isSuperAdmin ?? false;

  const formData = useQuery({
    queryKey: ['lab', 'form-data'],
    queryFn: () => api.get<FormData>('/lab/form-data'),
  });

  const valid = rows.filter((r) => r.pname.trim() && Number(r.qty) > 0);
  const quoted = valid.reduce((acc, r) => addMoney(acc, mulMoney(r.qty, r.price)), '0.00');

  const errors: string[] = [];
  if (valid.length === 0) errors.push('Describe at least one item received');
  if (custId === null) errors.push('Choose the customer');
  if (needsBranch && branchId === null) errors.push('Select a branch');

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>('/lab/jobs', {
        date,
        custId,
        ...(branchId !== null ? { branchId } : {}),
        note: note || null,
        lines: valid.map((r) => ({
          pname: r.pname,
          qty: r.qty,
          price: r.price,
          detail: r.detail || null,
        })),
      }),
    onSuccess: (r) => {
      toast.success(`Lab job #${r.id} created`);
      void queryClient.invalidateQueries({ queryKey: ['lab'] });
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save'),
  });

  const update = (key: string, patch: Record<string, string>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <>
      <PageHeader
        title="Receive Items for Repair"
        subtitle="The customer's own batteries — no ledger impact until invoiced"
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

      <div className={cn('card mb-3 grid gap-3 p-3', needsBranch ? 'sm:grid-cols-4' : 'sm:grid-cols-3')}>
        <Field
          label="Date"
          name="date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />

        <div>
          <label htmlFor="customer" className="field-label">
            Customer<span className="ml-0.5 text-red-500">*</span>
          </label>
          <select
            id="customer"
            className="field-input"
            value={custId ?? ''}
            onChange={(e) => setCustId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Select…</option>
            {formData.data?.customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.phone ? ` — ${c.phone}` : ''}
              </option>
            ))}
          </select>
        </div>

        {needsBranch && (
          <div>
            <label htmlFor="branch" className="field-label">
              Branch<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              id="branch"
              className="field-input"
              value={branchId ?? ''}
              onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select…</option>
              {formData.data?.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <Field label="Note" name="note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase">
              <th className="w-8 px-2 py-2 text-left">#</th>
              <th className="px-2 py-2 text-left">Item received</th>
              <th className="px-2 py-2 text-left">Fault / notes</th>
              <th className="w-20 px-2 py-2 text-right">Qty</th>
              <th className="w-28 px-2 py-2 text-right">Quoted</th>
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key} className="border-b border-slate-100 last:border-0">
                <td className="px-2 py-1 text-xs text-slate-400 tabular">{i + 1}</td>
                <td className="px-2 py-1">
                  <input
                    className="field-input py-1"
                    aria-label={`Item ${i + 1}`}
                    placeholder="e.g. Exide 150Ah, serial 88213"
                    value={r.pname}
                    onChange={(e) => update(r.key, { pname: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    className="field-input py-1"
                    aria-label={`Fault ${i + 1}`}
                    placeholder="e.g. not holding charge"
                    value={r.detail}
                    onChange={(e) => update(r.key, { detail: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    type="number"
                    step="any"
                    min="0"
                    className="field-input py-1 text-right tabular"
                    aria-label={`Quantity ${i + 1}`}
                    value={r.qty}
                    onChange={(e) => update(r.key, { qty: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    type="number"
                    step="any"
                    min="0"
                    className="field-input py-1 text-right tabular"
                    aria-label={`Quoted price ${i + 1}`}
                    value={r.price}
                    onChange={(e) => update(r.key, { price: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    aria-label={`Remove item ${i + 1}`}
                    className="rounded-sm p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    onClick={() =>
                      setRows((rs) => (rs.length === 1 ? [newRow()] : rs.filter((x) => x.key !== r.key)))
                    }
                  >
                    <X className="size-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
              <td colSpan={4} className="px-2 py-1.5">
                Quoted total
              </td>
              <td className="px-2 py-1.5 text-right tabular">{fmtMoney(quoted)}</td>
              <td />
            </tr>
          </tfoot>
        </table>

        <div className="border-t border-slate-200 px-2 py-1.5">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setRows((rs) => [...rs, newRow()])}
          >
            <Plus className="size-3.5" />
            Add item
          </button>
        </div>
      </div>

      {errors.length > 0 && (
        <div
          role="alert"
          className="card mt-3 border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
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
