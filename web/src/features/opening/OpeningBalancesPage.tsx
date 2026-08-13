import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { fmtMoney } from '@/lib/money';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Field, PageHeader } from '@/components/ui/Field';

interface OpeningStockRow {
  id: number;
  branch_id: number;
  kind: string;
  pid: number;
  qty: string;
  cost: string;
  date: string;
  product_name: string | null;
  raw_name: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

export function OpeningBalancesPage() {
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<'stock' | 'balance'>('stock');
  const [date, setDate] = useState(today());
  const [branchId, setBranchId] = useState<number | null>(null);
  const [kind, setKind] = useState<'FINISH' | 'RAW'>('FINISH');
  const [pid, setPid] = useState<number | null>(null);
  const [qty, setQty] = useState('0');
  const [cost, setCost] = useState('0');
  const [accountId, setAccountId] = useState<number | null>(null);
  const [amount, setAmount] = useState('0');
  const [debit, setDebit] = useState(true);
  const [detail, setDetail] = useState('');

  const list = useQuery({
    queryKey: ['opening'],
    queryFn: () => api.get<{ stock: OpeningStockRow[]; openings: unknown[] }>('/opening'),
  });

  const branches = useQuery({
    queryKey: ['branches', 'options'],
    queryFn: () => api.get<{ rows: { id: number; name: string }[] }>('/branches?pageSize=200'),
  });

  const products = useQuery({
    queryKey: ['opening', 'products', kind],
    queryFn: () =>
      kind === 'FINISH'
        ? api.get<{ rows: { id: number; name: string | null }[] }>('/products?pageSize=200')
        : api.get<{ rows: { id: number; name: string | null }[] }>('/raw-products?pageSize=200'),
  });

  const accounts = useQuery({
    queryKey: ['accounts', 'chart', 'final'],
    queryFn: () => api.get<{ rows: { account_id: number; name: string | null }[] }>('/accounts?pageSize=500'),
    enabled: tab === 'balance',
  });

  const saveStock = useMutation({
    mutationFn: () =>
      api.post('/opening/stock', { date, branchId, kind, pid, qty, cost }),
    onSuccess: () => {
      toast.success('Opening stock recorded');
      void queryClient.invalidateQueries({ queryKey: ['opening'] });
      setQty('0');
      setCost('0');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record opening stock'),
  });

  const saveBalance = useMutation({
    mutationFn: () =>
      api.post('/opening/balance', { date, branchId, accountId, amount, debit, detail: detail || null }),
    onSuccess: () => {
      toast.success('Opening balance recorded');
      void queryClient.invalidateQueries({ queryKey: ['opening'] });
      setAmount('0');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record opening balance'),
  });

  const columns: readonly Column<OpeningStockRow>[] = [
    { key: 'date', header: 'Date', width: '7.5rem' },
    { key: 'kind', header: 'Kind', width: '5rem' },
    { key: 'product_name', header: 'Item', cell: (r) => r.product_name ?? r.raw_name ?? '—' },
    { key: 'qty', header: 'Qty', numeric: true, width: '6rem' },
    { key: 'cost', header: 'Cost', numeric: true, cell: (r) => fmtMoney(r.cost) },
  ];

  return (
    <>
      <PageHeader title="Opening Balances" subtitle="The day-one starting numbers — fill once, before trading" />

      <div className="no-print mb-3 flex gap-1 border-b border-slate-200">
        {(['stock', 'balance'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              tab === t ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-slate-500'
            }`}
          >
            {t === 'stock' ? 'Opening stock' : 'Cash / other balances'}
          </button>
        ))}
      </div>

      <div className="card mb-4 grid max-w-3xl gap-3 p-4 sm:grid-cols-2">
        <Field label="Date" name="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />

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
            {branches.data?.rows
              .filter((b) => b.id !== 0)
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
          </select>
        </div>

        {tab === 'stock' ? (
          <>
            <div>
              <label htmlFor="kind" className="field-label">
                Kind
              </label>
              <select id="kind" className="field-input" value={kind} onChange={(e) => setKind(e.target.value as 'FINISH' | 'RAW')}>
                <option value="FINISH">Finished goods</option>
                <option value="RAW">Raw material</option>
              </select>
            </div>

            <div>
              <label htmlFor="item" className="field-label">
                Item<span className="ml-0.5 text-red-500">*</span>
              </label>
              <select id="item" className="field-input" value={pid ?? ''} onChange={(e) => setPid(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Select…</option>
                {products.data?.rows.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <Field label="Quantity" name="qty" type="number" min="0" step="any" required value={qty} onChange={(e) => setQty(e.target.value)} />
            <Field label="Cost (wholesale)" name="cost" type="number" min="0" step="any" required value={cost} onChange={(e) => setCost(e.target.value)} />

            <button
              type="button"
              className="btn-primary sm:col-span-2"
              disabled={branchId === null || pid === null || Number(qty) <= 0 || saveStock.isPending}
              onClick={() => saveStock.mutate()}
            >
              <Save className="size-3.5" />
              Record opening stock
            </button>
          </>
        ) : (
          <>
            <div>
              <label htmlFor="account" className="field-label">
                Account<span className="ml-0.5 text-red-500">*</span>
              </label>
              <select
                id="account"
                className="field-input"
                value={accountId ?? ''}
                onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Select…</option>
                {accounts.data?.rows.map((a) => (
                  <option key={a.account_id} value={a.account_id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>

            <Field label="Amount" name="amount" type="number" min="0" step="any" required value={amount} onChange={(e) => setAmount(e.target.value)} />

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={debit} onChange={(e) => setDebit(e.target.checked)} className="rounded-sm border-slate-300" />
              Debit (asset / receivable) — uncheck for a credit (payable)
            </label>

            <div className="sm:col-span-2">
              <Field label="Detail" name="detail" value={detail} onChange={(e) => setDetail(e.target.value)} />
            </div>

            <button
              type="button"
              className="btn-primary sm:col-span-2"
              disabled={branchId === null || accountId === null || Number(amount) <= 0 || saveBalance.isPending}
              onClick={() => saveBalance.mutate()}
            >
              <Save className="size-3.5" />
              Record opening balance
            </button>
          </>
        )}
      </div>

      {tab === 'stock' && (
        <DataTable
          columns={columns}
          rows={list.data?.stock ?? []}
          rowKey={(r) => r.id}
          loading={list.isPending}
          error={list.error ? (list.error as Error).message : null}
          emptyMessage="No opening stock recorded yet"
        />
      )}
    </>
  );
}
