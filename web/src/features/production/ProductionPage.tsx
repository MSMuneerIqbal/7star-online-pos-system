import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Factory, Plus, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { addMoney, fmtMoney, mulMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { Field, PageHeader } from '@/components/ui/Field';
import { emptyLine, type InvoiceLine } from '@/components/invoice/useInvoiceLines';

interface ProductionRow {
  id: number;
  doc_number: string;
  date: string;
  qty: number;
  material_cost: string;
  total_cost: string;
  per_unit: string;
  product_name: string | null;
}

interface FormData {
  products: { id: number; name: string | null; price: string }[];
  rawMaterials: { id: number; name: string | null; price: string }[];
  branches: { id: number; name: string }[];
}

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

// Legacy form 47 / form code 1001.
const PERM = { formId: 47, create: 10012 };

const today = () => new Date().toISOString().slice(0, 10);

export function ProductionPage() {
  const { hasAction } = useAuth();

  const [page, setPage] = useState(1);
  const [composing, setComposing] = useState(false);

  const list = useQuery({
    queryKey: ['production', page],
    queryFn: () => api.get<Paged<ProductionRow>>(`/production?page=${page}&pageSize=20`),
    enabled: !composing,
  });

  const columns: readonly Column<ProductionRow>[] = [
    { key: 'doc_number', header: 'Run', width: '6rem' },
    { key: 'date', header: 'Date', width: '7.5rem' },
    { key: 'product_name', header: 'Product', cell: (r) => r.product_name ?? '—' },
    { key: 'qty', header: 'Qty made', numeric: true, width: '7rem' },
    {
      key: 'material_cost',
      header: 'Material',
      numeric: true,
      cell: (r) => fmtMoney(r.material_cost),
    },
    { key: 'total_cost', header: 'Total cost', numeric: true, cell: (r) => fmtMoney(r.total_cost) },
    { key: 'per_unit', header: 'Per unit', numeric: true, cell: (r) => fmtMoney(r.per_unit) },
  ];

  if (composing) return <ProductionComposer onDone={() => setComposing(false)} />;

  return (
    <>
      <PageHeader
        title="Production"
        subtitle="Convert raw materials into finished goods"
        actions={
          hasAction(PERM.formId, PERM.create) && (
            <button type="button" className="btn-primary" onClick={() => setComposing(true)}>
              <Plus className="size-3.5" />
              New Production Run
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
        emptyMessage="No production runs recorded yet"
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

function ProductionComposer({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [date, setDate] = useState(today());
  const [pid, setPid] = useState<number | null>(null);
  const [qty, setQty] = useState('1');
  const [labourCost, setLabourCost] = useState('0');
  const [electricCost, setElectricCost] = useState('0');
  const [otherCost, setOtherCost] = useState('0');
  const [paidInCash, setPaidInCash] = useState(true);
  const [note, setNote] = useState('');
  const [branchId, setBranchId] = useState<number | null>(null);
  const [lines, setLines] = useState<InvoiceLine[]>([emptyLine()]);

  const needsBranch = user?.isSuperAdmin ?? false;

  const formData = useQuery({
    queryKey: ['production', 'form-data'],
    queryFn: () => api.get<FormData>('/production/form-data'),
  });

  const validLines = lines.filter((l) => l.pid !== null && Number(l.qty) > 0);

  // Material cost is recomputed server-side from the catalog; this preview just
  // shows the operator where the run is heading.
  const materialCost = validLines.reduce((acc, l) => {
    const raw = formData.data?.rawMaterials.find((r) => r.id === l.pid);
    return raw ? addMoney(acc, mulMoney(l.qty, raw.price)) : acc;
  }, '0.00');

  const conversion = addMoney(addMoney(labourCost, electricCost), otherCost);
  const totalCost = addMoney(materialCost, conversion);
  const perUnit = Number(qty) > 0 ? fmtMoney(String(Number(totalCost) / Number(qty))) : '—';

  const errors: string[] = [];
  if (validLines.length === 0) errors.push('Add at least one raw material');
  if (pid === null) errors.push('Choose the product being made');
  if (!(Number(qty) >= 1)) errors.push('Quantity made must be at least 1');
  if (needsBranch && branchId === null) errors.push('Select a branch');

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>('/production', {
        date,
        pid,
        qty: Number(qty),
        ...(branchId !== null ? { branchId } : {}),
        labourCost,
        electricCost,
        otherCost,
        conversionPaidInCash: paidInCash,
        note: note || null,
        lines: validLines.map((l) => ({ pid: l.pid, qty: l.qty })),
      }),
    onSuccess: (r) => {
      toast.success(`Production run #${r.id} recorded`);
      void queryClient.invalidateQueries({ queryKey: ['production'] });
      onDone();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not record production'),
  });

  const update = (key: string, patch: Partial<InvoiceLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <>
      <PageHeader
        title="New Production Run"
        subtitle="Raw material plus conversion cost becomes finished stock"
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
              {save.isPending ? 'Saving…' : 'Record Production'}
            </button>
          </>
        }
      />

      <div className={cn('card mb-3 grid gap-3 p-3', needsBranch ? 'sm:grid-cols-5' : 'sm:grid-cols-4')}>
        <Field
          label="Date"
          name="date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />

        <div>
          <label htmlFor="product" className="field-label">
            Product made<span className="ml-0.5 text-red-500">*</span>
          </label>
          <select
            id="product"
            className="field-input"
            value={pid ?? ''}
            onChange={(e) => setPid(e.target.value ? Number(e.target.value) : null)}
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
          label="Quantity made"
          name="qty"
          type="number"
          min="1"
          required
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />

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

      {/* Raw materials consumed — quantities only, costed from the catalog. */}
      <div className="card overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase">
              <th className="w-8 px-2 py-2 text-left">#</th>
              <th className="px-2 py-2 text-left">Raw material consumed</th>
              <th className="w-32 px-2 py-2 text-right">Qty</th>
              <th className="w-32 px-2 py-2 text-right">Cost</th>
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => {
              const raw = formData.data?.rawMaterials.find((r) => r.id === line.pid);
              const cost = raw ? mulMoney(line.qty, raw.price) : '0.00';

              return (
                <tr key={line.key} className="border-b border-slate-100 last:border-0">
                  <td className="px-2 py-1 text-xs text-slate-400 tabular">{i + 1}</td>
                  <td className="px-2 py-1">
                    <select
                      className="field-input py-1"
                      aria-label={`Raw material for line ${i + 1}`}
                      value={line.pid ?? ''}
                      onChange={(e) => {
                        const id = Number(e.target.value);
                        const r = formData.data?.rawMaterials.find((x) => x.id === id);
                        update(line.key, { pid: id, pname: r?.name ?? '' });
                      }}
                    >
                      <option value="">Select an item…</option>
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
                  <td className="px-2 py-1 text-right text-slate-600 tabular">
                    {fmtMoney(cost)}
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
              );
            })}
          </tbody>
        </table>

        <div className="border-t border-slate-200 px-2 py-1.5">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setLines((ls) => [...ls, emptyLine()])}
          >
            <Plus className="size-3.5" />
            Add material
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

      {/* Conversion costs and the resulting unit cost. */}
      <div className="card mt-3 ml-auto w-full max-w-md p-3">
        <div className="flex items-center justify-between py-1">
          <span className="text-sm text-slate-600">Material cost</span>
          <span className="text-sm tabular">{fmtMoney(materialCost)}</span>
        </div>

        {(
          [
            ['Labour', labourCost, setLabourCost, 'labour'],
            ['Electricity', electricCost, setElectricCost, 'electric'],
            ['Other', otherCost, setOtherCost, 'other'],
          ] as const
        ).map(([label, value, setter, name]) => (
          <div key={name} className="flex items-center justify-between gap-3 py-1">
            <label htmlFor={name} className="text-sm text-slate-600">
              {label}
            </label>
            <input
              id={name}
              type="number"
              step="any"
              min="0"
              className="field-input w-32 py-1 text-right tabular"
              value={value}
              onChange={(e) => setter(e.target.value)}
            />
          </div>
        ))}

        <label className="flex items-center gap-2 py-1 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={paidInCash}
            onChange={(e) => setPaidInCash(e.target.checked)}
            className="rounded-sm border-slate-300"
          />
          Conversion cost paid in cash
        </label>

        <div className="my-1 border-t border-slate-200" />

        <div className="flex items-center justify-between py-1">
          <span className="font-semibold text-slate-900">Total cost</span>
          <span className="text-base font-semibold tabular">{fmtMoney(totalCost)}</span>
        </div>

        <div className="flex items-center justify-between py-1">
          <span className="flex items-center gap-1.5 text-sm text-slate-600">
            <Factory className="size-3.5" />
            Cost per unit
          </span>
          <span className="text-sm font-medium tabular">{perUnit}</span>
        </div>
      </div>
    </>
  );
}
