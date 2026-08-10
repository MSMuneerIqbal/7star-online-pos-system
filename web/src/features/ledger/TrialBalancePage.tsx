import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2, Printer, Search, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtMoney } from '@/lib/money';
import { PageHeader } from '@/components/ui/Field';

interface TrialRow {
  accountId: number;
  name: string;
  headId: number;
  dr: string;
  cr: string;
}

interface TrialBalance {
  asAt: string;
  rows: TrialRow[];
  totals: { dr: string; cr: string };
  balanced: boolean;
}

const HEAD_NAME: Record<number, string> = {
  1: 'Assets',
  2: 'Liabilities',
  3: 'Equity',
  4: 'Revenue',
  5: 'Expenses',
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Trial balance — one of the ten screens the legacy system linked but never
 * built. It could not have worked there: with the unbalanced sale posting
 * (db/accounts.md §4.1) it would never have tied out.
 */
export function TrialBalancePage() {
  const [asAt, setAsAt] = useState(today());
  const [submitted, setSubmitted] = useState<string | null>(today());

  const { data, isFetching, error } = useQuery({
    queryKey: ['trial-balance', submitted],
    queryFn: () => api.get<TrialBalance>(`/ledger/trial-balance?asAt=${submitted}`),
    enabled: submitted !== null,
  });

  // Group by account head so the statement reads the way an accountant expects.
  const grouped = (data?.rows ?? []).reduce<Record<number, TrialRow[]>>((acc, row) => {
    (acc[row.headId] ??= []).push(row);
    return acc;
  }, {});

  return (
    <>
      <PageHeader title="Trial Balance" subtitle="Every account's position as at a date" />

      <form
        className="card no-print mb-4 flex flex-wrap items-end gap-3 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(asAt);
        }}
      >
        <div>
          <label htmlFor="asAt" className="field-label">
            As at
          </label>
          <input
            id="asAt"
            type="date"
            className="field-input"
            value={asAt}
            onChange={(e) => setAsAt(e.target.value)}
          />
        </div>

        <button type="submit" className="btn-primary">
          <Search className="size-3.5" />
          Show
        </button>

        {data && (
          <button type="button" className="btn-secondary" onClick={() => window.print()}>
            <Printer className="size-3.5" />
            Print
          </button>
        )}
      </form>

      {isFetching && (
        <div className="grid place-items-center p-10">
          <Loader2 className="size-5 animate-spin text-slate-400" />
        </div>
      )}

      {error && <p className="card p-4 text-sm text-red-600">{(error as Error).message}</p>}

      {data && !isFetching && (
        <>
          <div
            role="status"
            className={
              data.balanced
                ? 'card mb-3 flex items-center gap-2 border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900'
                : 'card mb-3 flex items-center gap-2 border-red-200 bg-red-50 p-3 text-sm text-red-900'
            }
          >
            {data.balanced ? (
              <>
                <CheckCircle2 className="size-4 shrink-0" />
                <span>
                  The books balance. Debits and credits both total{' '}
                  <strong className="tabular">{fmtMoney(data.totals.dr)}</strong>.
                </span>
              </>
            ) : (
              <>
                <XCircle className="size-4 shrink-0" />
                <span>
                  Out of balance by{' '}
                  <strong className="tabular">
                    {fmtMoney(String(Number(data.totals.dr) - Number(data.totals.cr)))}
                  </strong>
                  . Run <code>scripts/check-ledger.ts</code> to find the voucher.
                </span>
              </>
            )}
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase">
                  <th className="w-28 px-2 py-2 text-left">Code</th>
                  <th className="px-2 py-2 text-left">Account</th>
                  <th className="w-36 px-2 py-2 text-right">Debit</th>
                  <th className="w-36 px-2 py-2 text-right">Credit</th>
                </tr>
              </thead>

              <tbody>
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-2 py-8 text-center text-sm text-slate-400">
                      No postings on or before {data.asAt}
                    </td>
                  </tr>
                )}

                {Object.entries(grouped).map(([headId, rows]) => (
                  <>
                    <tr key={`head-${headId}`} className="bg-slate-50/70">
                      <td
                        colSpan={4}
                        className="px-2 py-1 text-xs font-semibold tracking-wide text-slate-600 uppercase"
                      >
                        {HEAD_NAME[Number(headId)] ?? `Head ${headId}`}
                      </td>
                    </tr>

                    {rows.map((r) => (
                      <tr key={r.accountId} className="border-b border-slate-100">
                        <td className="px-2 py-1 tabular">{r.accountId}</td>
                        <td className="px-2 py-1">{r.name}</td>
                        <td className="px-2 py-1 text-right tabular">
                          {Number(r.dr) ? fmtMoney(r.dr) : ''}
                        </td>
                        <td className="px-2 py-1 text-right tabular">
                          {Number(r.cr) ? fmtMoney(r.cr) : ''}
                        </td>
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>

              <tfoot>
                <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                  <td colSpan={2} className="px-2 py-1.5">
                    Total
                  </td>
                  <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totals.dr)}</td>
                  <td className="px-2 py-1.5 text-right tabular">{fmtMoney(data.totals.cr)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </>
  );
}
