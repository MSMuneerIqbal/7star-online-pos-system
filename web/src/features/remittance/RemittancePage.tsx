import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, Save } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/money';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { Field, PageHeader } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { StatusPill } from '@/components/ui/StatusPill';

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface RemittanceRow {
  id: number;
  doc_number: string;
  date: string;
  amount: string;
  method: string;
  status: string;
  note: string | null;
  from_name: string | null;
  to_name: string | null;
}

interface DuesRow {
  branchId: number;
  branchName: string;
  received: string;
  remitted: string;
  inTransit: string;
  stillOwed: string;
}

// Form 55 / code 511.
const PERM = { formId: 55, create: 5112, edit: 5113 };

const today = () => new Date().toISOString().slice(0, 10);

export function RemittancePage() {
  const { hasAction, user } = useAuth();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('0');
  const [method, setMethod] = useState<'CASH' | 'BANK'>('CASH');
  const [note, setNote] = useState('');
  const [fromBranchId, setFromBranchId] = useState<number | null>(null);

  const needsBranch = user?.isSuperAdmin ?? false;

  const branches = useQuery({
    queryKey: ['branches', 'options'],
    queryFn: () => api.get<{ rows: { id: number; name: string }[] }>('/branches?pageSize=200'),
    enabled: needsBranch,
  });

  const dues = useQuery({
    queryKey: ['remittances', 'dues'],
    queryFn: () => api.get<DuesRow[]>('/remittances/dues'),
  });

  const list = useQuery({
    queryKey: ['remittances', page],
    queryFn: () => api.get<Paged<RemittanceRow>>(`/remittances?page=${page}&pageSize=20`),
    enabled: !creating,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post('/remittances', {
        date,
        amount,
        method,
        note: note || null,
        ...(fromBranchId !== null ? { fromBranchId } : {}),
      }),
    onSuccess: () => {
      toast.success('Remittance recorded');
      void queryClient.invalidateQueries({ queryKey: ['remittances'] });
      setCreating(false);
      setAmount('0');
      setFromBranchId(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record remittance'),
  });

  const confirm = useMutation({
    mutationFn: (id: number) => api.post(`/remittances/${id}/confirm`),
    onSuccess: () => {
      toast.success('Remittance confirmed');
      void queryClient.invalidateQueries({ queryKey: ['remittances'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not confirm'),
  });

  const duesColumns: readonly Column<DuesRow>[] = [
    { key: 'branchName', header: 'Branch' },
    { key: 'received', header: 'Received (wholesale)', numeric: true, cell: (r) => fmtMoney(r.received) },
    { key: 'inTransit', header: 'In transit', numeric: true, cell: (r) => fmtMoney(r.inTransit) },
    { key: 'remitted', header: 'Remitted', numeric: true, cell: (r) => fmtMoney(r.remitted) },
    {
      key: 'stillOwed',
      header: 'Still owed',
      numeric: true,
      cell: (r) => (
        <span className={Number(r.stillOwed) > 0 ? 'font-medium text-amber-700' : undefined}>
          {fmtMoney(r.stillOwed)}
        </span>
      ),
    },
  ];

  const columns: readonly Column<RemittanceRow>[] = [
    { key: 'doc_number', header: 'No.', width: '7rem' },
    { key: 'date', header: 'Date', width: '7.5rem' },
    { key: 'from_name', header: 'From', cell: (r) => r.from_name ?? '—' },
    { key: 'to_name', header: 'To', cell: (r) => r.to_name ?? '—' },
    { key: 'amount', header: 'Amount', numeric: true, cell: (r) => fmtMoney(r.amount) },
    { key: 'method', header: 'Method', width: '5rem' },
    {
      key: 'status',
      header: 'Status',
      width: '8rem',
      cell: (r) => <StatusPill status={r.status} />,
    },
  ];

  const canConfirm = hasAction(PERM.formId, PERM.edit);
  const canCreate = hasAction(PERM.formId, PERM.create);

  return (
    <>
      <PageHeader
        title="Remittance"
        subtitle="What each branch owes the warehouse, and what it has paid back"
        actions={
          canCreate && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              New Remittance
            </button>
          )
        }
      />

      <div className="card mb-4 p-3">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Branch dues</h2>
        <DataTable
          columns={duesColumns}
          rows={dues.data ?? []}
          rowKey={(r) => r.branchId}
          loading={dues.isPending}
          error={dues.error ? (dues.error as Error).message : null}
          emptyMessage="No branches yet"
        />
      </div>

      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.error ? (list.error as Error).message : null}
        emptyMessage="No remittances yet"
        actions={
          canConfirm
            ? (row) =>
                row.status === 'PENDING' && user?.isSuperAdmin ? (
                  <button
                    type="button"
                    title="Confirm receipt at the warehouse"
                    className="rounded-sm p-1.5 text-slate-500 hover:bg-emerald-50 hover:text-emerald-700"
                    onClick={() => confirm.mutate(row.id)}
                  >
                    <CheckCircle2 className="size-3.5" />
                  </button>
                ) : undefined
            : undefined
        }
      />

      {list.data && (
        <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPageChange={setPage} />
      )}

      <Modal
        open={creating}
        title="New Remittance"
        onClose={() => setCreating(false)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={Number(amount) <= 0 || (needsBranch && fromBranchId === null) || create.isPending}
              onClick={() => create.mutate()}
            >
              <Save className="size-3.5" />
              Record
            </button>
          </>
        }
      >
        <div className="space-y-3">
          {needsBranch && (
            <div>
              <label htmlFor="fromBranch" className="field-label">
                Branch<span className="ml-0.5 text-red-500">*</span>
              </label>
              <select
                id="fromBranch"
                className="field-input"
                value={fromBranchId ?? ''}
                onChange={(e) => setFromBranchId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Select a branch…</option>
                {branches.data?.rows
                  .filter((b) => b.id !== 0)
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
              </select>
            </div>
          )}
          <Field label="Date" name="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          <Field
            label="Amount"
            name="amount"
            type="number"
            min="0"
            step="any"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <div>
            <label htmlFor="method" className="field-label">
              Method
            </label>
            <select
              id="method"
              className="field-input"
              value={method}
              onChange={(e) => setMethod(e.target.value as 'CASH' | 'BANK')}
            >
              <option value="CASH">Cash</option>
              <option value="BANK">Bank</option>
            </select>
          </div>
          <Field label="Note" name="note" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </Modal>
    </>
  );
}
