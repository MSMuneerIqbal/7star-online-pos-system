/**
 * Warranty claims — the Queue pattern (DESIGN §5).
 *
 * The customer never waits: the branch hands over a replacement from its own
 * shelf on the day, parks the faulty unit in Warranty Hold, and claims after.
 * The warehouse then assesses each unit and the outcome is a recorded field, not
 * a note — repaired and replaced are reported separately because a rising
 * replacement rate on a model is a manufacturing signal (PRINCIPLES §8).
 *
 * The branch is never charged. Nothing on this screen moves its dues.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Plus, Save, ShieldAlert, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
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

interface ClaimRow {
  id: number;
  doc_number: string;
  date: string;
  status: string;
  branch_name: string | null;
}

interface Option {
  id: number;
  name: string | null;
}

interface FormData {
  products: Option[];
  rawProducts: Option[];
  branches: Array<Option & { type: string }>;
  defaultBranchId: number | null;
}

interface ClaimDetail {
  id: number;
  doc_number: string;
  status: string;
  lines: Array<{
    id: number;
    product_id: number;
    qty: string;
    assessment: string | null;
    outcome: string | null;
    grade: string | null;
  }>;
}

/** Form 57 / code 512. */
const PERM = { formId: 57, view: 5121, create: 5122, edit: 5123 };

type Assessment = 'REPAIRABLE' | 'NOT_REPAIRABLE';

interface ClaimLineDraft {
  productId: number | null;
  qty: string;
}

interface ResolveLineDraft {
  productId: number;
  qty: string;
  assessment: Assessment;
  parts: Array<{ pid: number | null; qty: string }>;
}

const today = () => new Date().toISOString().slice(0, 10);
const TABS = ['ALL', 'RAISED', 'CLOSED'] as const;
type Tab = (typeof TABS)[number];

export function WarrantyPage() {
  const { hasAction, user } = useAuth();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<Tab>('ALL');

  const [claiming, setClaiming] = useState(false);
  const [holding, setHolding] = useState(false);
  const [resolvingId, setResolvingId] = useState<number | null>(null);

  const form = useQuery({
    queryKey: ['warranty', 'form-data'],
    queryFn: () => api.get<FormData>('/warranty/form-data'),
  });

  const list = useQuery({
    queryKey: ['warranty', 'claims', page],
    queryFn: () => api.get<Paged<ClaimRow>>(`/warranty/claims?page=${page}&pageSize=20`),
  });

  const rows = useMemo(() => {
    const all = list.data?.rows ?? [];
    return tab === 'ALL' ? all : all.filter((r) => r.status === tab);
  }, [list.data, tab]);

  const counts = useMemo(() => {
    const all = list.data?.rows ?? [];
    return {
      ALL: all.length,
      RAISED: all.filter((r) => r.status === 'RAISED').length,
      CLOSED: all.filter((r) => r.status === 'CLOSED').length,
    } satisfies Record<Tab, number>;
  }, [list.data]);

  const columns: readonly Column<ClaimRow>[] = [
    { key: 'doc_number', header: 'No.', width: '8rem' },
    { key: 'date', header: 'Date', width: '7.5rem' },
    { key: 'branch_name', header: 'Claiming branch', cell: (r) => r.branch_name ?? '—' },
    {
      key: 'status',
      header: 'Status',
      width: '9rem',
      cell: (r) => <StatusPill status={r.status} />,
    },
  ];

  const canCreate = hasAction(PERM.formId, PERM.create);
  const canResolve = hasAction(PERM.formId, PERM.edit) && (user?.isSuperAdmin ?? false);

  return (
    <>
      <PageHeader
        title="Warranty"
        subtitle="Claims raised by branches, assessed at the warehouse. The branch is never charged."
        actions={
          canCreate && (
            <div className="flex gap-2">
              <button type="button" className="btn-secondary" onClick={() => setHolding(true)}>
                <ShieldAlert className="size-3.5" />
                Warranty Hold
              </button>
              <button type="button" className="btn-primary" onClick={() => setClaiming(true)}>
                <Plus className="size-3.5" />
                New Claim
              </button>
            </div>
          )
        }
      />

      {/* Status tabs with live counts — DESIGN §5, "Queue". */}
      <div className="mb-3 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px border-b-2 px-3 py-1.5 text-sm font-medium transition',
              tab === t
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {t === 'ALL' ? 'All' : t.charAt(0) + t.slice(1).toLowerCase()}
            <span className="ml-1.5 text-xs text-slate-400 tabular">{counts[t]}</span>
          </button>
        ))}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.error ? (list.error as Error).message : null}
        emptyMessage="No warranty claims yet"
        actions={
          canResolve
            ? (row) =>
                row.status === 'RAISED' ? (
                  <button
                    type="button"
                    title="Assess and resolve at the warehouse"
                    className="rounded-sm p-1.5 text-slate-500 hover:bg-brand-50 hover:text-brand-700"
                    onClick={() => setResolvingId(row.id)}
                  >
                    <ClipboardCheck className="size-3.5" />
                  </button>
                ) : undefined
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

      {claiming && form.data && (
        <NewClaimModal
          form={form.data}
          isSuper={user?.isSuperAdmin ?? false}
          onClose={() => setClaiming(false)}
          onSaved={() => {
            setClaiming(false);
            void queryClient.invalidateQueries({ queryKey: ['warranty'] });
          }}
        />
      )}

      {holding && form.data && (
        <WarrantyHoldModal
          form={form.data}
          isSuper={user?.isSuperAdmin ?? false}
          onClose={() => setHolding(false)}
          onSaved={() => {
            setHolding(false);
            void queryClient.invalidateQueries({ queryKey: ['warranty'] });
          }}
        />
      )}

      {resolvingId !== null && form.data && (
        <ResolveClaimModal
          claimId={resolvingId}
          form={form.data}
          onClose={() => setResolvingId(null)}
          onSaved={() => {
            setResolvingId(null);
            void queryClient.invalidateQueries({ queryKey: ['warranty'] });
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Raise a claim — the branch ships its faulty units back
// ---------------------------------------------------------------------------

function NewClaimModal({
  form,
  isSuper,
  onClose,
  onSaved,
}: {
  form: FormData;
  isSuper: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(today());
  const [branchId, setBranchId] = useState<number | null>(form.defaultBranchId);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<ClaimLineDraft[]>([{ productId: null, qty: '1' }]);

  const save = useMutation({
    mutationFn: () =>
      api.post('/warranty/claims', {
        date,
        branchId,
        note: note || null,
        lines: lines
          .filter((l) => l.productId !== null && Number(l.qty) > 0)
          .map((l) => ({ productId: l.productId, qty: l.qty })),
      }),
    onSuccess: () => {
      toast.success('Claim raised');
      onSaved();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not raise the claim'),
  });

  const valid =
    branchId !== null && lines.some((l) => l.productId !== null && Number(l.qty) > 0);

  return (
    <Modal
      open
      title="New Warranty Claim"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
          >
            <Save className="size-3.5" />
            Raise Claim
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {isSuper && (
          <div>
            <label htmlFor="claimBranch" className="field-label">
              Claiming branch<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              id="claimBranch"
              className="field-input"
              value={branchId ?? ''}
              onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select a branch…</option>
              {form.branches
                .filter((b) => b.type !== 'WAREHOUSE')
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>
          </div>
        )}

        <Field label="Date" name="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />

        <LineEditor
          products={form.products}
          lines={lines}
          onChange={setLines}
          addLabel="Add unit"
          qtyLabel="Units"
        />

        <Field label="Note" name="note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Warranty hold — the faulty unit sits at the branch, out of sellable stock
// ---------------------------------------------------------------------------

function WarrantyHoldModal({
  form,
  isSuper,
  onClose,
  onSaved,
}: {
  form: FormData;
  isSuper: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(today());
  const [branchId, setBranchId] = useState<number | null>(form.defaultBranchId);
  const [productId, setProductId] = useState<number | null>(null);
  const [qty, setQty] = useState('1');
  const [note, setNote] = useState('');

  const save = useMutation({
    mutationFn: () => api.post('/warranty/holds', { date, branchId, productId, qty, note: note || null }),
    onSuccess: () => {
      toast.success('Unit placed in warranty hold');
      onSaved();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the hold'),
  });

  return (
    <Modal
      open
      title="Warranty Hold"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={branchId === null || productId === null || Number(qty) <= 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            <Save className="size-3.5" />
            Record
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
          A unit in warranty hold is not on sale and is not part of this branch&rsquo;s inventory value.
        </p>

        {isSuper && (
          <div>
            <label htmlFor="holdBranch" className="field-label">
              Branch<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              id="holdBranch"
              className="field-input"
              value={branchId ?? ''}
              onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select a branch…</option>
              {form.branches
                .filter((b) => b.type !== 'WAREHOUSE')
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>
          </div>
        )}

        <Field label="Date" name="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />

        <div>
          <label htmlFor="holdProduct" className="field-label">
            Model<span className="ml-0.5 text-red-500">*</span>
          </label>
          <select
            id="holdProduct"
            className="field-input"
            value={productId ?? ''}
            onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Select a model…</option>
            {form.products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <Field
          label="Units"
          name="qty"
          type="number"
          min="0"
          step="any"
          required
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />
        <Field label="Note" name="note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Assess — the warehouse decides, per unit, and the battery's condition decides
// ---------------------------------------------------------------------------

function ResolveClaimModal({
  claimId,
  form,
  onClose,
  onSaved,
}: {
  claimId: number;
  form: FormData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const warehouse = form.branches.find((b) => b.type === 'WAREHOUSE');

  const detail = useQuery({
    queryKey: ['warranty', 'claim', claimId],
    queryFn: () => api.get<ClaimDetail>(`/warranty/claims/${claimId}`),
  });

  const [date, setDate] = useState(today());
  const [lines, setLines] = useState<ResolveLineDraft[] | null>(null);

  // Seed the assessment rows from the claim the first time it arrives.
  const drafts =
    lines ??
    (detail.data?.lines ?? []).map((l) => ({
      productId: l.product_id,
      qty: l.qty,
      assessment: 'REPAIRABLE' as Assessment,
      parts: [] as Array<{ pid: number | null; qty: string }>,
    }));

  const save = useMutation({
    mutationFn: () =>
      api.post(`/warranty/claims/${claimId}/resolve`, {
        date,
        warehouseBranchId: warehouse?.id,
        lines: drafts.map((l) => ({
          productId: l.productId,
          qty: l.qty,
          assessment: l.assessment,
          ...(l.assessment === 'REPAIRABLE'
            ? {
                parts: l.parts
                  .filter((p) => p.pid !== null && Number(p.qty) > 0)
                  .map((p) => ({ pid: p.pid, qty: p.qty })),
              }
            : {}),
        })),
      }),
    onSuccess: () => {
      toast.success('Claim assessed and closed');
      onSaved();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not resolve the claim'),
  });

  function update(i: number, patch: Partial<ResolveLineDraft>) {
    setLines(drafts.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  const productName = (id: number) => form.products.find((p) => p.id === id)?.name ?? `#${id}`;

  return (
    <Modal
      open
      title={`Assess ${detail.data?.doc_number ?? 'claim'}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!warehouse || drafts.length === 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            <Save className="size-3.5" />
            Resolve
          </button>
        </>
      }
    >
      {detail.isPending ? (
        <p className="text-sm text-slate-500">Loading the claim…</p>
      ) : !warehouse ? (
        <p className="field-error">No warehouse branch is configured, so a claim cannot be resolved.</p>
      ) : (
        <div className="space-y-3">
          <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Either outcome goes back to the branch that claimed it. The warehouse carries the cost —
            parts on a repair, a whole battery on a replacement — and the branch&rsquo;s dues do not move.
          </p>

          <Field label="Date" name="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />

          {drafts.map((line, i) => (
            <div key={i} className="rounded-md border border-slate-200 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-900">{productName(line.productId)}</span>
                <span className="text-xs text-slate-500 tabular">{line.qty} unit(s)</span>
              </div>

              <div className="flex gap-1.5">
                {(['REPAIRABLE', 'NOT_REPAIRABLE'] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => update(i, { assessment: a })}
                    className={cn(
                      'flex-1 rounded-sm border px-2 py-1.5 text-xs font-medium transition',
                      line.assessment === a
                        ? 'border-brand-600 bg-brand-50 text-brand-700'
                        : 'border-slate-200 text-slate-600 hover:border-slate-300',
                    )}
                  >
                    {a === 'REPAIRABLE' ? 'Repairable — same unit back' : 'Not repairable — new unit'}
                  </button>
                ))}
              </div>

              {line.assessment === 'REPAIRABLE' && (
                <div className="mt-2 space-y-1.5">
                  <p className="field-label">Parts consumed</p>
                  {line.parts.map((p, pi) => (
                    <div key={pi} className="flex gap-1.5">
                      <select
                        className="field-input flex-1"
                        aria-label="Raw item"
                        value={p.pid ?? ''}
                        onChange={(e) =>
                          update(i, {
                            parts: line.parts.map((x, xi) =>
                              xi === pi ? { ...x, pid: e.target.value ? Number(e.target.value) : null } : x,
                            ),
                          })
                        }
                      >
                        <option value="">Select a part…</option>
                        {form.rawProducts.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                      <input
                        className="field-input w-20 text-right"
                        type="number"
                        min="0"
                        step="any"
                        aria-label="Quantity"
                        value={p.qty}
                        onChange={(e) =>
                          update(i, {
                            parts: line.parts.map((x, xi) => (xi === pi ? { ...x, qty: e.target.value } : x)),
                          })
                        }
                      />
                      <button
                        type="button"
                        aria-label="Remove part"
                        className="rounded-sm p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                        onClick={() => update(i, { parts: line.parts.filter((_, xi) => xi !== pi) })}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => update(i, { parts: [...line.parts, { pid: null, qty: '1' }] })}
                  >
                    <Plus className="size-3.5" />
                    Add part
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Shared line editor
// ---------------------------------------------------------------------------

function LineEditor({
  products,
  lines,
  onChange,
  addLabel,
  qtyLabel,
}: {
  products: Option[];
  lines: ClaimLineDraft[];
  onChange: (lines: ClaimLineDraft[]) => void;
  addLabel: string;
  qtyLabel: string;
}) {
  return (
    <div className="space-y-1.5">
      <p className="field-label">{qtyLabel}</p>
      {lines.map((line, i) => (
        <div key={i} className="flex gap-1.5">
          <select
            className="field-input flex-1"
            aria-label="Model"
            value={line.productId ?? ''}
            onChange={(e) =>
              onChange(
                lines.map((l, idx) =>
                  idx === i ? { ...l, productId: e.target.value ? Number(e.target.value) : null } : l,
                ),
              )
            }
          >
            <option value="">Select a model…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            className="field-input w-20 text-right"
            type="number"
            min="0"
            step="any"
            aria-label="Quantity"
            value={line.qty}
            onChange={(e) => onChange(lines.map((l, idx) => (idx === i ? { ...l, qty: e.target.value } : l)))}
          />
          <button
            type="button"
            aria-label="Remove line"
            disabled={lines.length === 1}
            className="rounded-sm p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
            onClick={() => onChange(lines.filter((_, idx) => idx !== i))}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn-secondary"
        onClick={() => onChange([...lines, { productId: null, qty: '1' }])}
      >
        <Plus className="size-3.5" />
        {addLabel}
      </button>
    </div>
  );
}
