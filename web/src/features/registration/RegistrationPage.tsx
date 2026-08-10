import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/money';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { Modal } from '@/components/ui/Modal';
import { Field, PageHeader } from '@/components/ui/Field';

/**
 * One page driving all seven registration screens.
 *
 * They are the same shape — a searchable list plus a modal form — differing
 * only in fields and permissions, so they are configured rather than copied.
 * Branch is deliberately NOT here: it needed a sentinel guard and reference
 * checks of its own, and forcing it into this shape would have obscured that.
 */

type FieldKind = 'text' | 'number' | 'money' | 'date' | 'checkbox' | 'select';

interface FieldSpec {
  name: string;
  label: string;
  kind?: FieldKind;
  required?: boolean;
  /** Key in the options payload, for `select` fields. */
  optionsKey?: string;
  hint?: string;
  /** Half-width in the modal grid. */
  half?: boolean;
  default?: string | boolean;
}

export interface RegistrationConfig {
  endpoint: string;
  title: string;
  subtitle: string;
  singular: string;
  permissions: { formId: number; create: number; edit: number; remove?: number };
  columns: readonly Column<Record<string, unknown>>[];
  fields: readonly FieldSpec[];
  /** Endpoint supplying dropdown options, if any field needs them. */
  optionsEndpoint?: string;
  /** Mint an accounts code on create — shown as a hint in the form. */
  mintsAccount?: boolean;
}

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

const text = (key: string) => (r: Record<string, unknown>) => String(r[key] ?? '—');
const money = (key: string) => (r: Record<string, unknown>) => fmtMoney(String(r[key] ?? '0'));

const yesNo = (key: string) => (r: Record<string, unknown>) =>
  r[key] ? (
    <span className="rounded-sm bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800">
      Active
    </span>
  ) : (
    <span className="rounded-sm bg-slate-200 px-1.5 py-0.5 text-xs font-medium text-slate-600">
      Inactive
    </span>
  );

// ---------------------------------------------------------------------------
// Configurations — one per screen, with its legacy form/action codes.
// ---------------------------------------------------------------------------

export const BRAND: RegistrationConfig = {
  endpoint: 'brands',
  title: 'Brand',
  subtitle: 'Manufacturers and marques',
  singular: 'Brand',
  permissions: { formId: 3, create: 2022, edit: 2023, remove: 2024 },
  columns: [
    { key: 'id', header: 'ID', numeric: true, width: '4rem' },
    { key: 'name', header: 'Name' },
    { key: 'other_name', header: 'Other name', cell: text('other_name') },
    {
      key: 'is_raw',
      header: 'Catalog',
      width: '8rem',
      cell: (r) => (r.is_raw ? 'Raw material' : 'Finished goods'),
    },
  ],
  fields: [
    { name: 'name', label: 'Name', required: true },
    { name: 'otherName', label: 'Other name' },
    { name: 'isRaw', label: 'Raw material brand', kind: 'checkbox', default: false },
  ],
};

export const CATEGORY: RegistrationConfig = {
  endpoint: 'categories',
  title: 'Category',
  subtitle: 'How items are grouped',
  singular: 'Category',
  permissions: { formId: 4, create: 2032, edit: 2033, remove: 2034 },
  columns: [
    { key: 'id', header: 'ID', numeric: true, width: '4rem' },
    { key: 'name', header: 'Name' },
    { key: 'other_name', header: 'Other name', cell: text('other_name') },
    {
      key: 'is_raw',
      header: 'Catalog',
      width: '8rem',
      cell: (r) => (r.is_raw ? 'Raw material' : 'Finished goods'),
    },
  ],
  fields: [
    { name: 'name', label: 'Name', required: true },
    { name: 'otherName', label: 'Other name' },
    { name: 'isRaw', label: 'Raw material category', kind: 'checkbox', default: false },
  ],
};

export const RAW_PRODUCT: RegistrationConfig = {
  endpoint: 'raw-products',
  title: 'Raw Item',
  subtitle: 'Materials consumed by production and lab work',
  singular: 'Raw item',
  optionsEndpoint: 'catalog-options',
  permissions: { formId: 5, create: 2042, edit: 2043, remove: 2044 },
  columns: [
    { key: 'id', header: 'ID', numeric: true, width: '4rem' },
    { key: 'name', header: 'Name' },
    { key: 'brand_name', header: 'Brand', cell: text('brand_name') },
    { key: 'category_name', header: 'Category', cell: text('category_name') },
    { key: 'price', header: 'Cost', numeric: true, cell: money('price') },
    { key: 'reorder', header: 'Reorder at', numeric: true },
    { key: 'is_active', header: 'Status', width: '7rem', cell: yesNo('is_active') },
  ],
  fields: [
    { name: 'name', label: 'Name', required: true },
    {
      name: 'price',
      label: 'Cost price',
      kind: 'money',
      half: true,
      default: '0',
      hint: 'Used to value purchases, production and lab consumption.',
    },
    { name: 'reorder', label: 'Reorder level', kind: 'number', half: true, default: '0' },
    { name: 'brandId', label: 'Brand', kind: 'select', optionsKey: 'brands', half: true },
    { name: 'catId', label: 'Category', kind: 'select', optionsKey: 'categories', half: true },
    { name: 'isActive', label: 'Active', kind: 'checkbox', default: true },
  ],
};

export const PRODUCT: RegistrationConfig = {
  endpoint: 'products',
  title: 'Finish Product',
  subtitle: 'Goods sold to customers',
  singular: 'Product',
  optionsEndpoint: 'catalog-options',
  permissions: { formId: 6, create: 2052, edit: 2053, remove: 2056 },
  columns: [
    { key: 'id', header: 'ID', numeric: true, width: '4rem' },
    { key: 'name', header: 'Name' },
    { key: 'brand_name', header: 'Brand', cell: text('brand_name') },
    { key: 'price', header: 'Cost', numeric: true, cell: money('price') },
    { key: 'sale_price', header: 'Sale price', numeric: true, cell: money('sale_price') },
    { key: 'reorder_level', header: 'Reorder at', numeric: true },
    { key: 'is_active', header: 'Status', width: '7rem', cell: yesNo('is_active') },
  ],
  fields: [
    { name: 'name', label: 'Name', required: true },
    { name: 'otherName', label: 'Other name' },
    {
      name: 'price',
      label: 'Cost price',
      kind: 'money',
      half: true,
      default: '0',
      hint: 'Drives COGS on every sale — changing it affects future margins.',
    },
    { name: 'salePrice', label: 'Sale price', kind: 'money', half: true, default: '0' },
    { name: 'leastPrice', label: 'Minimum price', kind: 'money', half: true, default: '0' },
    { name: 'reorderLevel', label: 'Reorder level', kind: 'number', half: true, default: '0' },
    { name: 'brandId', label: 'Brand', kind: 'select', optionsKey: 'brands', half: true },
    { name: 'categoryId', label: 'Category', kind: 'select', optionsKey: 'categories', half: true },
    { name: 'unitOfMeasure', label: 'Unit', half: true },
    { name: 'companyBarcode', label: 'Barcode', half: true },
    { name: 'isActive', label: 'Active', kind: 'checkbox', default: true },
  ],
};

export const CUSTOMER: RegistrationConfig = {
  endpoint: 'customers',
  title: 'Customer',
  subtitle: 'Who you sell to',
  singular: 'Customer',
  mintsAccount: true,
  permissions: { formId: 7, create: 2062, edit: 2063, remove: 2064 },
  columns: [
    { key: 'id', header: 'ID', numeric: true, width: '4rem' },
    { key: 'name', header: 'Name' },
    { key: 'phone', header: 'Phone', cell: text('phone') },
    { key: 'city', header: 'City', cell: text('city') },
    { key: 'account_id', header: 'Account', numeric: true, width: '7rem' },
    { key: 'is_active', header: 'Status', width: '7rem', cell: yesNo('is_active') },
  ],
  fields: [
    { name: 'name', label: 'Name', required: true },
    { name: 'code', label: 'Code', half: true },
    { name: 'phone', label: 'Phone', half: true },
    { name: 'mobile', label: 'Mobile', half: true },
    { name: 'cnic', label: 'CNIC', half: true },
    { name: 'address', label: 'Address' },
    { name: 'city', label: 'City', half: true },
    { name: 'province', label: 'Province', half: true },
    { name: 'email', label: 'Email', half: true },
    { name: 'isActive', label: 'Active', kind: 'checkbox', default: true },
  ],
};

export const SUPPLIER: RegistrationConfig = {
  endpoint: 'suppliers',
  title: 'Vendor',
  subtitle: 'Who you buy from',
  singular: 'Vendor',
  mintsAccount: true,
  permissions: { formId: 8, create: 2072, edit: 2073, remove: 2074 },
  columns: [
    { key: 'id', header: 'ID', numeric: true, width: '4rem' },
    { key: 'name', header: 'Name' },
    { key: 'company', header: 'Company', cell: text('company') },
    { key: 'phone', header: 'Phone', cell: text('phone') },
    { key: 'ntn', header: 'NTN', cell: text('ntn') },
    { key: 'account_no', header: 'Account', numeric: true, width: '7rem' },
    { key: 'is_active', header: 'Status', width: '7rem', cell: yesNo('is_active') },
  ],
  fields: [
    { name: 'name', label: 'Name', required: true },
    { name: 'company', label: 'Company', half: true },
    { name: 'contactPerson', label: 'Contact person', half: true },
    { name: 'phone', label: 'Phone', half: true },
    { name: 'email', label: 'Email', half: true },
    { name: 'address', label: 'Address' },
    { name: 'city', label: 'City', half: true },
    { name: 'cnic', label: 'CNIC', half: true },
    { name: 'ntn', label: 'NTN', half: true },
    { name: 'strn', label: 'STRN', half: true },
    { name: 'isActive', label: 'Active', kind: 'checkbox', default: true },
  ],
};

export const EMPLOYEE: RegistrationConfig = {
  endpoint: 'employees',
  title: 'Employee',
  subtitle: 'Staff, and who they work for',
  singular: 'Employee',
  mintsAccount: true,
  optionsEndpoint: 'employee-options',
  permissions: { formId: 9, create: 2082, edit: 2083, remove: 2084 },
  columns: [
    { key: 'id', header: 'ID', numeric: true, width: '4rem' },
    {
      key: 'first_name',
      header: 'Name',
      cell: (r) => [r.first_name, r.last_name].filter(Boolean).join(' '),
    },
    { key: 'code', header: 'Code', cell: text('code') },
    { key: 'phone', header: 'Phone', cell: text('phone') },
    { key: 'branch_name', header: 'Branch', cell: text('branch_name') },
    { key: 'basic_salary', header: 'Salary', numeric: true, cell: money('basic_salary') },
    { key: 'account_no', header: 'Account', numeric: true, width: '7rem' },
  ],
  fields: [
    { name: 'firstName', label: 'First name', required: true, half: true },
    { name: 'lastName', label: 'Last name', half: true },
    { name: 'code', label: 'Employee code', half: true },
    { name: 'cnic', label: 'CNIC', half: true },
    { name: 'phone', label: 'Phone', half: true },
    { name: 'mobile', label: 'Mobile', half: true },
    { name: 'basicSalary', label: 'Basic salary', kind: 'money', half: true, default: '0' },
    {
      name: 'departmentId',
      label: 'Department',
      kind: 'select',
      optionsKey: 'departments',
      half: true,
    },
    { name: 'city', label: 'City', half: true },
    { name: 'joinDate', label: 'Join date', kind: 'date', half: true },
  ],
};

// ---------------------------------------------------------------------------

export function RegistrationPage({ config }: { config: RegistrationConfig }) {
  const { hasAction, user } = useAuth();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const needsBranch = (user?.isSuperAdmin ?? false) && !editing;

  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (search) params.set('search', search);

  const list = useQuery({
    queryKey: [config.endpoint, page, search],
    queryFn: () => api.get<Paged<Record<string, unknown>>>(`/${config.endpoint}?${params}`),
  });

  const options = useQuery({
    queryKey: [config.optionsEndpoint],
    queryFn: () => api.get<Record<string, { id: number; name: string | null }[]>>(
      `/${config.optionsEndpoint}`,
    ),
    enabled: Boolean(config.optionsEndpoint),
  });

  const branches = useQuery({
    queryKey: ['branches', 'options'],
    queryFn: () => api.get<{ rows: { id: number; name: string }[] }>('/branches?pageSize=200'),
    enabled: needsBranch,
  });

  const defaults = () =>
    Object.fromEntries(
      config.fields.map((f) => [f.name, f.default ?? (f.kind === 'checkbox' ? false : '')]),
    );

  const close = () => {
    setCreating(false);
    setEditing(null);
    setForm({});
    setFieldErrors({});
  };

  const save = useMutation({
    mutationFn: () => {
      // Blank optional text fields go as null rather than empty string.
      const payload: Record<string, unknown> = {};
      for (const f of config.fields) {
        const v = form[f.name];
        payload[f.name] = v === '' ? null : v;
      }
      if (needsBranch && form.branchId) payload.branchId = form.branchId;

      return editing
        ? api.put(`/${config.endpoint}/${editing.id}`, payload)
        : api.post(`/${config.endpoint}`, payload);
    },
    onSuccess: () => {
      toast.success(editing ? `${config.singular} updated` : `${config.singular} created`);
      void queryClient.invalidateQueries({ queryKey: [config.endpoint] });
      close();
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        toast.error(err.message);
      } else {
        toast.error(`Could not save the ${config.singular.toLowerCase()}`);
      }
    },
  });

  const remove = useMutation({
    mutationFn: (row: Record<string, unknown>) => api.del(`/${config.endpoint}/${row.id}`),
    onSuccess: () => {
      toast.success(`${config.singular} deleted`);
      void queryClient.invalidateQueries({ queryKey: [config.endpoint] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not delete'),
  });

  const canCreate = hasAction(config.permissions.formId, config.permissions.create);
  const canEdit = hasAction(config.permissions.formId, config.permissions.edit);
  const canRemove =
    config.permissions.remove !== undefined &&
    hasAction(config.permissions.formId, config.permissions.remove);

  const renderField = (f: FieldSpec): ReactNode => {
    const value = form[f.name];

    if (f.kind === 'checkbox') {
      return (
        <label key={f.name} className="flex items-center gap-2 py-1 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => setForm({ ...form, [f.name]: e.target.checked })}
            className="rounded-sm border-slate-300"
          />
          {f.label}
        </label>
      );
    }

    if (f.kind === 'select') {
      const opts = options.data?.[f.optionsKey ?? ''] ?? [];
      return (
        <div key={f.name}>
          <label htmlFor={f.name} className="field-label">
            {f.label}
          </label>
          <select
            id={f.name}
            className="field-input"
            value={(value as string) ?? ''}
            onChange={(e) => setForm({ ...form, [f.name]: e.target.value || null })}
          >
            <option value="">None</option>
            {opts.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      );
    }

    return (
      <Field
        key={f.name}
        label={f.label}
        name={f.name}
        required={f.required ?? false}
        type={f.kind === 'money' || f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text'}
        step={f.kind === 'money' ? 'any' : undefined}
        value={(value as string) ?? ''}
        error={fieldErrors[f.name]}
        hint={f.hint}
        onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
      />
    );
  };

  return (
    <>
      <PageHeader
        title={config.title}
        subtitle={config.subtitle}
        actions={
          canCreate && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setForm(defaults());
                setCreating(true);
              }}
            >
              <Plus className="size-3.5" />
              New {config.singular}
            </button>
          )
        }
      />

      <div className="no-print mb-3 max-w-xs">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            placeholder={`Search ${config.title.toLowerCase()}…`}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="field-input pl-8"
            aria-label={`Search ${config.title}`}
          />
        </div>
      </div>

      <DataTable
        columns={config.columns}
        rows={list.data?.rows ?? []}
        rowKey={(r) => String(r.id)}
        loading={list.isPending}
        error={list.error ? (list.error as Error).message : null}
        emptyMessage={search ? `Nothing matches "${search}"` : `No ${config.title.toLowerCase()} yet`}
        actions={
          canEdit || canRemove
            ? (row) => (
                <div className="flex justify-end gap-1">
                  {canEdit && (
                    <button
                      type="button"
                      title="Edit"
                      className="rounded-sm p-1.5 text-slate-500 hover:bg-slate-100 hover:text-brand-600"
                      onClick={() => {
                        // Seed the form from the row, mapping snake_case
                        // columns back onto the camelCase field names.
                        const seeded: Record<string, unknown> = {};
                        for (const f of config.fields) {
                          const snake = f.name.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
                          seeded[f.name] = row[f.name] ?? row[snake] ?? (f.kind === 'checkbox' ? false : '');
                        }
                        setForm(seeded);
                        setEditing(row);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  )}
                  {canRemove && (
                    <button
                      type="button"
                      title="Delete"
                      className="rounded-sm p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600"
                      onClick={() => {
                        if (confirm(`Delete "${row.name ?? row.first_name}"?`)) remove.mutate(row);
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

      {list.data && (
        <Pagination
          page={list.data.page}
          pageSize={list.data.pageSize}
          total={list.data.total}
          onPageChange={setPage}
        />
      )}

      <Modal
        open={creating || editing !== null}
        title={editing ? `Edit ${config.singular}` : `New ${config.singular}`}
        size="lg"
        onClose={close}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        {config.mintsAccount && !editing && (
          <p className="mb-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
            A chart-of-accounts code is created automatically so this{' '}
            {config.singular.toLowerCase()} can be posted against.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {config.fields.map((f) => (
            <div key={f.name} className={f.half ? '' : 'sm:col-span-2'}>
              {renderField(f)}
            </div>
          ))}

          {needsBranch && (
            <div className="sm:col-span-2">
              <label htmlFor="branchId" className="field-label">
                Branch<span className="ml-0.5 text-red-500">*</span>
              </label>
              <select
                id="branchId"
                className="field-input"
                value={(form.branchId as string) ?? ''}
                onChange={(e) => setForm({ ...form, branchId: e.target.value })}
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
