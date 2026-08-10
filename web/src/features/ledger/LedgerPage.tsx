import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/Field';

interface LedgerRow {
  transId: number;
  date: string;
  vtype: string;
  invId: number;
  detail: string;
  dr: string;
  cr: string;
  balance: string;
}

interface LedgerResult {
  account: { accountId: number; name: string; headId: number; debitNormal: boolean };
  from: string;
  to: string;
  opening: string;
  rows: LedgerRow[];
  totals: { dr: string; cr: string };
  closing: string;
}

interface AccountOption {
  account_id: number;
  name: string | null;
  head_id: number;
}

const startOfYear = () => `${new Date().getFullYear()}-01-01`;
const today = () => new Date().toISOString().slice(0, 10);

export function LedgerPage() {
  const [accountId, setAccountId] = useState<number | null>(null);
  const [from, setFrom] = useState(startOfYear());
  const [to, setTo] = useState(today());
  const [submitted, setSubmitted] = useState<{ accountId: number; from: string; to: string } | null>(
    null,
  );

  const accounts = useQuery({
    queryKey: ['ledger', 'accounts'],
    queryFn: () => api.get<AccountOption[]>('/ledger/accounts'),
  });

  const ledger = useQuery({
    queryKey: ['ledger', submitted],
    queryFn: () =>
      api.get<LedgerResult>(
        `/ledger?accountId=${submitted!.accountId}&from=${submitted!.from}&to=${submitted!.to}`,
      ),
    enabled: submitted !== null,
  });

  return (
    <>
      <PageHeader title="Account Ledger" subtitle="Movements and running balance for one account" />

      <form
        className="card no-print mb-4 flex flex-wrap items-end gap-3 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (accountId !== null) setSubmitted({ accountId, from, to });
        }}
      >
        <div className="min-w-64 flex-1">
          <label htmlFor="account" className="field-label">
            Account
          </label>
          <select
            id="account"
            className="field-input"
            value={accountId ?? ''}
            onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Select an account…</option>
            {accounts.data?.map((a) => (
              <option key={a.account_id} value={a.account_id}>
                {a.account_id} — {a.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="from" className="field-label">
            From
          </label>
          <input
            id="from"
            type="date"
            className="field-input"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor="to" className="field-label">
            To
          </label>
          <input
            id="to"
            type="date"
            className="field-input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>

        <button type="submit" className="btn-primary" disabled={accountId === null}>
          <Search className="size-3.5" />
          Show
        </button>

        {ledger.data && (
          <button type="button" className="btn-secondary" onClick={() => window.print()}>
            Print
          </button>
        )}
      </form>

      {ledger.isFetching && (
        <div className="grid place-items-center p-10">
          <Loader2 className="size-5 animate-spin text-slate-400" />
        </div>
      )}

      {ledger.error && (
        <p className="card p-4 text-sm text-red-600">{(ledger.error as Error).message}</p>
      )}

      {ledger.data && !ledger.isFetching && (
        <>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-900">
              {ledger.data.account.accountId} — {ledger.data.account.name}
            </h2>
            <p className="text-xs text-slate-500">
              {ledger.data.from} to {ledger.data.to} ·{' '}
              {ledger.data.account.debitNormal ? 'Debit-normal' : 'Credit-normal'} account
            </p>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase">
                  <th className="w-24 px-2 py-2 text-left">Date</th>
                  <th className="w-20 px-2 py-2 text-left">Type</th>
                  <th className="w-20 px-2 py-2 text-right">Voucher</th>
                  <th className="px-2 py-2 text-left">Detail</th>
                  <th className="w-28 px-2 py-2 text-right">Debit</th>
                  <th className="w-28 px-2 py-2 text-right">Credit</th>
                  <th className="w-32 px-2 py-2 text-right">Balance</th>
                </tr>
              </thead>

              <tbody>
                <tr className="border-b border-slate-200 bg-slate-50/60">
                  <td colSpan={6} className="px-2 py-1.5 font-medium text-slate-700">
                    Opening balance
                  </td>
                  <td className="px-2 py-1.5 text-right font-semibold tabular">
                    {fmtMoney(ledger.data.opening)}
                  </td>
                </tr>

                {ledger.data.rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-2 py-8 text-center text-sm text-slate-400">
                      No movements in this period
                    </td>
                  </tr>
                )}

                {ledger.data.rows.map((r, i) => (
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
                      {Number(r.dr) ? fmtMoney(r.dr) : ''}
                    </td>
                    <td className="px-2 py-1 text-right tabular">
                      {Number(r.cr) ? fmtMoney(r.cr) : ''}
                    </td>
                    <td className="px-2 py-1 text-right font-medium tabular">
                      {fmtMoney(r.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>

              <tfoot>
                <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                  <td colSpan={4} className="px-2 py-1.5">
                    Closing balance
                  </td>
                  <td className="px-2 py-1.5 text-right tabular">
                    {fmtMoney(ledger.data.totals.dr)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular">
                    {fmtMoney(ledger.data.totals.cr)}
                  </td>
                  <td
                    className={cn(
                      'px-2 py-1.5 text-right tabular',
                      Number(ledger.data.closing) < 0 && 'text-red-600',
                    )}
                  >
                    {fmtMoney(ledger.data.closing)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </>
  );
}
