import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/Field';

interface Head {
  head_id: number;
  head_name: string;
  code: number;
}

interface Form {
  id: number;
  head_id: number;
  form_name: string;
  sub: string | null;
  form_code: number;
}

interface Action {
  id: number;
  form_id: number;
  action_name: string;
  action_code: number;
}

interface Tree {
  heads: Head[];
  forms: Form[];
  actions: Action[];
}

interface Role {
  id: number;
  name: string;
  branch_name: string | null;
}

interface Grant {
  head_id: number;
  form_id: number;
  action_id: number;
}

const key = (formId: number, actionId: number) => `${formId}:${actionId}`;

/**
 * Role Assignment — the permission matrix.
 *
 * Edits the `role_assign` rows every permission check in the system reads, over
 * the head → form → action tree. Those ids came out of the legacy UI itself
 * (migration 1700000000003), which is why existing grants keep working.
 */
export function RoleAssignPage() {
  const queryClient = useQueryClient();
  const [roleId, setRoleId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const roles = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: () => api.get<Role[]>('/admin/roles'),
  });

  const tree = useQuery({
    queryKey: ['admin', 'permission-tree'],
    queryFn: () => api.get<Tree>('/admin/permission-tree'),
  });

  const grants = useQuery({
    queryKey: ['admin', 'roles', roleId, 'permissions'],
    queryFn: () => api.get<Grant[]>(`/admin/roles/${roleId}/permissions`),
    enabled: roleId !== null,
  });

  // Reset the working set whenever a different role's grants arrive.
  useEffect(() => {
    if (grants.data) {
      setSelected(new Set(grants.data.map((g) => key(g.form_id, g.action_id))));
    }
  }, [grants.data]);

  const actionsByForm = useMemo(() => {
    const map = new Map<number, Action[]>();
    for (const a of tree.data?.actions ?? []) {
      const list = map.get(a.form_id);
      if (list) list.push(a);
      else map.set(a.form_id, [a]);
    }
    return map;
  }, [tree.data]);

  const save = useMutation({
    mutationFn: () => {
      const forms = new Map((tree.data?.forms ?? []).map((f) => [f.id, f]));

      const payload = [...selected].map((k) => {
        const [formId, actionId] = k.split(':').map(Number);
        return {
          headId: forms.get(formId!)?.head_id ?? 0,
          formId: formId!,
          actionId: actionId!,
        };
      });

      return api.put(`/admin/roles/${roleId}/permissions`, { grants: payload });
    },
    onSuccess: () => {
      toast.success('Permissions saved — takes effect immediately');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'roles', roleId, 'permissions'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not save permissions'),
  });

  const toggle = (formId: number, actionId: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const k = key(formId, actionId);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  /** Tick or clear every action on a form at once. */
  const toggleForm = (formId: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const actions = actionsByForm.get(formId) ?? [];
      const allOn = actions.every((a) => next.has(key(formId, a.action_code)));

      for (const a of actions) {
        const k = key(formId, a.action_code);
        if (allOn) next.delete(k);
        else next.add(k);
      }
      return next;
    });

  return (
    <>
      <PageHeader
        title="Role Assignment"
        subtitle="What each role is allowed to see and do"
        actions={
          roleId !== null && (
            <button
              type="button"
              className="btn-primary"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              <Save className="size-3.5" />
              {save.isPending ? 'Saving…' : `Save ${selected.size} permission(s)`}
            </button>
          )
        }
      />

      <div className="card no-print mb-4 flex flex-wrap items-end gap-3 p-3">
        <div className="min-w-64">
          <label htmlFor="role" className="field-label">
            Role
          </label>
          <select
            id="role"
            className="field-input"
            value={roleId ?? ''}
            onChange={(e) => setRoleId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Select a role…</option>
            {roles.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.branch_name ? ` — ${r.branch_name}` : ''}
              </option>
            ))}
          </select>
        </div>

        {roleId !== null && (
          <p className="pb-2 text-sm text-slate-500">
            <Shield className="mr-1 inline size-3.5" />
            Super admins bypass every check — this matrix applies to normal users only.
          </p>
        )}
      </div>

      {roleId === null ? (
        <p className="card p-6 text-center text-sm text-slate-500">
          Choose a role to edit its permissions.
        </p>
      ) : tree.isPending || grants.isFetching ? (
        <div className="grid place-items-center p-10">
          <Loader2 className="size-5 animate-spin text-slate-400" />
        </div>
      ) : (
        <div className="space-y-4">
          {tree.data?.heads.map((head) => {
            const forms = (tree.data?.forms ?? []).filter((f) => f.head_id === head.head_id);
            if (forms.length === 0) return null;

            return (
              <div key={head.head_id} className="card overflow-hidden">
                <h2 className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold tracking-wide text-slate-600 uppercase">
                  {head.head_name}
                </h2>

                <table className="w-full border-collapse text-sm">
                  <tbody>
                    {forms.map((form) => {
                      const actions = actionsByForm.get(form.id) ?? [];

                      return (
                        <tr key={form.id} className="border-b border-slate-100 last:border-0">
                          <td className="w-64 px-3 py-1.5">
                            <button
                              type="button"
                              onClick={() => toggleForm(form.id)}
                              className="text-left hover:text-brand-700"
                              title="Toggle every action on this screen"
                            >
                              {form.form_name}
                              {form.sub && (
                                <span className="ml-1 text-xs text-slate-400">({form.sub})</span>
                              )}
                            </button>
                          </td>

                          <td className="px-3 py-1.5">
                            <div className="flex flex-wrap gap-3">
                              {actions.map((a) => {
                                const on = selected.has(key(form.id, a.action_code));

                                return (
                                  <label
                                    key={a.id}
                                    className={cn(
                                      'flex cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs',
                                      on
                                        ? 'bg-brand-50 font-medium text-brand-800'
                                        : 'text-slate-500 hover:bg-slate-50',
                                    )}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={on}
                                      onChange={() => toggle(form.id, a.action_code)}
                                      className="rounded-sm border-slate-300"
                                    />
                                    {a.action_name}
                                  </label>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
