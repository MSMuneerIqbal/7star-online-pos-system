import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { Field, PageHeader } from '@/components/ui/Field';

type Kind = 'RAW' | 'FINISH';

interface Branch {
  id: number;
  name: string | null;
}

interface Product {
  id: number;
  name: string | null;
}

interface FormData {
  branches: Branch[];
  products: Product[];
  rawProducts: Product[];
}

interface AdjustmentRow {
  id: number;
  doc_number: string;
  date: string;
  branch_id: number;
  kind: string;
  reason: string;
  note: string | null;
}

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface Line {
  key: string;
  pid: number | null;
  qty: string;
}

let lineSeq = 0;
const emptyLine = (): Line => ({ key: `l${lineSeq++}`, pid: null, qty: '' });

const today = () => new Date().toISOString().slice(0, 10);

export function AdjustmentPage() {
  const [page, setPage] = useState(1);
  const [composing, setComposing] = useState(false);

  const formData = useQuery({
    queryKey: ['adjustments', 'form-data'],
    queryFn: () => api.get<FormData>('/adjustments/form-data'),
    enabled: composing,
  });

  const list = useQuery({
    queryKey: ['adjustments', page],
    queryFn: () => api.get<Paged<AdjustmentRow>>(`/adjustments?page=${page}&pageSize=20`),
    enabled: !composing,
  });

  const branchName = (id: number) =>
    formData.data?.branches.find((b) => b.id === id)?.name ?? `Branch ${id}`;

  const columns: readonly Column<AdjustmentRow>[] = [
    { key: 'doc_number', header: 'No.', width: '6rem' },
    { key: 'date', header: 'Date', width: '7.5rem' },
    { key: 'branch_id', header: 'Branch', cell: (r) => branchName(r.branch_id) },
    { key: 'kind', header: 'Kind', width: '6rem' },
    { key: 'reason', header: 'Reason' },
  ];

  if (composing) {
    return <AdjustmentComposer onDone={() => setComposing(false)} />;
  }

  return (
    <>
      <PageHeader
        title="Stock Adjustment"
        subtitle="Correct a branch's on-hand quantity — surplus or shrinkage"
        actions={
          <button type="button" className="btn-primary" onClick={() => setComposing(true)}>
            <Plus className="size-3.5" />
            New Adjustment
          </button>
        }
      />

      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.error ? (list.error as Error).message : null}
        emptyMessage="No adjustments yet"
      />

      {list.data && (
        <Pagination
          page={list.data.page}
          pageSize={list.data.pageSize}
          total={list.data.total}
          onPageChange={setPage}
        />
      )}
    </>
  );
}

function AdjustmentComposer({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();

  const formData = useQuery({
    queryKey: ['adjustments', 'form-data'],
    queryFn: () => api.get<FormData>('/adjustments/form-data'),
  });

  const [date, setDate] = useState(today());
  const [kind, setKind] = useState<Kind>('FINISH');
  const [branchId, setBranchId] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);

  const products = kind === 'FINISH' ? (formData.data?.products ?? []) : (formData.data?.rawProducts ?? []);

  const validLines = lines.filter((l) => l.pid !== null && Number(l.qty) !== 0);

  const errors: string[] = [];
  if (validLines.length === 0) errors.push('Add at least one item with a non-zero quantity');
  if (branchId === null) errors.push('Choose a branch');
  if (!reason.trim()) errors.push('Give a reason');

  const save = useMutation({
    mutationFn: () =>
      api.post('/adjustments', {
        date,
        kind,
        branchId,
        reason: reason.trim(),
        note: note.trim() || null,
        lines: validLines.map((l) => ({ pid: l.pid, qty: l.qty })),
      }),
    onSuccess: () => {
      toast.success('Adjustment saved');
      void queryClient.invalidateQueries({ queryKey: ['adjustments'] });
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save'),
  });

  const update = (key: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <>
      <PageHeader
        title="New Stock Adjustment"
        subtitle="Positive quantity adds stock; negative quantity removes it"
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
          <label htmlFor="kind" className="field-label">
            Kind<span className="ml-0.5 text-red-500">*</span>
          </label>
          <select id="kind" className="field-input" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="FINISH">Finish Item</option>
            <option value="RAW">Raw Item</option>
          </select>
        </div>

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
            {(formData.data?.branches ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>

        <Field
          label="Reason"
          name="reason"
          required
          placeholder="e.g. physical count"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase">
              <th className="w-8 px-2 py-2 text-left">#</th>
              <th className="px-2 py-2 text-left">Item</th>
              <th className="w-32 px-2 py-2 text-right">Qty (+/-)</th>
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
                    onChange={(e) => update(line.key, { pid: Number(e.target.value) })}
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
                    className="field-input py-1 text-right tabular"
                    aria-label={`Quantity for line ${i + 1}`}
                    placeholder="+5 or -3"
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
                      setLines((ls) => (ls.length === 1 ? [emptyLine()] : ls.filter((l) => l.key !== line.key)))
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
          <button type="button" className="btn-secondary" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
            <Plus className="size-3.5" />
            Add item
          </button>
        </div>
      </div>

      <Field label="Note" name="note" value={note} onChange={(e) => setNote(e.target.value)} />

      {errors.length > 0 && (
        <div role="alert" className="card mt-3 flex gap-2 border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
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
