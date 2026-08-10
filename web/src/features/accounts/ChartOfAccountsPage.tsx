import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Pencil, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Modal } from '@/components/ui/Modal';
import { Field, PageHeader } from '@/components/ui/Field';

export type Level = 'first' | 'second' | 'final';

interface Head {
  id: number;
  name: string;
  code: number;
}

interface SubHead {
  id: number;
  name: string;
  code: number;
  head_code: number;
  head_id: number;
  is_fixed: boolean;
  head_name: string | null;
}

interface Account {
  id: number;
  account_id: number;
  name: string | null;
  head_id: number;
  sub_head_id: number;
  is_fixed: boolean;
  branch_id: number;
  head_name: string | null;
  sub_head_name: string | null;
}

const META: Record<
  Level,
  { title: string; subtitle: string; formId: number; create: number; edit: number }
> = {
  first: {
    title: 'First Level Account',
    subtitle: 'Account heads — the five top-level classifications',
    formId: 23,
    create: 7012,
    edit: 7013,
  },
  second: {
    title: 'Second Level Account',
    subtitle: 'Sub-heads within each account head',
    formId: 24,
    create: 7022,
    edit: 7023,
  },
  final: {
    title: 'Final Account',
    subtitle: 'The accounts that transactions actually post to',
    formId: 25,
    create: 7032,
    edit: 7033,
  },
};

/** Shown against accounts the posting engine depends on. */
const FixedChip = () => (
  <span
    title="Referenced directly by the posting engine — cannot be renumbered or deleted"
    className="inline-flex items-center gap-1 rounded-sm bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600"
  >
    <Lock className="size-2.5" />
    System
  </span>
);

/**
 * Chart of accounts — all three levels.
 *
 * Codes are composed from the level above:
 *   account_id = head_code x 1,000,000 + sub_code x 10,000 + third x 100 + seq
 *
 * so they are ALLOCATED, never typed in. Renumbering an account would orphan
 * every ledger row pointing at it, which is why only the label can be edited.
 */
export function ChartOfAccountsPage({ level }: { level: Level }) {
  const meta = META[level];

  return (
    <>
      <PageHeader title={meta.title} subtitle={meta.subtitle} />
      {level === 'first' && <HeadsTable />}
      {level === 'second' && <SubHeadsTable />}
      {level === 'final' && <AccountsTable meta={meta} />}
    </>
  );
}

// ---------------------------------------------------------------------------

function HeadsTable() {
  const heads = useQuery({
    queryKey: ['accounts', 'heads'],
    queryFn: () => api.get<Head[]>('/accounts/heads'),
  });

  const columns: readonly Column<Head>[] = [
    { key: 'code', header: 'Code', numeric: true, width: '5rem' },
    { key: 'name', header: 'Head' },
    {
      key: 'range',
      header: 'Account range',
      cell: (h) => (
        <span className="tabular text-slate-500">
          {h.code}010101 – {h.code}999999
        </span>
      ),
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={heads.data ?? []}
        rowKey={(h) => h.id}
        loading={heads.isPending}
        error={heads.error ? (heads.error as Error).message : null}
        emptyMessage="No account heads"
      />

      <p className="mt-3 text-xs text-slate-500">
        Read-only. These five are the standard classifications every set of books uses, and the
        financial statements are built from them — the Balance Sheet from heads 1–3, the Income
        Statement from heads 4–5. Changing them is a schema decision, not a data entry one.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------

function SubHeadsTable() {
  const [headFilter, setHeadFilter] = useState<number | null>(null);

  const heads = useQuery({
    queryKey: ['accounts', 'heads'],
    queryFn: () => api.get<Head[]>('/accounts/heads'),
  });

  const subHeads = useQuery({
    queryKey: ['accounts', 'sub-heads', headFilter],
    queryFn: () =>
      api.get<SubHead[]>(`/accounts/sub-heads${headFilter ? `?headId=${headFilter}` : ''}`),
  });

  const columns: readonly Column<SubHead>[] = [
    {
      key: 'code',
      header: 'Code',
      numeric: true,
      width: '6rem',
      cell: (s) => `${s.head_code}${String(s.code).padStart(2, '0')}`,
    },
    { key: 'name', header: 'Sub-head' },
    { key: 'head_name', header: 'Under', cell: (s) => s.head_name ?? '—' },
  ];

  return (
    <>
      <div className="no-print mb-3 min-w-56 max-w-xs">
        <label htmlFor="headFilter" className="field-label">
          Filter by head
        </label>
        <select
          id="headFilter"
          className="field-input"
          value={headFilter ?? ''}
          onChange={(e) => setHeadFilter(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">All heads</option>
          {heads.data?.map((h) => (
            <option key={h.id} value={h.id}>
              {h.code} — {h.name}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        columns={columns}
        rows={subHeads.data ?? []}
        rowKey={(s) => s.id}
        loading={subHeads.isPending}
        error={subHeads.error ? (subHeads.error as Error).message : null}
        emptyMessage="No sub-heads"
      />

      <p className="mt-3 text-xs text-slate-500">
        Read-only. Sub-heads decide what your statements can tell you — separating Cost of Sales
        from Operating Expenses is what makes gross margin meaningful — so they are set deliberately
        rather than added mid-flow. Add day-to-day accounts under Final Account instead.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------

function AccountsTable({ meta }: { meta: (typeof META)[Level] }) {
  const { hasAction } = useAuth();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [headFilter, setHeadFilter] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Account | null>(null);
  const [form, setForm] = useState({ name: '', subHeadId: '', thirdCode: '' });

  const heads = useQuery({
    queryKey: ['accounts', 'heads'],
    queryFn: () => api.get<Head[]>('/accounts/heads'),
  });

  const subHeads = useQuery({
    queryKey: ['accounts', 'sub-heads', null],
    queryFn: () => api.get<SubHead[]>('/accounts/sub-heads'),
  });

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (headFilter) params.set('headId', String(headFilter));

  const accounts = useQuery({
    queryKey: ['accounts', 'list', search, headFilter],
    queryFn: () => api.get<Account[]>(`/accounts?${params}`),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<Account>('/accounts', {
        name: form.name,
        subHeadId: form.subHeadId,
        ...(form.thirdCode ? { thirdCode: form.thirdCode } : {}),
      }),
    onSuccess: (a) => {
      toast.success(`Account ${a.account_id} created`);
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setCreating(false);
      setForm({ name: '', subHeadId: '', thirdCode: '' });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not create'),
  });

  const rename = useMutation({
    mutationFn: () => api.put(`/accounts/${renaming?.account_id}`, { name: form.name }),
    onSuccess: () => {
      toast.success('Account renamed');
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setRenaming(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not rename'),
  });

  const columns: readonly Column<Account>[] = [
    { key: 'account_id', header: 'Code', numeric: true, width: '7rem' },
    { key: 'name', header: 'Account', cell: (a) => a.name ?? '—' },
    { key: 'head_name', header: 'Head', cell: (a) => a.head_name ?? '—' },
    { key: 'sub_head_name', header: 'Sub-head', cell: (a) => a.sub_head_name ?? '—' },
    { key: 'is_fixed', header: '', width: '6rem', cell: (a) => (a.is_fixed ? <FixedChip /> : null) },
  ];

  return (
    <>
      <div className="no-print mb-3 flex flex-wrap items-end gap-3">
        <div className="relative min-w-56 flex-1">
          <label htmlFor="accountSearch" className="field-label">
            Search
          </label>
          <Search className="pointer-events-none absolute top-[1.9rem] left-2.5 size-3.5 text-slate-400" />
          <input
            id="accountSearch"
            type="search"
            placeholder="Name or code…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="field-input pl-8"
          />
        </div>

        <div className="min-w-48">
          <label htmlFor="acctHead" className="field-label">
            Head
          </label>
          <select
            id="acctHead"
            className="field-input"
            value={headFilter ?? ''}
            onChange={(e) => setHeadFilter(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">All heads</option>
            {heads.data?.map((h) => (
              <option key={h.id} value={h.id}>
                {h.code} — {h.name}
              </option>
            ))}
          </select>
        </div>

        {hasAction(meta.formId, meta.create) && (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            New Account
          </button>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={accounts.data ?? []}
        rowKey={(a) => a.account_id}
        loading={accounts.isPending}
        error={accounts.error ? (accounts.error as Error).message : null}
        emptyMessage={search ? `Nothing matches "${search}"` : 'No accounts'}
        actions={
          hasAction(meta.formId, meta.edit)
            ? (row) => (
                <button
                  type="button"
                  title="Rename"
                  className="rounded-sm p-1.5 text-slate-500 hover:bg-slate-100 hover:text-brand-600"
                  onClick={() => {
                    setForm({ name: row.name ?? '', subHeadId: '', thirdCode: '' });
                    setRenaming(row);
                  }}
                >
                  <Pencil className="size-3.5" />
                </button>
              )
            : undefined
        }
      />

      <p className="mt-3 text-xs text-slate-500">
        Customer, vendor and employee accounts are created automatically when you add the party —
        they are not added here.
      </p>

      {/* Create */}
      <Modal
        open={creating}
        title="New Account"
        onClose={() => setCreating(false)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!form.name.trim() || !form.subHeadId || create.isPending}
              onClick={() => create.mutate()}
            >
              Create
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label htmlFor="subHeadId" className="field-label">
              Sub-head<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              id="subHeadId"
              className="field-input"
              value={form.subHeadId}
              onChange={(e) => setForm({ ...form, subHeadId: e.target.value })}
            >
              <option value="">Select…</option>
              {subHeads.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.head_code}
                  {String(s.code).padStart(2, '0')} — {s.name} ({s.head_name})
                </option>
              ))}
            </select>
          </div>

          <Field
            label="Name"
            name="name"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />

          <Field
            label="Group"
            name="thirdCode"
            type="number"
            min="1"
            max="99"
            value={form.thirdCode}
            onChange={(e) => setForm({ ...form, thirdCode: e.target.value })}
            hint="Optional third-level group, 1–99. Each group holds 99 accounts. Leave blank for group 1."
          />
        </div>
      </Modal>

      {/* Rename — the code is never editable */}
      <Modal
        open={renaming !== null}
        title={`Rename account ${renaming?.account_id ?? ''}`}
        onClose={() => setRenaming(null)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setRenaming(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!form.name.trim() || rename.isPending}
              onClick={() => rename.mutate()}
            >
              Save
            </button>
          </>
        }
      >
        <p className={cn('mb-3 rounded-md px-3 py-2 text-xs', 'bg-slate-50 text-slate-600')}>
          Only the label can change. The code <strong className="tabular">{renaming?.account_id}</strong>{' '}
          is referenced by every ledger entry posted against it, so renumbering would orphan them.
        </p>

        <Field
          label="Name"
          name="renameName"
          required
          autoFocus
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </Modal>
    </>
  );
}
