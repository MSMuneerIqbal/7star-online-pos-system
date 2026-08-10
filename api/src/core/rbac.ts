/**
 * Role-based access control.
 *
 * Ports the legacy three-level model verbatim — head -> form -> action — so the
 * existing `role_assign` rows keep working unchanged:
 *
 *   Userhelper.HasHead(2)          -> hasHead(2)
 *   Userhelper.HasForm(6)          -> hasForm(6)
 *   Userhelper.HasAction(12, 4011) -> hasAction(12, 4011)
 *
 * Super admin (emp_id === 0) bypasses every check, matching the legacy
 * `if (IsSuperAdmin()) return true` short-circuit.
 *
 * Difference from legacy: permissions are read from the database per request
 * (memoised for 60s) rather than baked into the auth cookie at login. A
 * revoked permission now takes effect within a minute instead of requiring the
 * user to log out.
 */
import { db } from './db/index.js';
import { badRequest, forbidden } from './errors.js';

export interface Assignment {
  head_id: number;
  form_id: number;
  action_id: number;
}

export interface Principal {
  userId: number;
  username: string;
  empId: number;
  branchId: number;
  roleId: number | null;
  isSuperAdmin: boolean;
}

// ---------------------------------------------------------------------------
// Permission cache — keyed by role, short TTL.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
const cache = new Map<number, { at: number; assignments: Assignment[] }>();

export function invalidateRoleCache(roleId?: number): void {
  if (roleId === undefined) cache.clear();
  else cache.delete(roleId);
}

async function loadAssignments(roleId: number): Promise<Assignment[]> {
  const hit = cache.get(roleId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.assignments;

  const assignments = await db
    .selectFrom('role_assign')
    .select(['head_id', 'form_id', 'action_id'])
    .where('role_id', '=', roleId)
    .execute();

  cache.set(roleId, { at: Date.now(), assignments });
  return assignments;
}

// ---------------------------------------------------------------------------
// Permission set
// ---------------------------------------------------------------------------

export class Permissions {
  private constructor(
    private readonly assignments: Assignment[],
    readonly isSuperAdmin: boolean,
  ) {}

  static async forPrincipal(principal: Principal): Promise<Permissions> {
    if (principal.isSuperAdmin) return new Permissions([], true);
    if (principal.roleId === null) return new Permissions([], false);

    return new Permissions(await loadAssignments(principal.roleId), false);
  }

  /** Menu section visibility. */
  hasHead(headId: number): boolean {
    return this.isSuperAdmin || this.assignments.some((a) => a.head_id === headId);
  }

  /** Screen visibility. */
  hasForm(formId: number): boolean {
    return this.isSuperAdmin || this.assignments.some((a) => a.form_id === formId);
  }

  /** Button-level permission: view / new / edit / delete / print. */
  hasAction(formId: number, actionId: number): boolean {
    return (
      this.isSuperAdmin ||
      this.assignments.some((a) => a.form_id === formId && a.action_id === actionId)
    );
  }

  assertAction(formId: number, actionId: number): void {
    if (!this.hasAction(formId, actionId)) {
      throw forbidden(`Missing permission for form ${formId}, action ${actionId}`);
    }
  }

  /** Serialised for the client so the React sidebar can mirror server rules. */
  toJSON(): { isSuperAdmin: boolean; assignments: Assignment[] } {
    return { isSuperAdmin: this.isSuperAdmin, assignments: this.assignments };
  }
}

// ---------------------------------------------------------------------------
// Branch scoping
//
// In the legacy code this was a ternary repeated in all 42 controllers:
//   (_userId == 0 && _branchId == 0 && isSuperAdmin) ? <all> : <this branch>
// Centralised here so a new module cannot forget it and leak another branch's
// data.
// ---------------------------------------------------------------------------

/**
 * Resolve which branch a query should be limited to.
 * `null` means "all branches" (super admin).
 */
export function branchFilter(principal: Principal): number | null {
  return principal.isSuperAdmin ? null : principal.branchId;
}

/** Reject an attempt to write to a branch the principal does not own. */
export function assertBranchAccess(principal: Principal, branchId: number): void {
  if (!principal.isSuperAdmin && principal.branchId !== branchId) {
    throw forbidden('You cannot act on another branch');
  }
}

/** Branch 0 is the "All Branches" sentinel — never a document's owner. */
export const SENTINEL_BRANCH = 0;

/**
 * The branch a new record belongs to. Non-super-admins cannot choose; the
 * legacy code forced `sale.BranchId = _branchId` the same way.
 *
 * A super admin signs in with branchId 0, which means "all branches" for
 * *reading*. It is not a valid owner for a document, so writing one requires an
 * explicit branch. Without this check a super admin's invoices silently
 * attached to the sentinel row and printed "All Branches" as their location.
 */
export function resolveBranchId(principal: Principal, requested?: number): number {
  if (!principal.isSuperAdmin) return principal.branchId;

  const branchId = requested ?? principal.branchId;

  if (branchId === SENTINEL_BRANCH) {
    throw badRequest(
      'Select a branch for this record. "All Branches" is a filter, not a location.',
    );
  }

  return branchId;
}
