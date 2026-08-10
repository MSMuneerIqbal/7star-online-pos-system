import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { ReportShell, ReportTable } from './ReportShell';

export type StockKind = 'raw' | 'finish';

const KIND_LABEL: Record<StockKind, string> = { raw: 'Raw Material', finish: 'Finished Goods' };

const today = () => new Date().toISOString().slice(0, 10);

/** Trim trailing zeros so quantities read 2 and 2.5 rather than 2.000. */
const qty = (v: string) => String(Number(v));

interface StockRow {
  pid: number;
  name: string;
  opening: string;
  inQty: string;
  outQty: string;
  closing: string;
  reorderLevel: string;
  belowReorder: boolean;
  value: string;
}

interface StockReport {
  asAt: string;
  kind: string;
  rows: StockRow[];
  totalValue: string;
}

export function StockReportPage({ kind }: { kind: StockKind }) {
  const [asAt, setAsAt] = useState<string | null>(today());

  const { data, isFetching, error } = useQuery({
    queryKey: ['stock-report', kind, asAt],
    queryFn: () => api.get<StockReport>(`/reports/stock/${kind}?asAt=${asAt}`),
    enabled: asAt !== null,
  });

  const lowStock = data?.rows.filter((r) => r.belowReorder) ?? [];

  return (
    <ReportShell
      title={`Stock Report — ${KIND_LABEL[kind]}`}
      subtitle="Quantity on hand and value at cost"
      filter="asAt"
      loading={isFetching}
      error={error ? (error as Error).message : null}
      onRun={(p) => setAsAt(p.asAt)}
    >
      {data && (
        <>
          {lowStock.length > 0 && (
            <div
              role="status"
              className="card mb-3 flex gap-2 border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                <strong>{lowStock.length}</strong> item
                {lowStock.length === 1 ? ' is' : 's are'} below the reorder level:{' '}
                {lowStock.slice(0, 5).map((r) => r.name).join(', ')}
                {lowStock.length > 5 && ` and ${lowStock.length - 5} more`}.
              </span>
            </div>
          )}

          <ReportTable
            headers={[
              { label: 'Item' },
              { label: 'Opening', numeric: true, width: '7rem' },
              { label: 'In', numeric: true, width: '7rem' },
              { label: 'Out', numeric: true, width: '7rem' },
              { label: 'Closing', numeric: true, width: '8rem' },
              { label: 'Reorder', numeric: true, width: '7rem' },
              { label: 'Value at cost', numeric: true, width: '10rem' },
            ]}
            isEmpty={data.rows.length === 0}
            empty="No items in this catalog"
            footer={
              <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                <td colSpan={6} className="px-2 py-1.5">
                  Total stock value
                </td>
                <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totalValue)}</td>
              </tr>
            }
          >
            {data.rows.map((r) => (
              <tr
                key={r.pid}
                className={cn('border-b border-slate-100', r.belowReorder && 'bg-amber-50/50')}
              >
                <td className="px-2 py-1">{r.name}</td>
                <td className="px-2 py-1 text-right tabular">{qty(r.opening)}</td>
                <td className="px-2 py-1 text-right text-emerald-700 tabular">
                  {Number(r.inQty) ? qty(r.inQty) : ''}
                </td>
                <td className="px-2 py-1 text-right text-red-600 tabular">
                  {Number(r.outQty) ? qty(r.outQty) : ''}
                </td>
                <td
                  className={cn(
                    'px-2 py-1 text-right font-medium tabular',
                    Number(r.closing) < 0 && 'text-red-600',
                  )}
                >
                  {qty(r.closing)}
                </td>
                <td className="px-2 py-1 text-right text-slate-500 tabular">
                  {qty(r.reorderLevel)}
                </td>
                <td className="px-2 py-1 text-right tabular">{fmtMoney(r.value)}</td>
              </tr>
            ))}
          </ReportTable>
        </>
      )}
    </ReportShell>
  );
}

// ---------------------------------------------------------------------------

interface ItemLedgerRow {
  date: string;
  source: string;
  docId: number;
  branchId: number;
  qty: string;
  price: string;
  balance: string;
}

interface ItemLedger {
  item: { pid: number; name: string; kind: string };
  from: string;
  to: string;
  opening: string;
  rows: ItemLedgerRow[];
  closing: string;
}

/** How each movement source reads in the ledger. */
const SOURCE_LABEL: Record<string, string> = {
  PINV: 'Purchase',
  PRINV: 'Purchase Return',
  SINV: 'Sale',
  SRINV: 'Sale Return',
  PROD: 'Production',
  LAB: 'Lab',
  BTINV: 'Transfer out',
  DORINV: 'Transfer in',
};

export function ItemLedgerPage({ kind }: { kind: StockKind }) {
  const [params, setParams] = useState<{ pid: number; from: string; to: string } | null>(null);

  const items = useQuery({
    queryKey: ['report-items', kind],
    queryFn: () => api.get<{ id: number; name: string | null }[]>(`/reports/items/${kind}`),
  });

  const { data, isFetching, error } = useQuery({
    queryKey: ['item-ledger', kind, params],
    queryFn: () =>
      api.get<ItemLedger>(
        `/reports/item-ledger/${kind}?pid=${params!.pid}&from=${params!.from}&to=${params!.to}`,
      ),
    enabled: params !== null,
  });

  return (
    <ReportShell
      title={`Item Ledger — ${KIND_LABEL[kind]}`}
      subtitle="Every movement of one item, with a running quantity"
      filter="rangeWithItem"
      items={items.data ?? []}
      loading={isFetching}
      error={error ? (error as Error).message : null}
      onRun={(p) => {
        if (p.pid !== null) setParams({ pid: p.pid, from: p.from, to: p.to });
      }}
    >
      {data && (
        <>
          <h2 className="mb-2 text-base font-semibold text-slate-900">{data.item.name}</h2>

          <ReportTable
            headers={[
              { label: 'Date', width: '7rem' },
              { label: 'Source', width: '9rem' },
              { label: 'Document', numeric: true, width: '6rem' },
              { label: 'Branch', numeric: true, width: '5rem' },
              { label: 'In', numeric: true, width: '7rem' },
              { label: 'Out', numeric: true, width: '7rem' },
              { label: 'Balance', numeric: true, width: '8rem' },
            ]}
            footer={
              <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                <td colSpan={6} className="px-2 py-1.5">
                  Closing quantity
                </td>
                <td className="px-2 py-1.5 text-right tabular">{qty(data.closing)}</td>
              </tr>
            }
          >
            <tr className="border-b border-slate-200 bg-slate-50/60">
              <td colSpan={6} className="px-2 py-1.5 font-medium text-slate-700">
                Opening quantity
              </td>
              <td className="px-2 py-1.5 text-right font-semibold tabular">
                {qty(data.opening)}
              </td>
            </tr>

            {data.rows.map((r, i) => (
              <tr key={`${r.source}-${r.docId}-${i}`} className="border-b border-slate-100">
                <td className="px-2 py-1 whitespace-nowrap tabular">{r.date}</td>
                <td className="px-2 py-1">{SOURCE_LABEL[r.source] ?? r.source}</td>
                <td className="px-2 py-1 text-right tabular">{r.docId}</td>
                <td className="px-2 py-1 text-right tabular">{r.branchId}</td>
                <td className="px-2 py-1 text-right text-emerald-700 tabular">
                  {Number(r.qty) > 0 ? qty(r.qty) : ''}
                </td>
                <td className="px-2 py-1 text-right text-red-600 tabular">
                  {Number(r.qty) < 0 ? qty(String(-Number(r.qty))) : ''}
                </td>
                <td className="px-2 py-1 text-right font-medium tabular">{qty(r.balance)}</td>
              </tr>
            ))}
          </ReportTable>
        </>
      )}
    </ReportShell>
  );
}
