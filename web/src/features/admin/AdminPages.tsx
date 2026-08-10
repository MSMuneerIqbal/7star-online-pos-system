import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { Field, PageHeader } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

interface Role {
  id: number;
  name: string;
  branch_id: number;
  branch_name: string | null;
}

const ROLE_PERM = { formId: 14, create: 8012, remove: 8014 };

export function RolesPage() {
  const { hasAction, user } = useAuth();
  const queryClient = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [branchId, setBranchId] = useState<number | null>(null);

  // Roles are branch-scoped in the legacy schema, and a super admin signs in
  // against branch 0 ("All Branches"), which is a filter rather than a
  // location — so they have to name a real branch.
  const needsBranch = user?.isSuperAdmin ?? false;

  const roles = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: () => api.get<Role[]>('/admin/roles'),
  });

  const branches = useQuery({
    queryKey: ['branches', 'options'],
    queryFn: () => api.get<{ rows: { id: number; name: string }[] }>('/branches?pageSize=200'),
    enabled: needsBranch,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<Role>('/admin/roles', {
        name,
        ...(branchId !== null ? { branchId } : {}),
      }),
    onSuccess: (r) => {
      toast.success(`Role "${r.name}" created`);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
      setCreating(false);
      setName('');
      setBranchId(null);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not create the role'),
  });

  const remove = useMutation({
    mutationFn: (role: Role) => api.del(`/admin/roles/${role.id}`),
    onSuccess: () => {
      toast.success('Role deleted');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
    },
    // The API refuses while users still depend on the role.
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not delete the role'),
  });

  const columns: readonly Column<Role>[] = [
    { key: 'id', header: 'ID', numeric: true, width: '4rem' },
    { key: 'name', header: 'Role' },
    { key: 'branch_name', header: 'Branch', cell: (r) => r.branch_name ?? 'All' },
  ];

  return (
    <>
      <PageHeader
        title="User Roles"
        subtitle="Groups that permissions are granted to"
        actions={
          hasAction(ROLE_PERM.formId, ROLE_PERM.create) && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              New Role
            </button>
          )
        }
      />

      <DataTable
        columns={columns}
        rows={roles.data ?? []}
        rowKey={(r) => r.id}
        loading={roles.isPending}
        error={roles.error ? (roles.error as Error).message : null}
        emptyMessage="No roles defined yet"
        actions={
          hasAction(ROLE_PERM.formId, ROLE_PERM.remove)
            ? (row) => (
                <button
                  type="button"
                  title={`Delete ${row.name}`}
                  className="rounded-sm p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600"
                  onClick={() => {
                    if (confirm(`Delete role "${row.name}"?`)) remove.mutate(row);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              )
            : undefined
        }
      />

      <Modal
        open={creating}
        title="New Role"
        onClose={() => setCreating(false)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!name.trim() || (needsBranch && branchId === null) || create.isPending}
              onClick={() => create.mutate()}
            >
              Create
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <Field
            label="Role name"
            name="name"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            hint="Grant its permissions on the Role Assignment screen."
          />

          {needsBranch && (
            <div>
              <label htmlFor="roleBranch" className="field-label">
                Branch<span className="ml-0.5 text-red-500">*</span>
              </label>
              <select
                id="roleBranch"
                className="field-input"
                value={branchId ?? ''}
                onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Select a branch…</option>
                {branches.data?.rows.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// User logins
// ---------------------------------------------------------------------------

interface Login {
  id: number;
  username: string;
  emp_id: number;
  branch_id: number;
  is_active: boolean;
  last_login_at: string | null;
  role_name: string | null;
  employee_name: string | null;
}

const LOGIN_PERM = { formId: 16, create: 8032, edit: 8033 };

export function UserLoginsPage() {
  const { hasAction } = useAuth();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [resetting, setResetting] = useState<Login | null>(null);
  const [password, setPassword] = useState('');

  const logins = useQuery({
    queryKey: ['admin', 'logins', page],
    queryFn: () => api.get<Paged<Login>>(`/admin/logins?page=${page}&pageSize=20`),
  });

  const update = useMutation({
    mutationFn: (input: { id: number; body: Record<string, unknown> }) =>
      api.put(`/admin/logins/${input.id}`, input.body),
    onSuccess: () => {
      toast.success('Login updated');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'logins'] });
      setResetting(null);
      setPassword('');
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not update the login'),
  });

  const columns: readonly Column<Login>[] = [
    { key: 'id', header: 'ID', numeric: true, width: '4rem' },
    { key: 'username', header: 'Username' },
    { key: 'employee_name', header: 'Employee', cell: (r) => r.employee_name ?? '—' },
    {
      key: 'role_name',
      header: 'Role',
      cell: (r) => (r.emp_id === 0 ? <em className="text-slate-500">Super admin</em> : (r.role_name ?? '—')),
    },
    {
      key: 'is_active',
      header: 'Status',
      width: '7rem',
      cell: (r) => (
        <span
          className={cn(
            'rounded-sm px-1.5 py-0.5 text-xs font-medium',
            r.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600',
          )}
        >
          {r.is_active ? 'Active' : 'Disabled'}
        </span>
      ),
    },
    {
      key: 'last_login_at',
      header: 'Last login',
      cell: (r) => (r.last_login_at ? new Date(r.last_login_at).toLocaleString() : 'Never'),
    },
  ];

  const canEdit = hasAction(LOGIN_PERM.formId, LOGIN_PERM.edit);

  return (
    <>
      <PageHeader title="User Logins" subtitle="Who can sign in, and as what" />

      <DataTable
        columns={columns}
        rows={logins.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={logins.isPending}
        error={logins.error ? (logins.error as Error).message : null}
        emptyMessage="No logins yet"
        actions={
          canEdit
            ? (row) => (
                <div className="flex justify-end gap-1">
                  <button
                    type="button"
                    title="Reset password"
                    className="rounded-sm p-1.5 text-slate-500 hover:bg-slate-100 hover:text-brand-600"
                    onClick={() => setResetting(row)}
                  >
                    <Save className="size-3.5" />
                  </button>
                  {row.emp_id !== 0 && (
                    <button
                      type="button"
                      title={row.is_active ? 'Disable' : 'Enable'}
                      className="rounded-sm px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100"
                      onClick={() =>
                        update.mutate({ id: row.id, body: { isActive: !row.is_active } })
                      }
                    >
                      {row.is_active ? 'Disable' : 'Enable'}
                    </button>
                  )}
                </div>
              )
            : undefined
        }
      />

      {logins.data && (
        <Pagination
          page={logins.data.page}
          pageSize={logins.data.pageSize}
          total={logins.data.total}
          onPageChange={setPage}
        />
      )}

      <Modal
        open={resetting !== null}
        title={`Reset password for ${resetting?.username ?? ''}`}
        onClose={() => setResetting(null)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setResetting(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={password.length < 10 || update.isPending}
              onClick={() => update.mutate({ id: resetting!.id, body: { password } })}
            >
              Reset
            </button>
          </>
        }
      >
        <Field
          label="New password"
          name="password"
          type="password"
          required
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="At least 10 characters. Signs the user out of every other session."
        />
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// User logs
// ---------------------------------------------------------------------------

interface LogRow {
  id: string;
  datetime: string;
  username: string | null;
  form: string | null;
  action: string | null;
  detail: string | null;
  inv_id: number | null;
}

export function UserLogsPage() {
  const [page, setPage] = useState(1);
  const [form, setForm] = useState('');

  const forms = useQuery({
    queryKey: ['admin', 'log-forms'],
    queryFn: () => api.get<string[]>('/admin/logs/forms'),
  });

  const logs = useQuery({
    queryKey: ['admin', 'logs', page, form],
    queryFn: () =>
      api.get<Paged<LogRow>>(
        `/admin/logs?page=${page}&pageSize=25${form ? `&form=${encodeURIComponent(form)}` : ''}`,
      ),
  });

  const columns: readonly Column<LogRow>[] = [
    {
      key: 'datetime',
      header: 'When',
      width: '11rem',
      cell: (r) => new Date(r.datetime).toLocaleString(),
    },
    { key: 'username', header: 'User', width: '8rem', cell: (r) => r.username ?? '—' },
    { key: 'form', header: 'Screen', width: '10rem', cell: (r) => r.form ?? '—' },
    {
      key: 'action',
      header: 'Action',
      width: '6rem',
      cell: (r) => (
        <span className="rounded-sm bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
          {r.action ?? '—'}
        </span>
      ),
    },
    { key: 'detail', header: 'Detail', cell: (r) => r.detail ?? '—' },
  ];

  return (
    <>
      <PageHeader title="User Logs" subtitle="Every create, edit and delete, with who and when" />

      <div className="card no-print mb-3 flex max-w-xs items-end gap-3 p-3">
        <div className="flex-1">
          <label htmlFor="logForm" className="field-label">
            Screen
          </label>
          <select
            id="logForm"
            className="field-input"
            value={form}
            onChange={(e) => {
              setForm(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All screens</option>
            {forms.data?.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={logs.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={logs.isPending}
        error={logs.error ? (logs.error as Error).message : null}
        emptyMessage="No activity recorded"
      />

      {logs.data && (
        <Pagination
          page={logs.data.page}
          pageSize={logs.data.pageSize}
          total={logs.data.total}
          onPageChange={setPage}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface Setting {
  id: number;
  name: string | null;
  phone: string | null;
  address: string | null;
  email: string | null;
  delivery_charges: string;
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  const setting = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<Setting>('/admin/settings'),
  });

  // Seed the form once, then let the user own it.
  if (setting.data && !loaded) {
    setForm({
      name: setting.data.name ?? '',
      phone: setting.data.phone ?? '',
      address: setting.data.address ?? '',
      email: setting.data.email ?? '',
      deliveryCharges: setting.data.delivery_charges ?? '0',
    });
    setLoaded(true);
  }

  const save = useMutation({
    mutationFn: () => api.put('/admin/settings', form),
    onSuccess: () => {
      toast.success('Company profile saved');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not save settings'),
  });

  const field = (label: string, name: string, type = 'text') => (
    <Field
      label={label}
      name={name}
      type={type}
      value={form[name] ?? ''}
      onChange={(e) => setForm({ ...form, [name]: e.target.value })}
    />
  );

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Company details — these appear on every printed document"
        actions={
          <button
            type="button"
            className="btn-primary"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            <Save className="size-3.5" />
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        }
      />

      <div className="card grid max-w-2xl gap-3 p-4 sm:grid-cols-2">
        {field('Company name', 'name')}
        {field('Phone', 'phone')}
        {field('Email', 'email', 'email')}
        {field('Delivery charges', 'deliveryCharges', 'number')}
        <div className="sm:col-span-2">{field('Address', 'address')}</div>
      </div>
    </>
  );
}
