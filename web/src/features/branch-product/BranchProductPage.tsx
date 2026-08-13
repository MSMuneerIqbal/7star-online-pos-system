import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/money';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { Modal } from '@/components/ui/Modal';
import { Field, PageHeader } from '@/components/ui/Field';

/**
 * My Prices — a branch's own view onto the master catalog (Phase 1, the
 * catalog split). Every row already exists, created by the fan-out trigger
 * for every active product at every active branch — this screen only edits
 * the price/location/threshold a branch owns, never creates or deletes a
 * row.
 */

interface BranchProductRow {
  id: number;
  product_id: number;
  product_name: string | null;
  type: string;
  placement: string;
  brand_name: string | null;
  selling_price: string;
  minimum_price: string;
  wholesale_cost: string;
  location: string | null;
  low_stock_threshold: string;
  is_active: boolean;
}

interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

// New work — head 12, form 53, form code 1201 (PLAN.md ground rule 9).
const PERM = { formId: 53, view: 12011, edit: 12013 };

const EMPTY = { sellingPrice: '0', minimumPrice: '0', location: '', lowStockThreshold: '0', isActive: true };

export function BranchProductPage() {
  const { hasAction, user } = useAuth();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [branchId, setBranchId] = useState<number | null>(null);
  const [editing, setEditing] = useState<BranchProductRow | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const needsBranch = user?.isSuperAdmin ?? false;

  const branches = useQuery({
    queryKey: ['branches', 'options'],
    queryFn: () => api.get<{ rows: { id: number; name: string }[] }>('/branches?pageSize=200'),
    enabled: needsBranch,
  });

  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (search) params.set('search', search);
  if (branchId !== null) params.set('branchId', String(branchId));

  const list = useQuery({
    queryKey: ['branch-products', page, search, branchId],
    queryFn: () => api.get<Paged<BranchProductRow>>(`/branch-products?${params}`),
    enabled: !needsBranch || branchId !== null,
  });

  const close = () => {
    setEditing(null);
    setForm(EMPTY);
    setFieldErrors({});
  };

  const save = useMutation({
    mutationFn: () => api.put(`/branch-products/${editing?.id}`, form),
    onSuccess: () => {
      toast.success(`${editing?.product_name} updated`);
      void queryClient.invalidateQueries({ queryKey: ['branch-products'] });
      close();
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        toast.error(err.message);
      } else {
        toast.error('Could not save the price');
      }
    },
  });

  const canEdit = hasAction(PERM.formId, PERM.edit);

  const columns: readonly Column<BranchProductRow>[] = [
    { key: 'product_name', header: 'Product', cell: (r) => r.product_name ?? '—' },
    { key: 'brand_name', header: 'Brand', cell: (r) => r.brand_name ?? '—' },
    { key: 'type', header: 'Type', width: '7rem' },
    { key: 'placement', header: 'Placement', width: '7rem' },
    {
      key: 'selling_price',
      header: 'Selling price',
      numeric: true,
      cell: (r) => fmtMoney(r.selling_price),
    },
    {
      key: 'minimum_price',
      header: 'Minimum price',
      numeric: true,
      cell: (r) => fmtMoney(r.minimum_price),
    },
    {
      key: 'wholesale_cost',
      header: 'Wholesale cost',
      numeric: true,
      cell: (r) => fmtMoney(r.wholesale_cost),
    },
    { key: 'location', header: 'Location', cell: (r) => r.location ?? '—' },
    { key: 'low_stock_threshold', header: 'Reorder at', numeric: true },
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

  return (
    <>
      <PageHeader title="My Prices" subtitle="This branch's selling price, minimum price and stock location" />

      <div className="no-print mb-3 flex max-w-lg items-center gap-2">
        {needsBranch && (
          <select
            className="field-input max-w-48"
            value={branchId ?? ''}
            onChange={(e) => {
              setBranchId(e.target.value ? Number(e.target.value) : null);
              setPage(1);
            }}
            aria-label="Branch"
          >
            <option value="">Select a branch…</option>
            {branches.data?.rows.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}

        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            placeholder="Search products…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="field-input pl-8"
            aria-label="Search products"
          />
        </div>
      </div>

      {needsBranch && branchId === null ? (
        <p className="card p-4 text-sm text-slate-500">Select a branch to see its prices.</p>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={list.data?.rows ?? []}
            rowKey={(r) => r.id}
            loading={list.isPending}
            error={list.error ? (list.error as Error).message : null}
            emptyMessage={search ? `Nothing matches "${search}"` : 'No products yet'}
            actions={
              canEdit
                ? (row) => (
                    <button
                      type="button"
                      title="Edit price"
                      className="rounded-sm p-1.5 text-slate-500 hover:bg-slate-100 hover:text-brand-600"
                      onClick={() => {
                        setEditing(row);
                        setForm({
                          sellingPrice: row.selling_price,
                          minimumPrice: row.minimum_price,
                          location: row.location ?? '',
                          lowStockThreshold: row.low_stock_threshold,
                          isActive: row.is_active,
                        });
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </button>
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
        </>
      )}

      <Modal
        open={editing !== null}
        title={editing ? `Edit price — ${editing.product_name}` : ''}
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
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Selling price"
            name="sellingPrice"
            type="number"
            step="any"
            value={form.sellingPrice}
            error={fieldErrors.sellingPrice}
            onChange={(e) => setForm({ ...form, sellingPrice: e.target.value })}
          />
          <Field
            label="Minimum price"
            name="minimumPrice"
            type="number"
            step="any"
            hint="The floor a salesman cannot discount below."
            value={form.minimumPrice}
            error={fieldErrors.minimumPrice}
            onChange={(e) => setForm({ ...form, minimumPrice: e.target.value })}
          />
          <Field
            label="Location"
            name="location"
            value={form.location}
            error={fieldErrors.location}
            onChange={(e) => setForm({ ...form, location: e.target.value })}
          />
          <Field
            label="Reorder at"
            name="lowStockThreshold"
            type="number"
            step="any"
            value={form.lowStockThreshold}
            error={fieldErrors.lowStockThreshold}
            onChange={(e) => setForm({ ...form, lowStockThreshold: e.target.value })}
          />

          <div className="sm:col-span-2">
            <span className="field-label">Wholesale cost</span>
            <p className="field-input flex items-center bg-slate-50 text-slate-500">
              {editing ? fmtMoney(editing.wholesale_cost) : '—'}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Set by confirmed receipt from the warehouse, not typed here.
            </p>
          </div>

          <label className="flex items-center gap-2 py-1 text-sm text-slate-700 sm:col-span-2">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              className="rounded-sm border-slate-300"
            />
            Active
          </label>
        </div>
      </Modal>
    </>
  );
}
