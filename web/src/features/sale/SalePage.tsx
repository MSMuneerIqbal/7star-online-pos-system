import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Printer, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { Field, PageHeader } from '@/components/ui/Field';
import { InvoiceGrid, TotalsPanel, type GridProduct } from '@/components/invoice/InvoiceGrid';
import { useInvoiceLines } from '@/components/invoice/useInvoiceLines';

interface SaleRow {
  id: number;
  doc_number: string;
  date: string;
  net_total: string;
  received: string;
  remaining: string;
  customer_name: string | null;
}

interface FormData {
  customers: { id: number; name: string | null; phone: string | null }[];
  products: GridProduct[];
  branches: { id: number; name: string }[];
  walkInCustomerId: number;
}

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

// Legacy form 12 / form code 401.
const PERM = { formId: 12, create: 4012, edit: 4013, print: 4015 };

const today = () => new Date().toISOString().slice(0, 10);

export function SalePage() {
  const { hasAction } = useAuth();

  const [page, setPage] = useState(1);
  const [composing, setComposing] = useState(false);

  const canCreate = hasAction(PERM.formId, PERM.create);

  const list = useQuery({
    queryKey: ['sales', page],
    queryFn: () => api.get<Paged<SaleRow>>(`/sales?page=${page}&pageSize=20`),
    enabled: !composing,
  });

  const columns: readonly Column<SaleRow>[] = [
    { key: 'doc_number', header: 'Invoice', width: '6rem' },
    { key: 'date', header: 'Date', width: '8rem' },
    { key: 'customer_name', header: 'Customer', cell: (r) => r.customer_name ?? '—' },
    { key: 'net_total', header: 'Net Total', numeric: true, cell: (r) => fmtMoney(r.net_total) },
    { key: 'received', header: 'Received', numeric: true, cell: (r) => fmtMoney(r.received) },
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

  if (composing) {
    return <SaleComposer onDone={() => setComposing(false)} />;
  }

  return (
    <>
      <PageHeader
        title="Sale"
        subtitle="Sales invoices"
        actions={
          canCreate && (
            <button type="button" className="btn-primary" onClick={() => setComposing(true)}>
              <Plus className="size-3.5" />
              New Sale
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
        emptyMessage="No sales recorded yet"
        actions={
          hasAction(PERM.formId, PERM.print)
            ? (row) => (
                <button
                  type="button"
                  title={`Print invoice ${row.doc_number}`}
                  className="rounded-sm p-1.5 text-slate-500 hover:bg-slate-100 hover:text-brand-600"
                  onClick={() => window.open(`/print/sale/${row.id}?auto=1`, '_blank', 'noopener')}
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

function SaleComposer({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [date, setDate] = useState(today());
  const [custId, setCustId] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [walkIn, setWalkIn] = useState({ name: '', phone: '', address: '' });

  // A super admin signs in against branch 0 ("All Branches"), which is a filter
  // rather than a location — so they must pick a real branch to record against.
  const [branchId, setBranchId] = useState<number | null>(null);
  const needsBranch = user?.isSuperAdmin ?? false;

  const grid = useInvoiceLines();

  // Branches and customers load immediately — the branch picker itself
  // depends on this response. Product pricing is branch-specific since the
  // catalog split, so the server only fills in `products` once `branchId`
  // is on the query; refetch when it changes rather than gating the whole
  // request behind it (that would make the branch picker unreachable).
  const formData = useQuery({
    queryKey: ['sales', 'form-data', branchId],
    queryFn: () =>
      api.get<FormData>(`/sales/form-data${branchId !== null ? `?branchId=${branchId}` : ''}`),
  });

  const isWalkIn = custId !== null && custId === formData.data?.walkInCustomerId;

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>('/sales', {
        date,
        custId,
        ...(branchId !== null ? { branchId } : {}),
        discount: grid.invoiceDiscount,
        service: grid.service,
        received: grid.received,
        notes: notes || null,
        lines: grid.validLines.map((l) => ({
          pid: l.pid,
          qty: l.qty,
          price: l.price,
          discount: l.discount,
        })),
        ...(isWalkIn ? { walkIn } : {}),
      }),
    onSuccess: (result) => {
      toast.success(`Sale #${result.id} saved`);
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      onDone();
    },
    onError: (err) => {
      // The server recomputes every figure, so its message is authoritative
      // when it disagrees with what the grid showed.
      toast.error(err instanceof ApiError ? err.message : 'Could not save the sale');
    },
  });

  const errors = [
    ...grid.errors,
    ...(needsBranch && branchId === null ? ['Select a branch'] : []),
  ];

  const blocked = errors.length > 0 || custId === null;

  return (
    <>
      <PageHeader
        title="New Sale"
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
              {save.isPending ? 'Saving…' : 'Save Sale'}
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
              onChange={(e) => {
                setBranchId(e.target.value ? Number(e.target.value) : null);
                // Prices are branch-specific — lines picked under a
                // different branch would otherwise keep showing a price
                // that isn't this branch's.
                grid.reset();
              }}
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
      </div>

      {isWalkIn && (
        <div className="card mb-3 grid gap-3 p-3 sm:grid-cols-3">
          <Field
            label="Walk-in name"
            name="walkin-name"
            value={walkIn.name}
            onChange={(e) => setWalkIn({ ...walkIn, name: e.target.value })}
          />
          <Field
            label="Phone"
            name="walkin-phone"
            value={walkIn.phone}
            onChange={(e) => setWalkIn({ ...walkIn, phone: e.target.value })}
          />
          <Field
            label="Address"
            name="walkin-address"
            value={walkIn.address}
            onChange={(e) => setWalkIn({ ...walkIn, address: e.target.value })}
          />
        </div>
      )}

      <InvoiceGrid
        lines={grid.totals.lines}
        products={formData.data?.products ?? []}
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
            { label: 'Gross total', value: grid.totals.grossTotal },
            {
              label: 'Invoice discount',
              value: grid.invoiceDiscount,
              onChange: grid.setInvoiceDiscount,
            },
            { label: 'Total discount', value: grid.totals.totalDiscount },
            { label: 'Service charges', value: grid.service, onChange: grid.setService },
            { label: 'Net total', value: grid.totals.netTotal, emphasis: true, divider: true },
            { label: 'Received', value: grid.received, onChange: grid.setReceived },
            { label: 'Remaining', value: grid.totals.remaining, emphasis: true, divider: true },
          ]}
        />
      </div>
    </>
  );
}
