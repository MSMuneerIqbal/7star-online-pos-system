import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { addMoney, fmtMoney, subMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { Field, PageHeader } from '@/components/ui/Field';

export type VoucherType = 'CRV' | 'CPV' | 'BRV' | 'BPV' | 'JV';

/** Legacy form/action codes, one set per voucher type. */
export const VOUCHER_META: Record<
  VoucherType,
  { label: string; subtitle: string; formId: number; create: number }
> = {
  CRV: {
    label: 'Cash Receipt (CRV)',
    subtitle: 'Money received into the cash account',
    formId: 42,
    create: 7092,
  },
  CPV: {
    label: 'Cash Payment (CPV)',
    subtitle: 'Money paid out of the cash account',
    formId: 43,
    create: 7102,
  },
  BRV: {
    label: 'Bank Receipt (BRV)',
    subtitle: 'Money received into the bank account',
    formId: 44,
    create: 7112,
  },
  BPV: {
    label: 'Bank Payment (BPV)',
    subtitle: 'Money paid out of the bank account',
    formId: 45,
    create: 7122,
  },
  JV: {
    label: 'Journal Voucher (JV)',
    subtitle: 'Manual adjustment between any two accounts',
    formId: 46,
    create: 7132,
  },
};

interface VoucherRow {
  id: number;
  date: string;
  vno: string | null;
  amount: string;
  detail: string | null;
  tran_id: number;
}

interface FormData {
  accounts: { account_id: number; name: string | null; head_id: number }[];
  branches: { id: number; name: string }[];
  counterAccount: number | null;
  label: string;
  requiresCheque: boolean;
}

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface Line {
  key: string;
  accountId: number | null;
  dr: string;
  cr: string;
  detail: string;
  chequeNo: string;
}

let counter = 0;
const emptyLine = (): Line => ({
  key: `vl-${++counter}`,
  accountId: null,
  dr: '0',
  cr: '0',
  detail: '',
  chequeNo: '',
});

const today = () => new Date().toISOString().slice(0, 10);

export function VoucherPage({ type }: { type: VoucherType }) {
  const { hasAction } = useAuth();
  const meta = VOUCHER_META[type];

  const [page, setPage] = useState(1);
  const [composing, setComposing] = useState(false);

  const list = useQuery({
    queryKey: ['vouchers', type, page],
    queryFn: () => api.get<Paged<VoucherRow>>(`/vouchers/${type}?page=${page}&pageSize=20`),
    enabled: !composing,
  });

  const columns: readonly Column<VoucherRow>[] = [
    { key: 'id', header: 'No.', numeric: true, width: '5rem' },
    { key: 'date', header: 'Date', width: '8rem' },
    { key: 'vno', header: 'Voucher', cell: (r) => r.vno ?? '—', width: '9rem' },
    { key: 'detail', header: 'Narration', cell: (r) => r.detail ?? '—' },
    { key: 'amount', header: 'Amount', numeric: true, cell: (r) => fmtMoney(r.amount) },
  ];

  if (composing) {
    return <VoucherComposer type={type} onDone={() => setComposing(false)} />;
  }

  return (
    <>
      <PageHeader
        title={meta.label}
        subtitle={meta.subtitle}
        actions={
          hasAction(meta.formId, meta.create) && (
            <button type="button" className="btn-primary" onClick={() => setComposing(true)}>
              <Plus className="size-3.5" />
              New {type}
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
        emptyMessage={`No ${type} vouchers recorded yet`}
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

function VoucherComposer({ type, onDone }: { type: VoucherType; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const meta = VOUCHER_META[type];

  const [date, setDate] = useState(today());
  const [narration, setNarration] = useState('');
  const [branchId, setBranchId] = useState<number | null>(null);
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);

  const needsBranch = user?.isSuperAdmin ?? false;

  const formData = useQuery({
    queryKey: ['vouchers', type, 'form-data'],
    queryFn: () => api.get<FormData>(`/vouchers/${type}/form-data`),
  });

  const totalDr = lines.reduce((acc, l) => addMoney(acc, l.dr), '0.00');
  const totalCr = lines.reduce((acc, l) => addMoney(acc, l.cr), '0.00');
  const difference = subMoney(totalDr, totalCr);
  const balanced = Number(difference) === 0;

  const filled = lines.filter((l) => l.accountId !== null && (Number(l.dr) > 0 || Number(l.cr) > 0));

  const errors: string[] = [];
  if (filled.length < 2) errors.push('A voucher needs at least two lines');
  if (!balanced) {
    errors.push(
      `Debits and credits must be equal — currently out by ${fmtMoney(
        String(Math.abs(Number(difference))),
      )}`,
    );
  }
  if (lines.some((l) => Number(l.dr) > 0 && Number(l.cr) > 0)) {
    errors.push('A line is either a debit or a credit, not both');
  }
  if (needsBranch && branchId === null) errors.push('Select a branch');

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>(`/vouchers/${type}`, {
        date,
        ...(branchId !== null ? { branchId } : {}),
        narration: narration || null,
        lines: filled.map((l) => ({
          accountId: l.accountId,
          dr: l.dr,
          cr: l.cr,
          detail: l.detail || null,
          chequeNo: l.chequeNo || null,
        })),
      }),
    onSuccess: (result) => {
      toast.success(`${type} #${result.id} saved`);
      void queryClient.invalidateQueries({ queryKey: ['vouchers', type] });
      onDone();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not save the voucher'),
  });

  const update = (key: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <>
      <PageHeader
        title={`New ${meta.label}`}
        subtitle="Every voucher must balance before it can be saved"
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
              {save.isPending ? 'Saving…' : 'Save Voucher'}
            </button>
          </>
        }
      />

      <div className={cn('card mb-3 grid gap-3 p-3', needsBranch ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
        <Field
          label="Date"
          name="date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
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
          label="Narration"
          name="narration"
          value={narration}
          onChange={(e) => setNarration(e.target.value)}
        />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase">
              <th className="w-8 px-2 py-2 text-left">#</th>
              <th className="px-2 py-2 text-left">Account</th>
              <th className="px-2 py-2 text-left">Detail</th>
              {formData.data?.requiresCheque && (
                <th className="w-32 px-2 py-2 text-left">Cheque no.</th>
              )}
              <th className="w-32 px-2 py-2 text-right">Debit</th>
              <th className="w-32 px-2 py-2 text-right">Credit</th>
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
                    aria-label={`Account for line ${i + 1}`}
                    value={line.accountId ?? ''}
                    onChange={(e) =>
                      update(line.key, {
                        accountId: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  >
                    <option value="">Select an account…</option>
                    {formData.data?.accounts.map((a) => (
                      <option key={a.account_id} value={a.account_id}>
                        {a.account_id} — {a.name}
                      </option>
                    ))}
                  </select>
                </td>

                <td className="px-2 py-1">
                  <input
                    className="field-input py-1"
                    aria-label={`Detail for line ${i + 1}`}
                    value={line.detail}
                    onChange={(e) => update(line.key, { detail: e.target.value })}
                  />
                </td>

                {formData.data?.requiresCheque && (
                  <td className="px-2 py-1">
                    <input
                      className="field-input py-1"
                      aria-label={`Cheque number for line ${i + 1}`}
                      value={line.chequeNo}
                      onChange={(e) => update(line.key, { chequeNo: e.target.value })}
                    />
                  </td>
                )}

                <td className="px-2 py-1">
                  <input
                    type="number"
                    step="any"
                    min="0"
                    className="field-input py-1 text-right tabular"
                    aria-label={`Debit for line ${i + 1}`}
                    value={line.dr}
                    // Entering one side clears the other; a leg is never both.
                    onChange={(e) => update(line.key, { dr: e.target.value, cr: '0' })}
                  />
                </td>

                <td className="px-2 py-1">
                  <input
                    type="number"
                    step="any"
                    min="0"
                    className="field-input py-1 text-right tabular"
                    aria-label={`Credit for line ${i + 1}`}
                    value={line.cr}
                    onChange={(e) => update(line.key, { cr: e.target.value, dr: '0' })}
                  />
                </td>

                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    aria-label={`Remove line ${i + 1}`}
                    className="rounded-sm p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    onClick={() =>
                      setLines((ls) =>
                        ls.length <= 2 ? ls : ls.filter((l) => l.key !== line.key),
                      )
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>

          <tfoot>
            <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
              <td colSpan={formData.data?.requiresCheque ? 4 : 3} className="px-2 py-1.5">
                Total
              </td>
              <td className="px-2 py-1.5 text-right tabular">{fmtMoney(totalDr)}</td>
              <td className="px-2 py-1.5 text-right tabular">{fmtMoney(totalCr)}</td>
              <td />
            </tr>
          </tfoot>
        </table>

        <div className="flex items-center justify-between border-t border-slate-200 px-2 py-1.5">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setLines((ls) => [...ls, emptyLine()])}
          >
            <Plus className="size-3.5" />
            Add line
          </button>

          <span
            className={cn(
              'rounded-sm px-2 py-1 text-xs font-medium',
              balanced ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800',
            )}
          >
            {balanced
              ? 'Balanced'
              : `Out by ${fmtMoney(String(Math.abs(Number(difference))))}`}
          </span>
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
