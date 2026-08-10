import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fmtMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { ReportShell, ReportTable } from './ReportShell';

const today = () => new Date().toISOString().slice(0, 10);
const startOfYear = () => `${new Date().getFullYear()}-01-01`;

interface SaleRow {
  id: number;
  date: string;
  party: string | null;
  gross_total: string;
  discount: string;
  service: string;
  net_total: string;
  received: string;
  remaining: string;
}

interface SaleReport {
  from: string;
  to: string;
  rows: SaleRow[];
  count: number;
  totals: {
    gross: string;
    discount: string;
    service: string;
    net: string;
    received: string;
    remaining: string;
  };
}

export function SaleReportPage() {
  const [range, setRange] = useState<{ from: string; to: string } | null>({
    from: startOfYear(),
    to: today(),
  });

  const { data, isFetching, error } = useQuery({
    queryKey: ['sale-report', range],
    queryFn: () => api.get<SaleReport>(`/reports/sales?from=${range!.from}&to=${range!.to}`),
    enabled: range !== null,
  });

  return (
    <ReportShell
      title="Sale Report"
      subtitle="Every sales invoice over a period"
      filter="range"
      loading={isFetching}
      error={error ? (error as Error).message : null}
      onRun={(p) => setRange({ from: p.from, to: p.to })}
    >
      {data && (
        <>
          <p className="no-print mb-2 text-sm text-slate-500">
            <strong className="tabular">{data.count}</strong> invoice
            {data.count === 1 ? '' : 's'} · outstanding{' '}
            <strong className="tabular">{fmtMoney(data.totals.remaining)}</strong>
          </p>

          <ReportTable
            headers={[
              { label: 'Invoice', numeric: true, width: '5.5rem' },
              { label: 'Date', width: '7rem' },
              { label: 'Customer' },
              { label: 'Gross', numeric: true, width: '8rem' },
              { label: 'Discount', numeric: true, width: '8rem' },
              { label: 'Service', numeric: true, width: '7rem' },
              { label: 'Net', numeric: true, width: '9rem' },
              { label: 'Received', numeric: true, width: '8rem' },
              { label: 'Outstanding', numeric: true, width: '9rem' },
            ]}
            isEmpty={data.rows.length === 0}
            empty="No sales in this period"
            footer={
              <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                <td colSpan={3} className="px-2 py-1.5">
                  Total
                </td>
                <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totals.gross)}</td>
                <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totals.discount)}</td>
                <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totals.service)}</td>
                <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totals.net)}</td>
                <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totals.received)}</td>
                <td className="px-2 py-1.5 text-right tabular">
                  {fmtMoney(data.totals.remaining)}
                </td>
              </tr>
            }
          >
            {data.rows.map((r) => (
              <tr key={r.id} className="border-b border-slate-100">
                <td className="px-2 py-1 text-right tabular">{r.id}</td>
                <td className="px-2 py-1 whitespace-nowrap tabular">{r.date}</td>
                <td className="px-2 py-1">{r.party ?? '—'}</td>
                <td className="px-2 py-1 text-right tabular">{fmtMoney(r.gross_total)}</td>
                <td className="px-2 py-1 text-right tabular">{fmtMoney(r.discount)}</td>
                <td className="px-2 py-1 text-right tabular">{fmtMoney(r.service)}</td>
                <td className="px-2 py-1 text-right font-medium tabular">
                  {fmtMoney(r.net_total)}
                </td>
                <td className="px-2 py-1 text-right tabular">{fmtMoney(r.received)}</td>
                <td
                  className={cn(
                    'px-2 py-1 text-right tabular',
                    Number(r.remaining) > 0 && 'font-medium text-amber-700',
                  )}
                >
                  {fmtMoney(r.remaining)}
                </td>
              </tr>
            ))}
          </ReportTable>
        </>
      )}
    </ReportShell>
  );
}

// ---------------------------------------------------------------------------

interface PurchaseRow {
  id: number;
  date: string;
  party: string | null;
  sub_total: string;
  discount: string;
  rent: string;
  net_total: string;
  paid: string;
  remaining: string;
}

interface PurchaseReport {
  from: string;
  to: string;
  rows: PurchaseRow[];
  count: number;
  totals: {
    sub: string;
    discount: string;
    freight: string;
    net: string;
    paid: string;
    remaining: string;
  };
}

export function PurchaseReportPage() {
  const [range, setRange] = useState<{ from: string; to: string } | null>({
    from: startOfYear(),
    to: today(),
  });

  const { data, isFetching, error } = useQuery({
    queryKey: ['purchase-report', range],
    queryFn: () => api.get<PurchaseReport>(`/reports/purchases?from=${range!.from}&to=${range!.to}`),
    enabled: range !== null,
  });

  return (
    <ReportShell
      title="Purchase Report"
      subtitle="Every purchase invoice over a period"
      filter="range"
      loading={isFetching}
      error={error ? (error as Error).message : null}
      onRun={(p) => setRange({ from: p.from, to: p.to })}
    >
      {data && (
        <>
          <p className="no-print mb-2 text-sm text-slate-500">
            <strong className="tabular">{data.count}</strong> invoice
            {data.count === 1 ? '' : 's'} · payable{' '}
            <strong className="tabular">{fmtMoney(data.totals.remaining)}</strong>
          </p>

          <ReportTable
            headers={[
              { label: 'Invoice', numeric: true, width: '5.5rem' },
              { label: 'Date', width: '7rem' },
              { label: 'Supplier' },
              { label: 'Sub total', numeric: true, width: '9rem' },
              { label: 'Discount', numeric: true, width: '8rem' },
              { label: 'Freight', numeric: true, width: '8rem' },
              { label: 'Net', numeric: true, width: '9rem' },
              { label: 'Paid', numeric: true, width: '8rem' },
              { label: 'Outstanding', numeric: true, width: '9rem' },
            ]}
            isEmpty={data.rows.length === 0}
            empty="No purchases in this period"
            footer={
              <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                <td colSpan={3} className="px-2 py-1.5">
                  Total
                </td>
                <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totals.sub)}</td>
                <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totals.discount)}</td>
                <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totals.freight)}</td>
                <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totals.net)}</td>
                <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totals.paid)}</td>
                <td className="px-2 py-1.5 text-right tabular">
                  {fmtMoney(data.totals.remaining)}
                </td>
              </tr>
            }
          >
            {data.rows.map((r) => (
              <tr key={r.id} className="border-b border-slate-100">
                <td className="px-2 py-1 text-right tabular">{r.id}</td>
                <td className="px-2 py-1 whitespace-nowrap tabular">{r.date}</td>
                <td className="px-2 py-1">{r.party ?? '—'}</td>
                <td className="px-2 py-1 text-right tabular">{fmtMoney(r.sub_total)}</td>
                <td className="px-2 py-1 text-right tabular">{fmtMoney(r.discount)}</td>
                <td className="px-2 py-1 text-right tabular">{fmtMoney(r.rent)}</td>
                <td className="px-2 py-1 text-right font-medium tabular">
                  {fmtMoney(r.net_total)}
                </td>
                <td className="px-2 py-1 text-right tabular">{fmtMoney(r.paid)}</td>
                <td
                  className={cn(
                    'px-2 py-1 text-right tabular',
                    Number(r.remaining) > 0 && 'font-medium text-amber-700',
                  )}
                >
                  {fmtMoney(r.remaining)}
                </td>
              </tr>
            ))}
          </ReportTable>
        </>
      )}
    </ReportShell>
  );
}
