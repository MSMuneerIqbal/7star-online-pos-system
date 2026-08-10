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

/**
 * Shared shell for Sale Return and Purchase Return.
 *
 * The two differ only in which party they credit, which catalog they draw from,
 * and whether freight applies — so they are configured rather than duplicated.
 */
interface ReturnConfig {
  /** API path segment, e.g. 'sale-returns'. */
  endpoint: string;
  /** Print route segment, e.g. 'sale-return'. */
  printKind: string;
  title: string;
  subtitle: string;
  partyLabel: string;
  /** Key of the party id in the request body: 'custId' or 'supId'. */
  partyField: 'custId' | 'supId';
  /** Key of the party list in the form-data response. */
  partyListKey: 'customers' | 'suppliers';
  /** Key of the refund amount in the request body. */
  refundField: 'paid' | 'received';
  /** Purchase returns carry freight; sale returns do not. */
  hasFreight: boolean;
  permissions: { formId: number; create: number; print: number };
}

export const SALE_RETURN: ReturnConfig = {
  endpoint: 'sale-returns',
  printKind: 'sale-return',
  title: 'Sale Return',
  subtitle: 'Goods returned by customers',
  partyLabel: 'Customer',
  partyField: 'custId',
  partyListKey: 'customers',
  refundField: 'paid',
  hasFreight: false,
  permissions: { formId: 13, create: 4022, print: 4025 },
};

export const PURCHASE_RETURN: ReturnConfig = {
  endpoint: 'purchase-returns',
  printKind: 'purchase-return',
  title: 'Purchase Return',
  subtitle: 'Raw materials returned to suppliers',
  partyLabel: 'Supplier',
  partyField: 'supId',
  partyListKey: 'suppliers',
  refundField: 'received',
  hasFreight: true,
  permissions: { formId: 11, create: 3022, print: 3025 },
};

interface ReturnRow {
  id: number;
  date: string;
  net_total: string;
  paid?: string;
  received?: string;
  remaining: string;
  customer_name?: string | null;
  supplier_name?: string | null;
  sale_id?: number | null;
}

interface FormData {
  customers?: { id: number; name: string | null; phone: string | null }[];
  suppliers?: { id: number; name: string | null; phone: string | null }[];
  products: GridProduct[];
  branches: { id: number; name: string }[];
}

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

const today = () => new Date().toISOString().slice(0, 10);

export function ReturnPage({ config }: { config: ReturnConfig }) {
  const { hasAction } = useAuth();

  const [page, setPage] = useState(1);
  const [composing, setComposing] = useState(false);

  const list = useQuery({
    queryKey: [config.endpoint, page],
    queryFn: () => api.get<Paged<ReturnRow>>(`/${config.endpoint}?page=${page}&pageSize=20`),
    enabled: !composing,
  });

  const columns: readonly Column<ReturnRow>[] = [
    { key: 'id', header: 'Return', numeric: true, width: '5rem' },
    { key: 'date', header: 'Date', width: '8rem' },
    ...(config.partyField === 'custId'
      ? ([
          {
            key: 'sale_id',
            header: 'Against Inv.',
            numeric: true,
            width: '7rem',
            cell: (r: ReturnRow) => r.sale_id ?? '—',
          },
        ] as const)
      : []),
    {
      key: 'party',
      header: config.partyLabel,
      cell: (r) => r.customer_name ?? r.supplier_name ?? '—',
    },
    { key: 'net_total', header: 'Credit', numeric: true, cell: (r) => fmtMoney(r.net_total) },
    {
      key: 'refund',
      header: 'Refunded',
      numeric: true,
      cell: (r) => fmtMoney(r.paid ?? r.received ?? '0'),
    },
    {
      key: 'remaining',
      header: 'Balance',
      numeric: true,
      cell: (r) => (
        <span className={Number(r.remaining) > 0 ? 'font-medium text-amber-700' : undefined}>
          {fmtMoney(r.remaining)}
        </span>
      ),
    },
  ];

  if (composing) return <ReturnComposer config={config} onDone={() => setComposing(false)} />;

  return (
    <>
      <PageHeader
        title={config.title}
        subtitle={config.subtitle}
        actions={
          hasAction(config.permissions.formId, config.permissions.create) && (
            <button type="button" className="btn-primary" onClick={() => setComposing(true)}>
              <Plus className="size-3.5" />
              New {config.title}
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
        emptyMessage={`No ${config.title.toLowerCase()}s recorded yet`}
        actions={
          hasAction(config.permissions.formId, config.permissions.print)
            ? (row) => (
                <button
                  type="button"
                  title={`Print ${config.title} ${row.id}`}
                  className="rounded-sm p-1.5 text-slate-500 hover:bg-slate-100 hover:text-brand-600"
                  onClick={() =>
                    window.open(`/print/${config.printKind}/${row.id}?auto=1`, '_blank', 'noopener')
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

function ReturnComposer({ config, onDone }: { config: ReturnConfig; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [date, setDate] = useState(today());
  const [partyId, setPartyId] = useState<number | null>(null);
  const [againstInvoice, setAgainstInvoice] = useState('');
  const [notes, setNotes] = useState('');
  const [branchId, setBranchId] = useState<number | null>(null);

  const needsBranch = user?.isSuperAdmin ?? false;
  const grid = useInvoiceLines();

  const formData = useQuery({
    queryKey: [config.endpoint, 'form-data'],
    queryFn: () => api.get<FormData>(`/${config.endpoint}/form-data`),
  });

  const parties = formData.data?.[config.partyListKey] ?? [];

  // Purchase returns add freight to the credit; sale returns have none.
  const freight = config.hasFreight ? grid.service : '0';
  const stockValue = addMoney(grid.totals.grossTotal, freight);
  const netTotal = subMoney(stockValue, grid.totals.totalDiscount);
  const remaining = subMoney(netTotal, grid.received);

  const errors: string[] = [];
  if (grid.validLines.length === 0) errors.push('Add at least one item');
  if (Number(netTotal) < 0) errors.push('Discount is more than the return value');
  if (Number(grid.received) > Number(netTotal)) {
    errors.push(`Refund cannot exceed the credit total of ${fmtMoney(netTotal)}`);
  }
  if (needsBranch && branchId === null) errors.push('Select a branch');

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>(`/${config.endpoint}`, {
        date,
        [config.partyField]: partyId,
        ...(branchId !== null ? { branchId } : {}),
        ...(config.partyField === 'custId' && againstInvoice
          ? { saleId: Number(againstInvoice) }
          : {}),
        ...(config.hasFreight ? { rent: grid.service } : {}),
        discount: grid.invoiceDiscount,
        [config.refundField]: grid.received,
        notes: notes || null,
        lines: grid.validLines.map((l) => ({
          pid: l.pid,
          qty: l.qty,
          price: l.price,
          discount: l.discount,
        })),
      }),
    onSuccess: (result) => {
      toast.success(`${config.title} #${result.id} saved`);
      void queryClient.invalidateQueries({ queryKey: [config.endpoint] });
      onDone();
    },
    onError: (err) => {
      // The over-credit guard reports here — the server tracks how much has
      // already been returned against the original invoice.
      toast.error(err instanceof ApiError ? err.message : `Could not save the ${config.title}`);
    },
  });

  const blocked = errors.length > 0 || partyId === null;
  const showAgainst = config.partyField === 'custId';

  return (
    <>
      <PageHeader
        title={`New ${config.title}`}
        subtitle="Return details"
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
              {save.isPending ? 'Saving…' : `Save ${config.title}`}
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
          <label htmlFor="party" className="field-label">
            {config.partyLabel}
            <span className="ml-0.5 text-red-500">*</span>
          </label>
          <select
            id="party"
            className="field-input"
            value={partyId ?? ''}
            onChange={(e) => setPartyId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Select a {config.partyLabel.toLowerCase()}…</option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.phone ? ` — ${p.phone}` : ''}
              </option>
            ))}
          </select>
        </div>

        {showAgainst && (
          <Field
            label="Against invoice"
            name="against"
            type="number"
            value={againstInvoice}
            onChange={(e) => setAgainstInvoice(e.target.value)}
            hint="Optional. Limits the credit to the invoice value."
          />
        )}

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

        {!showAgainst && (
          <Field
            label="Notes"
            name="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        )}
      </div>

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
            ...(config.hasFreight
              ? [{ label: 'Freight', value: grid.service, onChange: grid.setService }]
              : []),
            { label: 'Credit total', value: netTotal, emphasis: true, divider: true },
            { label: 'Refunded', value: grid.received, onChange: grid.setReceived },
            { label: 'Balance', value: remaining, emphasis: true, divider: true },
          ]}
        />
      </div>
    </>
  );
}
