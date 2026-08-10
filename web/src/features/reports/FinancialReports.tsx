import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { ReportShell, ReportTable, type ReportParams } from './ReportShell';

interface StatementLine {
  accountId: number;
  name: string;
  amount: string;
}

// ---------------------------------------------------------------------------

interface BalanceSheet {
  asAt: string;
  assets: StatementLine[];
  liabilities: StatementLine[];
  equity: StatementLine[];
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  retainedProfit: string;
  totalEquityAndLiabilities: string;
  balanced: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);

function Section({ title, lines }: { title: string; lines: StatementLine[] }) {
  return (
    <>
      <tr className="bg-slate-50/70">
        <td colSpan={2} className="px-2 py-1 text-xs font-semibold tracking-wide text-slate-600 uppercase">
          {title}
        </td>
      </tr>
      {lines.length === 0 && (
        <tr className="border-b border-slate-100">
          <td colSpan={2} className="px-2 py-1 text-sm text-slate-400">
            None
          </td>
        </tr>
      )}
      {lines.map((l) => (
        <tr key={l.accountId} className="border-b border-slate-100">
          <td className="px-2 py-1">
            <span className="mr-2 text-xs text-slate-400 tabular">{l.accountId}</span>
            {l.name}
          </td>
          <td className="px-2 py-1 text-right tabular">{fmtMoney(l.amount)}</td>
        </tr>
      ))}
    </>
  );
}

/**
 * Balance sheet — the report that proves the books are sound.
 *
 * It could not have existed in the legacy system: with unbalanced sale and
 * inter-branch postings, assets would never have equalled liabilities plus
 * equity.
 */
export function BalanceSheetPage() {
  const [asAt, setAsAt] = useState<string | null>(today());

  const { data, isFetching, error } = useQuery({
    queryKey: ['balance-sheet', asAt],
    queryFn: () => api.get<BalanceSheet>(`/reports/balance-sheet?asAt=${asAt}`),
    enabled: asAt !== null,
  });

  return (
    <ReportShell
      title="Balance Sheet"
      subtitle="Financial position as at a date"
      filter="asAt"
      loading={isFetching}
      error={error ? (error as Error).message : null}
      onRun={(p: ReportParams) => setAsAt(p.asAt)}
    >
      {data && (
        <>
          <div
            role="status"
            className={cn(
              'card mb-3 flex items-center gap-2 p-3 text-sm',
              data.balanced
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-red-200 bg-red-50 text-red-900',
            )}
          >
            {data.balanced ? (
              <>
                <CheckCircle2 className="size-4 shrink-0" />
                <span>
                  Balanced — assets and claims both total{' '}
                  <strong className="tabular">{fmtMoney(data.totalAssets)}</strong>.
                </span>
              </>
            ) : (
              <>
                <XCircle className="size-4 shrink-0" />
                <span>
                  Out of balance by{' '}
                  <strong className="tabular">
                    {fmtMoney(
                      String(Number(data.totalAssets) - Number(data.totalEquityAndLiabilities)),
                    )}
                  </strong>
                  .
                </span>
              </>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ReportTable headers={[{ label: 'Assets' }, { label: 'Amount', numeric: true, width: '10rem' }]}>
              <Section title="Assets" lines={data.assets} />
              <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                <td className="px-2 py-1.5">Total assets</td>
                <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totalAssets)}</td>
              </tr>
            </ReportTable>

            <ReportTable
              headers={[{ label: 'Equity & liabilities' }, { label: 'Amount', numeric: true, width: '10rem' }]}
            >
              <Section title="Liabilities" lines={data.liabilities} />
              <Section title="Equity" lines={data.equity} />
              <tr className="border-b border-slate-100">
                <td className="px-2 py-1 italic text-slate-600">
                  Retained profit
                  <span className="ml-1 text-xs text-slate-400">(derived — books are never closed)</span>
                </td>
                <td className="px-2 py-1 text-right tabular">{fmtMoney(data.retainedProfit)}</td>
              </tr>
              <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                <td className="px-2 py-1.5">Total equity &amp; liabilities</td>
                <td className="px-2 py-1.5 text-right tabular">
                  {fmtMoney(data.totalEquityAndLiabilities)}
                </td>
              </tr>
            </ReportTable>
          </div>
        </>
      )}
    </ReportShell>
  );
}

// ---------------------------------------------------------------------------

interface IncomeStatement {
  from: string;
  to: string;
  revenue: StatementLine[];
  expenses: StatementLine[];
  totalRevenue: string;
  totalExpenses: string;
  netProfit: string;
}

export function IncomeStatementPage() {
  const [range, setRange] = useState<{ from: string; to: string } | null>({
    from: `${new Date().getFullYear()}-01-01`,
    to: today(),
  });

  const { data, isFetching, error } = useQuery({
    queryKey: ['income-statement', range],
    queryFn: () =>
      api.get<IncomeStatement>(`/reports/income-statement?from=${range!.from}&to=${range!.to}`),
    enabled: range !== null,
  });

  const profit = Number(data?.netProfit ?? 0);

  return (
    <ReportShell
      title="Income Statement"
      subtitle="Revenue and expenses over a period"
      filter="range"
      loading={isFetching}
      error={error ? (error as Error).message : null}
      onRun={(p) => setRange({ from: p.from, to: p.to })}
    >
      {data && (
        <ReportTable
          headers={[{ label: 'Account' }, { label: 'Amount', numeric: true, width: '12rem' }]}
          isEmpty={data.revenue.length === 0 && data.expenses.length === 0}
          empty="No revenue or expenses in this period"
        >
          <Section title="Revenue" lines={data.revenue} />
          <tr className="border-b border-slate-200 font-medium">
            <td className="px-2 py-1">Total revenue</td>
            <td className="px-2 py-1 text-right tabular">{fmtMoney(data.totalRevenue)}</td>
          </tr>

          <Section title="Expenses" lines={data.expenses} />
          <tr className="border-b border-slate-200 font-medium">
            <td className="px-2 py-1">Total expenses</td>
            <td className="px-2 py-1 text-right tabular">{fmtMoney(data.totalExpenses)}</td>
          </tr>

          <tr className="border-t-2 border-slate-300 bg-slate-50 text-base font-semibold">
            <td className="px-2 py-2">{profit >= 0 ? 'Net profit' : 'Net loss'}</td>
            <td
              className={cn(
                'px-2 py-2 text-right tabular',
                profit >= 0 ? 'text-emerald-700' : 'text-red-600',
              )}
            >
              {fmtMoney(data.netProfit)}
            </td>
          </tr>
        </ReportTable>
      )}
    </ReportShell>
  );
}

// ---------------------------------------------------------------------------

interface CashBookRow {
  date: string;
  vtype: string;
  transId: number;
  detail: string;
  receipt: string;
  payment: string;
  balance: string;
}

interface CashBook {
  from: string;
  to: string;
  opening: string;
  rows: CashBookRow[];
  totals: { receipts: string; payments: string };
  closing: string;
}

export function CashBookPage() {
  const [range, setRange] = useState<{ from: string; to: string } | null>({
    from: `${new Date().getFullYear()}-01-01`,
    to: today(),
  });

  const { data, isFetching, error } = useQuery({
    queryKey: ['cash-book', range],
    queryFn: () => api.get<CashBook>(`/reports/cash-book?from=${range!.from}&to=${range!.to}`),
    enabled: range !== null,
  });

  return (
    <ReportShell
      title="Cash Book"
      subtitle="Cash receipts and payments with a running balance"
      filter="range"
      loading={isFetching}
      error={error ? (error as Error).message : null}
      onRun={(p) => setRange({ from: p.from, to: p.to })}
    >
      {data && (
        <ReportTable
          headers={[
            { label: 'Date', width: '7rem' },
            { label: 'Type', width: '5rem' },
            { label: 'Voucher', numeric: true, width: '5rem' },
            { label: 'Detail' },
            { label: 'Receipt', numeric: true, width: '8rem' },
            { label: 'Payment', numeric: true, width: '8rem' },
            { label: 'Balance', numeric: true, width: '9rem' },
          ]}
          footer={
            <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
              <td colSpan={4} className="px-2 py-1.5">
                Closing balance
              </td>
              <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totals.receipts)}</td>
              <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totals.payments)}</td>
              <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.closing)}</td>
            </tr>
          }
        >
          <tr className="border-b border-slate-200 bg-slate-50/60">
            <td colSpan={6} className="px-2 py-1.5 font-medium text-slate-700">
              Opening balance
            </td>
            <td className="px-2 py-1.5 text-right font-semibold tabular">
              {fmtMoney(data.opening)}
            </td>
          </tr>

          {data.rows.map((r, i) => (
            <tr key={`${r.transId}-${i}`} className="border-b border-slate-100">
              <td className="px-2 py-1 whitespace-nowrap tabular">{r.date}</td>
              <td className="px-2 py-1">
                <span className="rounded-sm bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                  {r.vtype}
                </span>
              </td>
              <td className="px-2 py-1 text-right tabular">{r.transId}</td>
              <td className="px-2 py-1 text-slate-600">{r.detail}</td>
              <td className="px-2 py-1 text-right tabular">
                {Number(r.receipt) ? fmtMoney(r.receipt) : ''}
              </td>
              <td className="px-2 py-1 text-right tabular">
                {Number(r.payment) ? fmtMoney(r.payment) : ''}
              </td>
              <td className="px-2 py-1 text-right font-medium tabular">{fmtMoney(r.balance)}</td>
            </tr>
          ))}
        </ReportTable>
      )}
    </ReportShell>
  );
}
