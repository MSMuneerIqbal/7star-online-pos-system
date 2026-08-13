import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Save } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { fmtMoney } from '@/lib/money';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Field, PageHeader } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';

interface CustomerOption {
  id: number;
  name: string | null;
  account_id: number;
}

interface StatementEntry {
  date: string;
  vtype: string;
  detail: string;
  debit: string;
  credit: string;
  balance: string;
}

interface Statement {
  customer: { id: number; name: string | null; settlement_cycle: string | null; credit_limit: string };
  entries: StatementEntry[];
  balance: string;
}

const today = () => new Date().toISOString().slice(0, 10);

export function CustomerStatementPage() {
  const queryClient = useQueryClient();
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('0');
  const [note, setNote] = useState('');

  const customers = useQuery({
    queryKey: ['customers', 'statement-options'],
    queryFn: () => api.get<{ rows: CustomerOption[] }>('/customers?pageSize=200'),
  });

  const creditCustomers = (customers.data?.rows ?? []).filter((c) => c.account_id > 0);

  const statement = useQuery({
    queryKey: ['customers', customerId, 'statement'],
    queryFn: () => api.get<Statement>(`/customers/${customerId}/statement`),
    enabled: customerId !== null,
  });

  const advance = useMutation({
    mutationFn: () => api.post(`/customers/${customerId}/advances`, { date, amount, note: note || null }),
    onSuccess: () => {
      toast.success('Advance recorded');
      void queryClient.invalidateQueries({ queryKey: ['customers', customerId, 'statement'] });
      setAdvancing(false);
      setAmount('0');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record advance'),
  });

  const download = async (path: string, fallback: string) => {
    try {
      const blob = await api.download(path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fallback;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not download');
    }
  };

  const columns: readonly Column<StatementEntry>[] = [
    { key: 'date', header: 'Date', width: '7.5rem' },
    { key: 'vtype', header: 'Type', width: '4rem' },
    { key: 'detail', header: 'Detail' },
    { key: 'debit', header: 'Debit', numeric: true, cell: (r) => fmtMoney(r.debit) },
    { key: 'credit', header: 'Credit', numeric: true, cell: (r) => fmtMoney(r.credit) },
    {
      key: 'balance',
      header: 'Balance',
      numeric: true,
      cell: (r) => (
        <span className={Number(r.balance) > 0 ? 'font-medium text-amber-700' : undefined}>
          {fmtMoney(r.balance)}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Customer Statement"
        subtitle="Every invoice, payment and advance for a credit customer, with a running balance"
        actions={
          customerId !== null && (
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => window.print()}
              >
                <Download className="size-3.5" />
                PDF / Print
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() =>
                  void download(`/customers/${customerId}/statement/export`, 'credit-history.xlsx')
                }
              >
                <Download className="size-3.5" />
                Credit history
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() =>
                  void download(`/customers/${customerId}/battery-history/export`, 'battery-history.xlsx')
                }
              >
                <Download className="size-3.5" />
                Battery history
              </button>
              <button type="button" className="btn-primary" onClick={() => setAdvancing(true)}>
                <Plus className="size-3.5" />
                Advance
              </button>
            </div>
          )
        }
      />

      <div className="no-print mb-3 max-w-xs">
        <label htmlFor="customer" className="field-label">
          Credit customer
        </label>
        <select
          id="customer"
          className="field-input"
          value={customerId ?? ''}
          onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Select a customer…</option>
          {creditCustomers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name ?? `Customer ${c.id}`}
            </option>
          ))}
        </select>
      </div>

      {statement.data && (
        <div className="print-a4">
          <p className="mb-2 text-sm text-slate-600">
            {statement.data.customer.name}
            {statement.data.customer.settlement_cycle ? ` · ${statement.data.customer.settlement_cycle}` : ''}
            {' · '}Balance <strong className="tabular">{fmtMoney(statement.data.balance)}</strong>
          </p>

          <DataTable
            columns={columns}
            rows={statement.data.entries}
            rowKey={(r) => `${r.date}:${r.vtype}:${r.detail}:${r.debit}:${r.credit}:${r.balance}`}
            emptyMessage="No activity yet"
          />
        </div>
      )}

      <Modal
        open={advancing}
        title="Record advance"
        onClose={() => setAdvancing(false)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setAdvancing(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={Number(amount) <= 0 || advance.isPending}
              onClick={() => advance.mutate()}
            >
              <Save className="size-3.5" />
              Record
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Date" name="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          <Field label="Amount" name="amount" type="number" min="0" step="any" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Field label="Note" name="note" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </Modal>
    </>
  );
}
