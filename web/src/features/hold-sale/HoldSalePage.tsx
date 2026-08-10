import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, CheckCircle2, Plus, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { Field, PageHeader } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { emptyLine, type InvoiceLine } from '@/components/invoice/useInvoiceLines';

interface HoldRow {
  id: number;
  date: string;
  status: string | null;
  note: string | null;
  customer_name: string | null;
}

interface FormData {
  customers: { id: number; name: string | null; phone: string | null }[];
  products: { id: number; name: string | null; sale_price: string }[];
  branches: { id: number; name: string }[];
}

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

// Legacy form 51 / form code 403.
const PERM = { formId: 51, create: 4032, edit: 4033 };

const today = () => new Date().toISOString().slice(0, 10);

const STATUS_STYLE: Record<string, string> = {
  HELD: 'bg-amber-100 text-amber-800',
  CONVERTED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-slate-200 text-slate-600',
};

/**
 * Hold ("lease") sale — goods set aside for a customer who has not paid.
 *
 * Carries no money and posts nothing to the ledger, so there is no totals
 * panel: only items and quantities. Value is recognised when the hold is
 * converted into a real sale.
 */
export function HoldSalePage() {
  const { hasAction } = useAuth();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [composing, setComposing] = useState(false);
  const [converting, setConverting] = useState<HoldRow | null>(null);
  const [saleId, setSaleId] = useState('');

  const list = useQuery({
    queryKey: ['lease-sales', page],
    queryFn: () => api.get<Paged<HoldRow>>(`/lease-sales?page=${page}&pageSize=20`),
    enabled: !composing,
  });

  const cancel = useMutation({
    mutationFn: (row: HoldRow) => api.post(`/lease-sales/${row.id}/cancel`),
    onSuccess: () => {
      toast.success('Hold released');
      void queryClient.invalidateQueries({ queryKey: ['lease-sales'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not release the hold'),
  });

  const convert = useMutation({
    mutationFn: () => api.post(`/lease-sales/${converting?.id}/convert`, { saleId: Number(saleId) }),
    onSuccess: () => {
      toast.success('Hold marked as converted');
      void queryClient.invalidateQueries({ queryKey: ['lease-sales'] });
      setConverting(null);
      setSaleId('');
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not convert the hold'),
  });

  const canEdit = hasAction(PERM.formId, PERM.edit);

  const columns: readonly Column<HoldRow>[] = [
    { key: 'id', header: 'Hold', numeric: true, width: '5rem' },
    { key: 'date', header: 'Date', width: '8rem' },
    { key: 'customer_name', header: 'Customer', cell: (r) => r.customer_name ?? '—' },
    {
      key: 'status',
      header: 'Status',
      width: '8rem',
      cell: (r) => (
        <span
          className={cn(
            'inline-block rounded-sm px-1.5 py-0.5 text-xs font-medium',
            STATUS_STYLE[r.status ?? ''] ?? 'bg-slate-100 text-slate-600',
          )}
        >
          {r.status ?? '—'}
        </span>
      ),
    },
    { key: 'note', header: 'Note', cell: (r) => r.note ?? '—' },
  ];

  if (composing) return <HoldComposer onDone={() => setComposing(false)} />;

  return (
    <>
      <PageHeader
        title="Hold Sale"
        subtitle="Goods reserved for a customer — no ledger impact until converted"
        actions={
          hasAction(PERM.formId, PERM.create) && (
            <button type="button" className="btn-primary" onClick={() => setComposing(true)}>
              <Plus className="size-3.5" />
              New Hold
            </button>
          )
        }
      />

      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.error ? (list.error as Error).message : null}
        emptyMessage="Nothing on hold"
        actions={
          canEdit
            ? (row) =>
                row.status === 'HELD' ? (
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      title="Mark as converted to a sale"
                      className="rounded-sm p-1.5 text-slate-500 hover:bg-emerald-50 hover:text-emerald-700"
                      onClick={() => setConverting(row)}
                    >
                      <CheckCircle2 className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Release the hold"
                      className="rounded-sm p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600"
                      onClick={() => {
                        if (confirm(`Release hold #${row.id}? The goods go back on the shelf.`)) {
                          cancel.mutate(row);
                        }
                      }}
                    >
                      <Ban className="size-3.5" />
                    </button>
                  </div>
                ) : null
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

      <Modal
        open={converting !== null}
        title={`Convert hold #${converting?.id ?? ''}`}
        onClose={() => setConverting(null)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setConverting(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!saleId || convert.isPending}
              onClick={() => convert.mutate()}
            >
              {convert.isPending ? 'Converting…' : 'Convert'}
            </button>
          </>
        }
      >
        <p className="mb-3 text-sm text-slate-600">
          Record the sale invoice first — that is what posts to the ledger — then enter its number
          here to close the hold.
        </p>
        <Field
          label="Sale invoice number"
          name="saleId"
          type="number"
          required
          autoFocus
          value={saleId}
          onChange={(e) => setSaleId(e.target.value)}
        />
      </Modal>
    </>
  );
}

function HoldComposer({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [date, setDate] = useState(today());
  const [custId, setCustId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [branchId, setBranchId] = useState<number | null>(null);
  const [lines, setLines] = useState<InvoiceLine[]>([emptyLine()]);

  const needsBranch = user?.isSuperAdmin ?? false;

  const formData = useQuery({
    queryKey: ['lease-sales', 'form-data'],
    queryFn: () => api.get<FormData>('/lease-sales/form-data'),
  });

  const validLines = lines.filter((l) => l.pid !== null && Number(l.qty) > 0);

  const errors: string[] = [];
  if (validLines.length === 0) errors.push('Add at least one item');
  if (needsBranch && branchId === null) errors.push('Select a branch');

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>('/lease-sales', {
        date,
        custId,
        ...(branchId !== null ? { branchId } : {}),
        note: note || null,
        lines: validLines.map((l) => ({ pid: l.pid, qty: l.qty })),
      }),
    onSuccess: (result) => {
      toast.success(`Hold #${result.id} created`);
      void queryClient.invalidateQueries({ queryKey: ['lease-sales'] });
      onDone();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not create the hold'),
  });

  const update = (key: string, patch: Partial<InvoiceLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <>
      <PageHeader
        title="New Hold"
        subtitle="Reserve goods for a customer"
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={onDone}>
              <X className="size-3.5" />
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={errors.length > 0 || custId === null || save.isPending}
              onClick={() => save.mutate()}
            >
              <Save className="size-3.5" />
              {save.isPending ? 'Saving…' : 'Save Hold'}
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
            <option value="">Select a customer…</option>
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
              <option value="">Select a branch…</option>
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

      {/* No prices: a hold records what is set aside, not what it is worth. */}
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
                    value={line.pid ?? ''}
                    aria-label={`Item for line ${i + 1}`}
                    onChange={(e) => {
                      const pid = Number(e.target.value);
                      const p = formData.data?.products.find((x) => x.id === pid);
                      update(line.key, { pid, pname: p?.name ?? '' });
                    }}
                  >
                    <option value="">Select an item…</option>
                    {formData.data?.products.map((p) => (
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
