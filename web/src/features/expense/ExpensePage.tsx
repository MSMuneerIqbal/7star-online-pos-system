import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/money';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { Field, PageHeader } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface ExpenseRow {
  id: number;
  date: string;
  amount: string;
  method: string;
  description: string;
  category_name: string | null;
}

interface Category {
  id: number;
  name: string;
}

interface Report {
  month: string;
  monthTotal: string;
  previousMonth: string;
  previousMonthTotal: string;
  byCategory: Array<{ name: string; thisMonth: string; lastMonth: string }>;
  year: Array<{ month: string; total: string }>;
}

// Form 56 / code 806.
const PERM = { formId: 56, create: 8062 };

const today = () => new Date().toISOString().slice(0, 10);

export function ExpensePage() {
  const { hasAction, user } = useAuth();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState(today());
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [amount, setAmount] = useState('0');
  const [description, setDescription] = useState('');
  const [branchId, setBranchId] = useState<number | null>(null);

  const categories = useQuery({
    queryKey: ['expenses', 'categories'],
    queryFn: () => api.get<Category[]>('/expenses/categories'),
  });

  const report = useQuery({
    queryKey: ['expenses', 'report'],
    queryFn: () => api.get<Report>('/expenses/report'),
  });

  const list = useQuery({
    queryKey: ['expenses', page],
    queryFn: () => api.get<Paged<ExpenseRow>>(`/expenses?page=${page}&pageSize=20`),
    enabled: !adding,
  });

  const branches = useQuery({
    queryKey: ['branches', 'options'],
    queryFn: () => api.get<{ rows: { id: number; name: string }[] }>('/branches?pageSize=200'),
    enabled: user?.isSuperAdmin ?? false,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post('/expenses', {
        date,
        categoryId,
        amount,
        description,
        ...(branchId !== null ? { branchId } : {}),
      }),
    onSuccess: () => {
      toast.success('Expense recorded');
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      setAdding(false);
      setAmount('0');
      setDescription('');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record expense'),
  });

  const columns: readonly Column<ExpenseRow>[] = [
    { key: 'date', header: 'Date', width: '7.5rem' },
    { key: 'category_name', header: 'Category', cell: (r) => r.category_name ?? '—' },
    { key: 'description', header: 'Description' },
    { key: 'amount', header: 'Amount', numeric: true, cell: (r) => fmtMoney(r.amount) },
    { key: 'method', header: 'Method', width: '4rem' },
  ];

  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle="Per branch, per month, per category"
        actions={
          hasAction(PERM.formId, PERM.create) && (
            <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" />
              New Expense
            </button>
          )
        }
      />

      {report.data && (
        <div className="card mb-4 p-3">
          <h2 className="mb-1 text-sm font-semibold text-slate-900">
            {report.data.month} — {fmtMoney(report.data.monthTotal)}
          </h2>
          <p className="mb-2 text-xs text-slate-500">
            Previous month ({report.data.previousMonth}): {fmtMoney(report.data.previousMonthTotal)}
          </p>

          <div className="mb-3 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="px-2 py-1.5">Category</th>
                  <th className="px-2 py-1.5 text-right">This month</th>
                  <th className="px-2 py-1.5 text-right">Last month</th>
                </tr>
              </thead>
              <tbody>
                {report.data.byCategory.map((c) => (
                  <tr key={c.name} className="border-b border-slate-100 last:border-0">
                    <td className="px-2 py-1">{c.name}</td>
                    <td className="px-2 py-1 text-right tabular">{fmtMoney(c.thisMonth)}</td>
                    <td className="px-2 py-1 text-right tabular">{fmtMoney(c.lastMonth)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="px-2 py-1.5">Month</th>
                  <th className="px-2 py-1.5 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {report.data.year.map((m) => (
                  <tr key={m.month} className="border-b border-slate-100 last:border-0">
                    <td className="px-2 py-1">{m.month}</td>
                    <td className="px-2 py-1 text-right tabular">{fmtMoney(m.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.error ? (list.error as Error).message : null}
        emptyMessage="No expenses recorded yet"
      />

      {list.data && (
        <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPageChange={setPage} />
      )}

      <Modal
        open={adding}
        title="New Expense"
        onClose={() => setAdding(false)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={categoryId === null || Number(amount) <= 0 || !description.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              <Save className="size-3.5" />
              Record
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Date" name="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />

          <div>
            <label htmlFor="category" className="field-label">
              Category<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              id="category"
              className="field-input"
              value={categoryId ?? ''}
              onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select…</option>
              {categories.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {user?.isSuperAdmin && (
            <div>
              <label htmlFor="branch" className="field-label">
                Branch
              </label>
              <select
                id="branch"
                className="field-input"
                value={branchId ?? ''}
                onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Select…</option>
                {branches.data?.rows.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <Field label="Amount" name="amount" type="number" min="0" step="any" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Field label="Description" name="description" required value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </Modal>
    </>
  );
}
