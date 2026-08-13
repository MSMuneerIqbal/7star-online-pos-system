import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { Modal } from '@/components/ui/Modal';
import { Field, PageHeader } from '@/components/ui/Field';

interface Branch {
  id: number;
  name: string;
  code: string | null;
  type: 'BRANCH' | 'WAREHOUSE';
  address: string | null;
  phone: string | null;
  opening_hours: string | null;
  closing_day: string | null;
  is_active: boolean;
  longitude: string;
  latitude: string;
  created_at: string;
}

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

// Legacy form 2 / form code 201 — see api/migrations/1700000000003.
const PERM = { formId: 2, create: 2012, edit: 2013, remove: 2014 };

const EMPTY = {
  name: '',
  code: '',
  type: 'BRANCH' as 'BRANCH' | 'WAREHOUSE',
  address: '',
  phone: '',
  openingHours: '',
  closingDay: '',
  isActive: true,
  longitude: '0',
  latitude: '0',
};

export function BranchPage() {
  const { hasAction } = useAuth();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Branch | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (search) params.set('search', search);

  const { data, isPending, error } = useQuery({
    queryKey: ['branches', page, search],
    queryFn: () => api.get<Paged<Branch>>(`/branches?${params}`),
  });

  const close = () => {
    setCreating(false);
    setEditing(null);
    setForm(EMPTY);
    setFieldErrors({});
  };

  const save = useMutation({
    mutationFn: (body: typeof EMPTY) => {
      // Code and type are asked for once, on create, and immutable after —
      // the API does not accept them on an edit.
      if (editing) {
        const { code: _code, type: _type, ...rest } = body;
        return api.put<Branch>(`/branches/${editing.id}`, rest);
      }
      return api.post<Branch>('/branches', body);
    },
    onSuccess: (row) => {
      toast.success(editing ? `Updated ${row.name}` : `Created ${row.name}`);
      void queryClient.invalidateQueries({ queryKey: ['branches'] });
      close();
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        toast.error(err.message);
      } else {
        toast.error('Could not save the branch');
      }
    },
  });

  const remove = useMutation({
    mutationFn: (branch: Branch) => api.del<void>(`/branches/${branch.id}`),
    onSuccess: () => {
      toast.success('Branch deleted');
      void queryClient.invalidateQueries({ queryKey: ['branches'] });
    },
    onError: (err) => {
      // A branch with sales or employees cannot be removed; the API names what
      // is holding the reference.
      toast.error(err instanceof ApiError ? err.message : 'Could not delete the branch');
    },
  });

  const columns: readonly Column<Branch>[] = [
    { key: 'id', header: 'ID', numeric: true, width: '4rem' },
    { key: 'code', header: 'Code', width: '5rem', cell: (r) => r.code ?? '—' },
    { key: 'name', header: 'Name' },
    { key: 'type', header: 'Type', width: '7rem', cell: (r) => (r.type === 'WAREHOUSE' ? 'Warehouse' : 'Branch') },
    { key: 'address', header: 'Address', cell: (r) => r.address ?? '—' },
    { key: 'phone', header: 'Phone', cell: (r) => r.phone ?? '—' },
    {
      key: 'is_active',
      header: 'Status',
      width: '7rem',
      cell: (r) =>
        r.is_active ? (
          <span className="rounded-sm bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800">
            Active
          </span>
        ) : (
          <span className="rounded-sm bg-slate-200 px-1.5 py-0.5 text-xs font-medium text-slate-600">
            Inactive
          </span>
        ),
    },
  ];

  const canCreate = hasAction(PERM.formId, PERM.create);
  const canEdit = hasAction(PERM.formId, PERM.edit);
  const canRemove = hasAction(PERM.formId, PERM.remove);

  return (
    <>
      <PageHeader
        title="Branch"
        subtitle="Locations this business operates from"
        actions={
          canCreate && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              New Branch
            </button>
          )
        }
      />

      <div className="no-print mb-3 flex max-w-xs items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            placeholder="Search branches…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="field-input pl-8"
            aria-label="Search branches"
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={isPending}
        error={error ? (error as Error).message : null}
        emptyMessage={search ? `No branches match "${search}"` : 'No branches yet'}
        actions={
          canEdit || canRemove
            ? (row) => (
                <div className="flex justify-end gap-1">
                  {canEdit && (
                    <button
                      type="button"
                      title={`Edit ${row.name}`}
                      className="rounded-sm p-1.5 text-slate-500 hover:bg-slate-100 hover:text-brand-600"
                      onClick={() => {
                        setEditing(row);
                        setForm({
                          name: row.name,
                          code: row.code ?? '',
                          type: row.type,
                          address: row.address ?? '',
                          phone: row.phone ?? '',
                          openingHours: row.opening_hours ?? '',
                          closingDay: row.closing_day ?? '',
                          isActive: row.is_active,
                          longitude: row.longitude,
                          latitude: row.latitude,
                        });
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  )}
                  {canRemove && (
                    <button
                      type="button"
                      title={`Delete ${row.name}`}
                      className="rounded-sm p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600"
                      onClick={() => {
                        if (confirm(`Delete branch "${row.name}"? This cannot be undone.`)) {
                          remove.mutate(row);
                        }
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              )
            : undefined
        }
      />

      {data && (
        <Pagination
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          onPageChange={setPage}
        />
      )}

      <Modal
        open={creating || editing !== null}
        title={editing ? `Edit ${editing.name}` : 'New Branch'}
        onClose={close}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={close}>
              Cancel
            </button>
            <button
              type="submit"
              form="branch-form"
              className="btn-primary"
              disabled={save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        <form
          id="branch-form"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setFieldErrors({});
            save.mutate(form);
          }}
        >
          <Field
            label="Name"
            name="name"
            required
            autoFocus
            value={form.name}
            error={fieldErrors.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />

          {editing ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="field-label">Code</span>
                <p className="field-input flex items-center bg-slate-50 text-slate-500">
                  {editing.code}
                </p>
              </div>
              <div>
                <span className="field-label">Type</span>
                <p className="field-input flex items-center bg-slate-50 text-slate-500">
                  {editing.type === 'WAREHOUSE' ? 'Warehouse' : 'Branch'}
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Code"
                name="code"
                required
                value={form.code}
                error={fieldErrors.code}
                hint="Prefixes every document this branch issues. Cannot change later."
                onChange={(e) => setForm({ ...form, code: e.target.value })}
              />
              <div>
                <label htmlFor="type" className="field-label">
                  Type
                </label>
                <select
                  id="type"
                  className="field-input"
                  value={form.type}
                  onChange={(e) =>
                    setForm({ ...form, type: e.target.value as 'BRANCH' | 'WAREHOUSE' })
                  }
                >
                  <option value="BRANCH">Branch</option>
                  <option value="WAREHOUSE">Warehouse</option>
                </select>
              </div>
            </div>
          )}

          <Field
            label="Address"
            name="address"
            value={form.address}
            error={fieldErrors.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />

          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Phone"
              name="phone"
              value={form.phone}
              error={fieldErrors.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
            <Field
              label="Closing day"
              name="closingDay"
              value={form.closingDay}
              error={fieldErrors.closingDay}
              onChange={(e) => setForm({ ...form, closingDay: e.target.value })}
            />
          </div>

          <Field
            label="Opening hours"
            name="openingHours"
            value={form.openingHours}
            error={fieldErrors.openingHours}
            onChange={(e) => setForm({ ...form, openingHours: e.target.value })}
          />

          <label className="flex items-center gap-2 py-1 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              className="rounded-sm border-slate-300"
            />
            Active
          </label>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Latitude"
              name="latitude"
              type="number"
              step="any"
              value={form.latitude}
              error={fieldErrors.latitude}
              onChange={(e) => setForm({ ...form, latitude: e.target.value })}
            />
            <Field
              label="Longitude"
              name="longitude"
              type="number"
              step="any"
              value={form.longitude}
              error={fieldErrors.longitude}
              onChange={(e) => setForm({ ...form, longitude: e.target.value })}
            />
          </div>
        </form>
      </Modal>
    </>
  );
}
