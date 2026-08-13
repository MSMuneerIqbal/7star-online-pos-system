import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/money';
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

interface Worker {
  id: number;
  name: string;
  phone: string | null;
  is_active: boolean;
}

interface Issue {
  id: number;
  doc_number: string;
  date: string;
  status: string;
  note: string | null;
  worker_name: string | null;
}

interface IssueDetail {
  id: number;
  pid: number;
  pname: string | null;
  qty: string;
  price: string;
  total: string;
  status: string;
}

interface FormData {
  workers: { id: number; name: string }[];
  rawMaterials: { id: number; name: string | null; price: string }[];
  products: { id: number; name: string | null }[];
}

interface DamagedRow {
  id: number;
  date: string;
  kind: string;
  pname: string | null;
  qty: string;
  value: string;
  reason: string | null;
  status: string;
  worker_name: string | null;
}

interface ReworkRow {
  id: number;
  date: string;
  qty: string;
  note: string | null;
  status: string;
  worker_name: string | null;
  product_name: string | null;
}

interface ReportRow {
  id: number;
  name: string;
  active: boolean;
  pieces: string;
  damagedQty: string;
  damagedValue: string;
}

// Legacy form 47 / form code 1001.
const PERM = { formId: 47, create: 10012, edit: 10013 };

const today = () => new Date().toISOString().slice(0, 10);

let counter = 0;
const newLine = () => ({ key: `p${++counter}`, pid: null as number | null, qty: '1' });

type Tab = 'issues' | 'workers' | 'damaged' | 'rework' | 'report';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'issues', label: 'Issues' },
  { id: 'workers', label: 'Workers' },
  { id: 'damaged', label: 'Damaged' },
  { id: 'rework', label: 'Rework' },
  { id: 'report', label: 'Report' },
];

export function ProductionPage() {
  const { hasAction } = useAuth();

  const [tab, setTab] = useState<Tab>('issues');
  const [page, setPage] = useState(1);

  const canCreate = hasAction(PERM.formId, PERM.create);
  const canEdit = hasAction(PERM.formId, PERM.edit);

  return (
    <>
      <PageHeader title="Production" subtitle="Issue raw parts to a worker, record the batteries that come back" />

      <div className="no-print mb-3 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTab(t.id);
              setPage(1);
            }}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm transition',
              tab === t.id
                ? 'border-brand-600 font-medium text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'issues' && <IssuesTab page={page} setPage={setPage} canCreate={canCreate} canEdit={canEdit} />}
      {tab === 'workers' && <WorkersTab canCreate={canCreate} canEdit={canEdit} />}
      {tab === 'damaged' && <DamagedTab page={page} setPage={setPage} canEdit={canEdit} />}
      {tab === 'rework' && <ReworkTab page={page} setPage={setPage} canEdit={canEdit} />}
      {tab === 'report' && <ReportTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function IssuesTab({
  page,
  setPage,
  canCreate,
  canEdit,
}: {
  page: number;
  setPage: (n: number) => void;
  canCreate: boolean;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [composing, setComposing] = useState(false);
  const [outputting, setOutputting] = useState<Issue | null>(null);

  const list = useQuery({
    queryKey: ['production', 'issues', page],
    queryFn: () => api.get<Paged<Issue>>(`/production/issues?page=${page}&pageSize=20`),
    enabled: !composing && outputting === null,
  });

  const columns: readonly Column<Issue>[] = [
    { key: 'doc_number', header: 'No.', width: '7rem' },
    { key: 'date', header: 'Date', width: '7.5rem' },
    { key: 'worker_name', header: 'Worker', cell: (r) => r.worker_name ?? '—' },
    {
      key: 'status',
      header: 'Status',
      width: '7rem',
      cell: (r) => (
        <span
          className={cn(
            'rounded-sm px-1.5 py-0.5 text-xs font-medium',
            r.status === 'OPEN' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800',
          )}
        >
          {r.status}
        </span>
      ),
    },
    { key: 'note', header: 'Note', cell: (r) => r.note ?? '—' },
  ];

  return (
    <>
      <div className="mb-3 flex justify-end">
        {canCreate && (
          <button type="button" className="btn-primary" onClick={() => setComposing(true)}>
            <Plus className="size-3.5" />
            New Issue
          </button>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.error ? (list.error as Error).message : null}
        emptyMessage="No issues yet"
        actions={
          canEdit
            ? (row) =>
                row.status === 'OPEN' ? (
                  <button
                    type="button"
                    title="Record output"
                    className="rounded-sm px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-brand-600"
                    onClick={() => setOutputting(row)}
                  >
                    <CheckCircle2 className="size-3.5" />
                    Output
                  </button>
                ) : undefined
            : undefined
        }
      />

      {list.data && (
        <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPageChange={setPage} />
      )}

      {composing && (
        <IssueComposer
          onClose={() => setComposing(false)}
          onDone={() => {
            setComposing(false);
            void queryClient.invalidateQueries({ queryKey: ['production'] });
          }}
        />
      )}
      {outputting && (
        <OutputDialog
          issue={outputting}
          onClose={() => setOutputting(null)}
          onDone={() => {
            setOutputting(null);
            void queryClient.invalidateQueries({ queryKey: ['production'] });
          }}
        />
      )}
    </>
  );
}

function IssueComposer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const [date, setDate] = useState(today());
  const [workerId, setWorkerId] = useState<number | null>(null);
  const [branchId, setBranchId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([newLine()]);

  const formData = useQuery({
    queryKey: ['production', 'form-data'],
    queryFn: () => api.get<FormData>('/production/form-data'),
  });

  const branches = useQuery({
    queryKey: ['branches', 'options'],
    queryFn: () => api.get<{ rows: { id: number; name: string }[] }>('/branches?pageSize=200'),
    enabled: user?.isSuperAdmin ?? false,
  });

  const needsBranch = user?.isSuperAdmin ?? false;

  const save = useMutation({
    mutationFn: () =>
      api.post('/production/issues', {
        date,
        workerId,
        ...(branchId !== null ? { branchId } : {}),
        note: note || null,
        lines: lines.filter((l) => l.pid !== null && Number(l.qty) > 0).map((l) => ({ pid: l.pid, qty: l.qty })),
      }),
    onSuccess: () => {
      toast.success('Issue created');
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not create the issue'),
  });

  const update = (key: string, patch: Partial<ReturnType<typeof newLine>>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const valid = lines.some((l) => l.pid !== null && Number(l.qty) > 0);

  return (
    <Modal
      open
      title="New Issue"
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
            disabled={workerId === null || !valid || (needsBranch && branchId === null) || save.isPending}
            onClick={() => save.mutate()}
          >
            <Save className="size-3.5" />
            Issue cart
          </button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date" name="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />

        <div>
          <label htmlFor="worker" className="field-label">
            Worker<span className="ml-0.5 text-red-500">*</span>
          </label>
          <select
            id="worker"
            className="field-input"
            value={workerId ?? ''}
            onChange={(e) => setWorkerId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Select…</option>
            {formData.data?.workers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
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
              {branches.data?.rows.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="sm:col-span-2">
          <Field label="Note" name="note" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>

      <div className="mt-3 overflow-x-auto rounded-md border border-slate-200">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase">
              <th className="px-2 py-2 text-left">Part</th>
              <th className="w-32 px-2 py-2 text-right">Qty</th>
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={line.key} className="border-b border-slate-100 last:border-0">
                <td className="px-2 py-1">
                  <select
                    className="field-input py-1"
                    aria-label={`Part for line ${i + 1}`}
                    value={line.pid ?? ''}
                    onChange={(e) => update(line.key, { pid: Number(e.target.value) })}
                  >
                    <option value="">Select a part…</option>
                    {formData.data?.rawMaterials.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
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
                    onClick={() => setLines((ls) => (ls.length === 1 ? [newLine()] : ls.filter((l) => l.key !== line.key)))}
                  >
                    <X className="size-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-slate-200 px-2 py-1.5">
          <button type="button" className="btn-secondary" onClick={() => setLines((ls) => [...ls, newLine()])}>
            <Plus className="size-3.5" />
            Add part
          </button>
        </div>
      </div>
    </Modal>
  );
}

function OutputDialog({ issue, onClose, onDone }: { issue: Issue; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(today());
  const [productId, setProductId] = useState<number | null>(null);
  const [qty, setQty] = useState('1');
  const [damaged, setDamaged] = useState([{ key: `d${++counter}`, pid: null as number | null, qty: '1', reason: '' }]);

  const detail = useQuery({
    queryKey: ['production', 'issues', issue.id],
    queryFn: () => api.get<IssueDetail & { lines: IssueDetail[] }>(`/production/issues/${issue.id}`),
  });

  const formData = useQuery({
    queryKey: ['production', 'form-data'],
    queryFn: () => api.get<FormData>('/production/form-data'),
  });

  const save = useMutation({
    mutationFn: () =>
      api.post(`/production/issues/${issue.id}/output`, {
        date,
        productId,
        qty,
        damaged: damaged
          .filter((d) => d.pid !== null && Number(d.qty) > 0)
          .map((d) => ({ pid: d.pid, qty: d.qty, reason: d.reason || null })),
      }),
    onSuccess: () => {
      toast.success('Output recorded');
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record output'),
  });

  const parts = detail.data?.lines ?? [];
  const hasDamaged = damaged.some((d) => d.pid !== null && Number(d.qty) > 0);

  return (
    <Modal
      open
      title={`Record output — ${issue.doc_number}`}
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
            disabled={productId === null || Number(qty) < 1 || save.isPending}
            onClick={() => save.mutate()}
          >
            <Save className="size-3.5" />
            Record
          </button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date" name="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />

        <div>
          <label htmlFor="product" className="field-label">
            Battery made<span className="ml-0.5 text-red-500">*</span>
          </label>
          <select
            id="product"
            className="field-input"
            value={productId ?? ''}
            onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Select…</option>
            {formData.data?.products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <Field
          label="Ready batteries"
          name="qty"
          type="number"
          min="1"
          required
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />
      </div>

      <div className="mt-3">
        <p className="mb-1 text-xs font-medium text-slate-600">Damaged parts (optional)</p>
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase">
                <th className="px-2 py-2 text-left">Part</th>
                <th className="w-24 px-2 py-2 text-right">Qty</th>
                <th className="px-2 py-2 text-left">Reason</th>
                <th className="w-10 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {damaged.map((d, i) => (
                <tr key={d.key} className="border-b border-slate-100 last:border-0">
                  <td className="px-2 py-1">
                    <select
                      className="field-input py-1"
                      aria-label={`Damaged part ${i + 1}`}
                      value={d.pid ?? ''}
                      onChange={(e) =>
                        setDamaged((ds) => ds.map((x) => (x.key === d.key ? { ...x, pid: Number(e.target.value) } : x)))
                      }
                    >
                      <option value="">Select…</option>
                      {parts.map((p) => (
                        <option key={p.id} value={p.pid}>
                          {p.pname}
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
                      aria-label={`Damaged quantity ${i + 1}`}
                      value={d.qty}
                      onChange={(e) =>
                        setDamaged((ds) => ds.map((x) => (x.key === d.key ? { ...x, qty: e.target.value } : x)))
                      }
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      className="field-input py-1"
                      aria-label={`Reason ${i + 1}`}
                      value={d.reason}
                      onChange={(e) =>
                        setDamaged((ds) => ds.map((x) => (x.key === d.key ? { ...x, reason: e.target.value } : x)))
                      }
                    />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      aria-label={`Remove damaged ${i + 1}`}
                      className="rounded-sm p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      onClick={() =>
                        setDamaged((ds) =>
                          ds.length === 1 ? [{ key: `d${++counter}`, pid: null, qty: '1', reason: '' }] : ds.filter((x) => x.key !== d.key),
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
              onClick={() => setDamaged((ds) => [...ds, { key: `d${++counter}`, pid: null, qty: '1', reason: '' }])}
            >
              <Plus className="size-3.5" />
              Add damaged part
            </button>
          </div>
        </div>
      </div>

      {hasDamaged && (
        <p className="mt-2 text-xs text-slate-500">
          Damaged parts are recorded, not charged — their cost is absorbed into the ready batteries.
        </p>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

function WorkersTab({ canCreate, canEdit }: { canCreate: boolean; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Worker | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', isActive: true });

  const list = useQuery({
    queryKey: ['production', 'workers'],
    queryFn: () => api.get<Paged<Worker>>('/production/workers?pageSize=200'),
  });

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api.put(`/production/workers/${editing.id}`, form)
        : api.post('/production/workers', form),
    onSuccess: () => {
      toast.success(editing ? 'Worker updated' : 'Worker created');
      void queryClient.invalidateQueries({ queryKey: ['production', 'workers'] });
      setCreating(false);
      setEditing(null);
      setForm({ name: '', phone: '', isActive: true });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save worker'),
  });

  const columns: readonly Column<Worker>[] = [
    { key: 'id', header: 'ID', numeric: true, width: '4rem' },
    { key: 'name', header: 'Name' },
    { key: 'phone', header: 'Phone', cell: (r) => r.phone ?? '—' },
    {
      key: 'is_active',
      header: 'Status',
      width: '7rem',
      cell: (r) => (
        <span
          className={cn(
            'rounded-sm px-1.5 py-0.5 text-xs font-medium',
            r.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600',
          )}
        >
          {r.is_active ? 'Active' : 'Inactive'}
        </span>
      ),
    },
  ];

  const open = (w: Worker | null) => {
    setEditing(w);
    setCreating(w === null);
    setForm({ name: w?.name ?? '', phone: w?.phone ?? '', isActive: w?.is_active ?? true });
  };

  return (
    <>
      <div className="mb-3 flex justify-end">
        {canCreate && (
          <button type="button" className="btn-primary" onClick={() => open(null)}>
            <Plus className="size-3.5" />
            New Worker
          </button>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.error ? (list.error as Error).message : null}
        emptyMessage="No workers yet"
        actions={
          canEdit
            ? (row) => (
                <button
                  type="button"
                  title="Edit"
                  className="rounded-sm p-1.5 text-slate-500 hover:bg-slate-100 hover:text-brand-600"
                  onClick={() => open(row)}
                >
                  <CheckCircle2 className="size-3.5" />
                </button>
              )
            : undefined
        }
      />

      <Modal
        open={creating || editing !== null}
        title={editing ? 'Edit worker' : 'New worker'}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setCreating(false);
                setEditing(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!form.name.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              Save
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <Field
            label="Name"
            name="name"
            required
            autoFocus
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Field label="Phone" name="phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <label className="flex items-center gap-2 py-1 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              className="rounded-sm border-slate-300"
            />
            Active
          </label>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Damaged stock
// ---------------------------------------------------------------------------

function DamagedTab({ page, setPage, canEdit }: { page: number; setPage: (n: number) => void; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState(today());
  const [productId, setProductId] = useState<number | null>(null);
  const [qty, setQty] = useState('1');
  const [workerId, setWorkerId] = useState<number | null>(null);
  const [reason, setReason] = useState('');

  const list = useQuery({
    queryKey: ['production', 'damaged', page],
    queryFn: () => api.get<Paged<DamagedRow>>(`/production/damaged-stock?page=${page}&pageSize=20`),
    enabled: !adding,
  });

  const formData = useQuery({
    queryKey: ['production', 'form-data'],
    queryFn: () => api.get<FormData>('/production/form-data'),
    enabled: adding,
  });

  const save = useMutation({
    mutationFn: () =>
      api.post('/production/damaged-batteries', {
        date,
        productId,
        qty,
        workerId,
        reason: reason || null,
      }),
    onSuccess: () => {
      toast.success('Damage recorded');
      void queryClient.invalidateQueries({ queryKey: ['production', 'damaged'] });
      setAdding(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record damage'),
  });

  const columns: readonly Column<DamagedRow>[] = [
    { key: 'id', header: 'ID', numeric: true, width: '4rem' },
    { key: 'date', header: 'Date', width: '7.5rem' },
    { key: 'pname', header: 'Item', cell: (r) => r.pname ?? '—' },
    {
      key: 'kind',
      header: 'Kind',
      width: '6rem',
      cell: (r) => (r.kind === 'BATTERY' ? 'Battery' : 'Part'),
    },
    { key: 'qty', header: 'Qty', numeric: true, width: '6rem' },
    { key: 'value', header: 'Value', numeric: true, cell: (r) => fmtMoney(r.value) },
    { key: 'worker_name', header: 'Worker', cell: (r) => r.worker_name ?? '—' },
    { key: 'reason', header: 'Reason', cell: (r) => r.reason ?? '—' },
  ];

  return (
    <>
      <div className="mb-3 flex justify-end">
        {canEdit && (
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Damage a battery
          </button>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.error ? (list.error as Error).message : null}
        emptyMessage="No damage recorded"
      />

      {list.data && (
        <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPageChange={setPage} />
      )}

      <Modal
        open={adding}
        title="Record a damaged battery"
        onClose={() => setAdding(false)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={productId === null || Number(qty) < 1 || save.isPending}
              onClick={() => save.mutate()}
            >
              Record
            </button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date" name="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          <div>
            <label htmlFor="dmgProduct" className="field-label">
              Battery<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              id="dmgProduct"
              className="field-input"
              value={productId ?? ''}
              onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select…</option>
              {formData.data?.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <Field label="Quantity" name="qty" type="number" min="1" required value={qty} onChange={(e) => setQty(e.target.value)} />
          <div>
            <label htmlFor="dmgWorker" className="field-label">
              Worker
            </label>
            <select
              id="dmgWorker"
              className="field-input"
              value={workerId ?? ''}
              onChange={(e) => setWorkerId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">None</option>
              {formData.data?.workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <Field label="Reason" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Rework
// ---------------------------------------------------------------------------

function ReworkTab({ page, setPage, canEdit }: { page: number; setPage: (n: number) => void; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState(today());
  const [productId, setProductId] = useState<number | null>(null);
  const [workerId, setWorkerId] = useState<number | null>(null);
  const [qty, setQty] = useState('1');
  const [note, setNote] = useState('');

  const list = useQuery({
    queryKey: ['production', 'rework', page],
    queryFn: () => api.get<Paged<ReworkRow>>(`/production/rework?page=${page}&pageSize=20`),
    enabled: !adding,
  });

  const formData = useQuery({
    queryKey: ['production', 'form-data'],
    queryFn: () => api.get<FormData>('/production/form-data'),
    enabled: adding,
  });

  const save = useMutation({
    mutationFn: () =>
      api.post('/production/rework', { date, productId, workerId, qty, note: note || null }),
    onSuccess: () => {
      toast.success('Rework recorded');
      void queryClient.invalidateQueries({ queryKey: ['production', 'rework'] });
      setAdding(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record rework'),
  });

  const columns: readonly Column<ReworkRow>[] = [
    { key: 'id', header: 'ID', numeric: true, width: '4rem' },
    { key: 'date', header: 'Date', width: '7.5rem' },
    { key: 'product_name', header: 'Battery', cell: (r) => r.product_name ?? '—' },
    { key: 'qty', header: 'Qty', numeric: true, width: '6rem' },
    { key: 'worker_name', header: 'Worker', cell: (r) => r.worker_name ?? '—' },
    { key: 'status', header: 'Status', width: '6rem' },
    { key: 'note', header: 'Note', cell: (r) => r.note ?? '—' },
  ];

  return (
    <>
      <div className="mb-3 flex justify-end">
        {canEdit && (
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            New rework
          </button>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.error ? (list.error as Error).message : null}
        emptyMessage="No rework recorded"
      />

      {list.data && (
        <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPageChange={setPage} />
      )}

      <Modal
        open={adding}
        title="Send a battery back for rework"
        onClose={() => setAdding(false)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={productId === null || workerId === null || Number(qty) < 1 || save.isPending}
              onClick={() => save.mutate()}
            >
              Record
            </button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date" name="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          <div>
            <label htmlFor="rwProduct" className="field-label">
              Battery<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              id="rwProduct"
              className="field-input"
              value={productId ?? ''}
              onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select…</option>
              {formData.data?.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="rwWorker" className="field-label">
              Worker<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              id="rwWorker"
              className="field-input"
              value={workerId ?? ''}
              onChange={(e) => setWorkerId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select…</option>
              {formData.data?.workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <Field label="Quantity" name="qty" type="number" min="1" required value={qty} onChange={(e) => setQty(e.target.value)} />
          <div className="sm:col-span-2">
            <Field label="Note" name="note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Worker report
// ---------------------------------------------------------------------------

function ReportTab() {
  const report = useQuery({
    queryKey: ['production', 'worker-report'],
    queryFn: () => api.get<ReportRow[]>('/production/worker-report'),
  });

  const columns: readonly Column<ReportRow>[] = [
    { key: 'name', header: 'Worker' },
    { key: 'pieces', header: 'Pieces (ready)', numeric: true },
    { key: 'damagedQty', header: 'Damaged qty', numeric: true },
    { key: 'damagedValue', header: 'Damaged value', numeric: true, cell: (r) => fmtMoney(r.damagedValue) },
  ];

  return (
    <DataTable
      columns={columns}
      rows={report.data ?? []}
      rowKey={(r) => r.id}
      loading={report.isPending}
      error={report.error ? (report.error as Error).message : null}
      emptyMessage="No workers yet"
    />
  );
}
