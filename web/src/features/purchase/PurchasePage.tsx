import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Printer, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { addMoney, fmtMoney, subMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { Field, PageHeader } from '@/components/ui/Field';
import { InvoiceGrid, TotalsPanel, type GridProduct } from '@/components/invoice/InvoiceGrid';
import { useInvoiceLines } from '@/components/invoice/useInvoiceLines';

interface PurchaseRow {
  id: number;
  doc_number: string;
  date: string;
  net_total: string;
  paid: string;
  remaining: string;
  supplier_name: string | null;
}

interface FormData {
  suppliers: { id: number; name: string | null; phone: string | null }[];
  products: GridProduct[];
  finishedProducts: GridProduct[];
  branches: { id: number; name: string }[];
}

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

// Legacy form 10 / form code 301.
const PERM = { formId: 10, create: 3012, print: 3015 };

const today = () => new Date().toISOString().slice(0, 10);

export function PurchasePage() {
  const { hasAction } = useAuth();

  const [page, setPage] = useState(1);
  const [composing, setComposing] = useState(false);

  const list = useQuery({
    queryKey: ['purchases', page],
    queryFn: () => api.get<Paged<PurchaseRow>>(`/purchases?page=${page}&pageSize=20`),
    enabled: !composing,
  });

  const canPrint = hasAction(PERM.formId, PERM.print);

  const columns: readonly Column<PurchaseRow>[] = [
    { key: 'doc_number', header: 'Invoice', width: '6rem' },
    { key: 'date', header: 'Date', width: '8rem' },
    { key: 'supplier_name', header: 'Supplier', cell: (r) => r.supplier_name ?? '—' },
    { key: 'net_total', header: 'Net Total', numeric: true, cell: (r) => fmtMoney(r.net_total) },
    { key: 'paid', header: 'Paid', numeric: true, cell: (r) => fmtMoney(r.paid) },
    {
      key: 'remaining',
      header: 'Remaining',
      numeric: true,
      cell: (r) => (
        <span className={Number(r.remaining) > 0 ? 'font-medium text-amber-700' : undefined}>
          {fmtMoney(r.remaining)}
        </span>
      ),
    },
  ];

  if (composing) return <PurchaseComposer onDone={() => setComposing(false)} />;

  return (
    <>
      <PageHeader
        title="Purchase"
        subtitle="Purchase invoices for raw materials"
        actions={
          hasAction(PERM.formId, PERM.create) && (
            <button type="button" className="btn-primary" onClick={() => setComposing(true)}>
              <Plus className="size-3.5" />
              New Purchase
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
        emptyMessage="No purchases recorded yet"
        actions={
          canPrint
            ? (row) => (
                <button
                  type="button"
                  title={`Print invoice ${row.doc_number}`}
                  className="rounded-sm p-1.5 text-slate-500 hover:bg-slate-100 hover:text-brand-600"
                  onClick={() =>
                    window.open(`/print/purchase/${row.id}?auto=1`, '_blank', 'noopener')
                  }
                >
                  <Printer className="size-3.5" />
                </button>
              )
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
    </>
  );
}

function PurchaseComposer({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [date, setDate] = useState(today());
  const [supId, setSupId] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [kind, setKind] = useState<'RAW' | 'FINISH'>('RAW');

  // A super admin signs in against branch 0 ("All Branches"), which is a filter
  // rather than a location — so they must pick a real branch to record against.
  const [branchId, setBranchId] = useState<number | null>(null);
  const needsBranch = user?.isSuperAdmin ?? false;

  // `service` doubles as freight here and `received` as paid — the hook is
  // deliberately generic about what the two adjustment figures mean.
  const grid = useInvoiceLines();

  const formData = useQuery({
    queryKey: ['purchases', 'form-data'],
    queryFn: () => api.get<FormData>('/purchases/form-data'),
  });

  // Purchase totals differ from sale: freight is ADDED to stock value, and
  // there is no service income, so net = subtotal + freight - discount.
  const stockValue = addMoney(grid.totals.grossTotal, grid.service);
  const netTotal = subMoney(stockValue, grid.totals.totalDiscount);
  const remaining = subMoney(netTotal, grid.received);

  const errors: string[] = [];
  if (grid.validLines.length === 0) errors.push('Add at least one item');
  if (Number(netTotal) < 0) errors.push('Discount is more than the purchase value');
  if (Number(grid.received) > Number(netTotal)) {
    errors.push(`Paid cannot exceed the invoice total of ${fmtMoney(netTotal)}`);
  }

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>('/purchases', {
        date,
        supId,
        kind,
        ...(branchId !== null ? { branchId } : {}),
        discount: grid.invoiceDiscount,
        rent: grid.service,
        paid: grid.received,
        notes: notes || null,
        lines: grid.validLines.map((l) => ({
          pid: l.pid,
          qty: l.qty,
          price: l.price,
          discount: l.discount,
        })),
      }),
    onSuccess: (result) => {
      toast.success(`Purchase #${result.id} saved`);
      void queryClient.invalidateQueries({ queryKey: ['purchases'] });
      onDone();
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the purchase');
    },
  });

  if (needsBranch && branchId === null) errors.push('Select a branch');

  const blocked = errors.length > 0 || supId === null;

  return (
    <>
      <PageHeader
        title="New Purchase"
        subtitle="Invoice details"
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={onDone}>
              <X className="size-3.5" />
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={blocked || save.isPending}
              onClick={() => save.mutate()}
            >
              <Save className="size-3.5" />
              {save.isPending ? 'Saving…' : 'Save Purchase'}
            </button>
          </>
        }
      />

      <div
        className={cn(
          'card mb-3 grid gap-3 p-3',
          needsBranch ? 'sm:grid-cols-4' : 'sm:grid-cols-3',
        )}
      >
        <Field
          label="Date"
          name="date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />

        <div>
          <label htmlFor="supplier" className="field-label">
            Supplier<span className="ml-0.5 text-red-500">*</span>
          </label>
          <select
            id="supplier"
            className="field-input"
            value={supId ?? ''}
            onChange={(e) => setSupId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Select a supplier…</option>
            {formData.data?.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.phone ? ` — ${s.phone}` : ''}
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

        <Field
          label="Notes"
          name="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <div>
          <label htmlFor="kind" className="field-label">
            Goods type
          </label>
          <select
            id="kind"
            className="field-input"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as 'RAW' | 'FINISH');
              grid.reset();
            }}
          >
            <option value="RAW">Raw material</option>
            <option value="FINISH">Finished goods</option>
          </select>
        </div>
      </div>

      <InvoiceGrid
        lines={grid.totals.lines}
        products={kind === 'FINISH' ? (formData.data?.finishedProducts ?? []) : (formData.data?.products ?? [])}
        onAdd={grid.addLine}
        onRemove={grid.removeLine}
        onChange={grid.updateLine}
        disabled={save.isPending}
      />

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

      <div className="mt-3">
        <TotalsPanel
          disabled={save.isPending}
          rows={[
            { label: 'Sub total', value: grid.totals.grossTotal },
            {
              label: 'Invoice discount',
              value: grid.invoiceDiscount,
              onChange: grid.setInvoiceDiscount,
            },
            { label: 'Total discount', value: grid.totals.totalDiscount },
            { label: 'Freight', value: grid.service, onChange: grid.setService },
            { label: 'Stock value', value: stockValue },
            { label: 'Net total', value: netTotal, emphasis: true, divider: true },
            { label: 'Paid', value: grid.received, onChange: grid.setReceived },
            { label: 'Remaining', value: remaining, emphasis: true, divider: true },
          ]}
        />
      </div>
    </>
  );
}
