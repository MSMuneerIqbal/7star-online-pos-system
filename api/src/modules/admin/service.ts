/**
 * User management and settings — roles, the permission matrix, logins, the
 * audit trail, login history and the company profile.
 *
 * Legacy forms: 14 Roles (801), 15 Role Assignment (802), 16 User Logins (803),
 * 38 User Logs (804), 54 Login History (805), 37 Settings (901).
 *
 * Role Assignment is the important one: it edits the `role_assign` rows that
 * every permission check in the system reads, over the head → form → action tree
 * reconstructed in migration 1700000000003. The subset rules below are the
 * security boundary — "a branch admin creates salesmen inside its own branch and
 * grants them a subset of its own permissions, never more" (SPECS §2 rule 4).
 *
 * `routes.ts` owns the Zod schemas; the work is here. Every write takes an
 * optional trailing `tx` (PLAN ground rule 4a).
 */
import { db, inTransaction, type Tx } from '../../core/db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import {
  invalidateRoleCache,
  Permissions,
  resolveBranchId,
  type Principal,
} from '../../core/rbac.js';
import { hashPassword } from '../../core/auth/password.js';
import { likeTerm, offset, paged, type ListQuery } from '../../core/crud.js';

// ---------------------------------------------------------------------------
// The subset rules
//
// Two distinct checks, at two different times:
//  - `assertRoleWithinOwnGrants` runs at ASSIGNMENT time (handing a role to a
//    user), because a role's grants are not transitively bounded by whoever
//    last edited them — a role edited by a super admin, later assigned by a
//    branch admin, could still exceed that branch admin's own grants.
//  - `assertGrantsWithinOwnGrants` runs at EDIT time, before a role's grant set
//    is replaced.
// ---------------------------------------------------------------------------

/** Reject any permission in the role the acting principal does not itself hold. */
export async function assertRoleWithinOwnGrants(
  principal: Principal,
  roleId: number,
  executor = db,
): Promise<void> {
  if (principal.isSuperAdmin) return;

  const own = await Permissions.forPrincipal(principal);

  const grants = await executor
    .selectFrom('role_assign')
    .select(['form_id', 'action_id'])
    .where('role_id', '=', roleId)
    .execute();

  for (const g of grants) {
    if (!own.hasAction(g.form_id, g.action_id)) {
      throw forbidden(
        `This role includes permission ${g.form_id}/${g.action_id}, which you do not hold yourself`,
      );
    }
  }
}

/** Reject any requested grant the acting principal does not itself hold. */
export async function assertGrantsWithinOwnGrants(
  principal: Principal,
  grants: readonly { formId: number; actionId: number }[],
): Promise<void> {
  if (principal.isSuperAdmin) return;

  const own = await Permissions.forPrincipal(principal);

  for (const g of grants) {
    if (!own.hasAction(g.formId, g.actionId)) {
      throw forbidden(
        `You cannot grant permission ${g.formId}/${g.actionId} — you do not hold it yourself`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export async function listRoles(principal: Principal) {
  let q = db
    .selectFrom('role')
    .leftJoin('branch', 'branch.id', 'role.branch_id')
    .select(['role.id', 'role.name', 'role.branch_id', 'branch.name as branch_name']);

  if (!principal.isSuperAdmin) {
    q = q
      .where('role.branch_id', '=', principal.branchId)
      // A branch admin sees its own roles plus anything the super admin set up
      // for its branch — not other branch admins' private roles.
      .where((eb) =>
        eb.or([eb('role.created_by', '=', principal.empId), eb('role.created_by', '=', 0)]),
      );
  }

  return q.orderBy('role.name').execute();
}

export async function createRole(
  principal: Principal,
  input: { name: string; branchId?: number | undefined },
  outerTx?: Tx,
) {
  const branchId = resolveBranchId(principal, input.branchId);

  const clash = await (outerTx ?? db)
    .selectFrom('role')
    .select('id')
    .where('name', 'ilike', input.name)
    .where('branch_id', '=', branchId)
    .executeTakeFirst();

  if (clash) throw conflict(`A role named "${input.name}" already exists for this branch`);

  return inTransaction(outerTx, async (tx) => {
    const created = await tx
      .insertInto('role')
      .values({
        name: input.name,
        branch_id: branchId,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAudit(
      principal,
      { form: 'User Roles', action: 'New', detail: `Created role: ${created.name}`, invId: created.id },
      tx,
    );

    return created;
  });
}

export async function deleteRole(principal: Principal, id: number, outerTx?: Tx): Promise<void> {
  const executor = outerTx ?? db;

  const role = await executor
    .selectFrom('role')
    .select(['id', 'name'])
    .where('id', '=', id)
    .executeTakeFirst();

  if (!role) throw notFound('Role');

  // Refuse while users still depend on it — deleting would silently strip their
  // permissions.
  const inUse = await executor
    .selectFrom('user_logins')
    .select(({ fn }) => fn.countAll<string>().as('n'))
    .where('role_id', '=', id)
    .executeTakeFirstOrThrow();

  if (Number(inUse.n) > 0) throw conflict(`${inUse.n} user login(s) still use this role`);

  await inTransaction(outerTx, async (tx) => {
    await tx.deleteFrom('role_assign').where('role_id', '=', id).execute();
    await tx.deleteFrom('role').where('id', '=', id).execute();

    await writeAudit(
      principal,
      { form: 'User Roles', action: 'Delete', detail: `Deleted role: ${role.name}`, invId: id },
      tx,
    );
  });

  invalidateRoleCache(id);
}

// ---------------------------------------------------------------------------
// Role assignment — the permission matrix
// ---------------------------------------------------------------------------

/** The full head → form → action tree, for rendering the matrix. */
export async function permissionTree() {
  const [heads, forms, actions] = await Promise.all([
    db.selectFrom('form_head').selectAll().orderBy('sr').execute(),
    db.selectFrom('form').selectAll().orderBy('sr').execute(),
    db.selectFrom('forms_action').selectAll().orderBy('form_id').orderBy('sr').execute(),
  ]);

  return { heads, forms, actions };
}

export async function roleGrants(roleId: number) {
  return db
    .selectFrom('role_assign')
    .select(['head_id', 'form_id', 'action_id'])
    .where('role_id', '=', roleId)
    .execute();
}

export interface Grant {
  headId: number;
  formId: number;
  actionId: number;
}

/**
 * Replace a role's entire permission set.
 *
 * Whole-set replacement rather than add/remove deltas: the matrix is edited as a
 * unit, and a partial update would leave a half-applied grant if the request
 * failed midway.
 */
export async function setRoleGrants(
  principal: Principal,
  roleId: number,
  grants: readonly Grant[],
  outerTx?: Tx,
): Promise<{ roleId: number; granted: number }> {
  const executor = outerTx ?? db;

  const role = await executor
    .selectFrom('role')
    .select(['id', 'name', 'branch_id'])
    .where('id', '=', roleId)
    .executeTakeFirst();

  if (!role) throw notFound('Role');

  // Reject any grant that does not exist in the tree — a typo would otherwise
  // create a permission nothing ever checks.
  if (grants.length > 0) {
    const known = await executor
      .selectFrom('forms_action')
      .select(['form_id', 'action_code'])
      .execute();

    const valid = new Set(known.map((k) => `${k.form_id}:${k.action_code}`));
    const unknown = grants.filter((g) => !valid.has(`${g.formId}:${g.actionId}`));

    if (unknown.length > 0) {
      throw badRequest(
        `Unknown permission(s): ${unknown.map((u) => `${u.formId}/${u.actionId}`).join(', ')}`,
      );
    }
  }

  // A branch admin can only hand out what it already holds.
  await assertGrantsWithinOwnGrants(principal, grants);

  await inTransaction(outerTx, async (tx) => {
    await tx.deleteFrom('role_assign').where('role_id', '=', roleId).execute();

    if (grants.length > 0) {
      await tx
        .insertInto('role_assign')
        .values(
          grants.map((g) => ({
            role_id: roleId,
            head_id: g.headId,
            form_id: g.formId,
            action_id: g.actionId,
            branch_id: role.branch_id,
            created_by: principal.empId,
            updated_by: principal.empId,
          })),
        )
        .execute();
    }

    await writeAudit(
      principal,
      {
        form: 'Role Assignment',
        action: 'Edit',
        detail: `Set ${grants.length} permission(s) for role ${role.name}`,
        invId: roleId,
      },
      tx,
    );
  });

  // Permissions are cached for 60s; drop this role's entry immediately so the
  // change takes effect on the next request.
  invalidateRoleCache(roleId);

  return { roleId, granted: grants.length };
}

// ---------------------------------------------------------------------------
// User logins
// ---------------------------------------------------------------------------

export async function listLogins(principal: Principal, q: ListQuery) {
  let base = db
    .selectFrom('user_logins')
    .leftJoin('role', 'role.id', 'user_logins.role_id')
    .leftJoin('employee', 'employee.id', 'user_logins.emp_id');

  if (!principal.isSuperAdmin) {
    base = base
      .where('user_logins.branch_id', '=', principal.branchId)
      // Same ownership rule as roles: own logins plus super-admin-created ones,
      // not another branch admin's.
      .where((eb) =>
        eb.or([
          eb('user_logins.created_by', '=', principal.empId),
          eb('user_logins.created_by', '=', 0),
        ]),
      );
  }

  const term = likeTerm(q.search);
  if (term) base = base.where('user_logins.username', 'ilike', term);

  const [rows, count] = await Promise.all([
    base
      .select([
        'user_logins.id',
        'user_logins.username',
        'user_logins.emp_id',
        'user_logins.branch_id',
        'user_logins.is_active',
        'user_logins.last_login_at',
        'role.name as role_name',
        'employee.first_name as employee_name',
      ])
      .orderBy('user_logins.username')
      .limit(q.pageSize)
      .offset(offset(q))
      .execute(),
    base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
  ]);

  return paged(rows, Number(count.n), q);
}

export interface CreateLoginInput {
  username: string;
  password: string;
  roleId: number;
  empId: number;
  branchId?: number | undefined;
}

export async function createLogin(principal: Principal, input: CreateLoginInput, outerTx?: Tx) {
  const executor = outerTx ?? db;

  const clash = await executor
    .selectFrom('user_logins')
    .select('id')
    .where('username', 'ilike', input.username)
    .executeTakeFirst();

  if (clash) throw conflict(`Username "${input.username}" is taken`);

  const employee = await executor
    .selectFrom('employee')
    .select(['id', 'branch_id'])
    .where('id', '=', input.empId)
    .executeTakeFirst();

  if (!employee) throw badRequest(`Unknown employee id ${input.empId}`);

  // A branch admin cannot hand a role whose powers exceed its own.
  await assertRoleWithinOwnGrants(principal, input.roleId, executor);

  return inTransaction(outerTx, async (tx) => {
    const created = await tx
      .insertInto('user_logins')
      .values({
        username: input.username,
        password_hash: await hashPassword(input.password),
        role_id: input.roleId,
        // A login's branch always follows its employee — never the request.
        emp_id: input.empId,
        branch_id: employee.branch_id,
        is_active: true,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returning(['id', 'username'])
      .executeTakeFirstOrThrow();

    await writeAudit(
      principal,
      {
        form: 'User Logins',
        action: 'New',
        detail: `Created login ${created.username} for employee ${input.empId}`,
        invId: created.id,
      },
      tx,
    );

    return created;
  });
}

export interface UpdateLoginInput {
  roleId?: number | undefined;
  isActive?: boolean | undefined;
  /** Optional reset; omitted leaves the existing hash alone. */
  password?: string | undefined;
  /** Reassign the person across branches. Super-admin only. */
  branchId?: number | undefined;
}

export async function updateLogin(
  principal: Principal,
  id: number,
  input: UpdateLoginInput,
  outerTx?: Tx,
) {
  const executor = outerTx ?? db;

  const user = await executor
    .selectFrom('user_logins')
    .select(['id', 'username', 'emp_id'])
    .where('id', '=', id)
    .executeTakeFirst();

  if (!user) throw notFound('User login');

  // A super admin's own account cannot be disabled through this screen — that
  // is how you lock everyone out of the system.
  if (user.emp_id === 0 && input.isActive === false) {
    throw conflict('A super admin login cannot be disabled here');
  }

  // Reassigning a person across branches is the super admin's power alone.
  if (input.branchId !== undefined) {
    if (!principal.isSuperAdmin) {
      throw forbidden('Only the super admin can reassign a login to another branch');
    }
    if (user.emp_id === 0) {
      throw conflict('The super admin account does not belong to a branch');
    }
  }

  // Handing a role to a user is subject to the same subset rule as editing one.
  if (input.roleId !== undefined) {
    await assertRoleWithinOwnGrants(principal, input.roleId, executor);
  }

  return inTransaction(outerTx, async (tx) => {
    const updated = await tx
      .updateTable('user_logins')
      .set({
        ...(input.roleId !== undefined ? { role_id: input.roleId } : {}),
        ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
        ...(input.branchId !== undefined ? { branch_id: input.branchId } : {}),
        ...(input.password !== undefined
          ? { password_hash: await hashPassword(input.password) }
          : {}),
        updated_at: new Date(),
        updated_by: principal.empId,
      })
      .where('id', '=', id)
      .returning(['id', 'username', 'is_active'])
      .executeTakeFirstOrThrow();

    // employee.branch_id is what resolvePrincipal actually reads for access
    // control — writing only user_logins.branch_id would be a silent no-op.
    if (input.branchId !== undefined) {
      await tx
        .updateTable('employee')
        .set({ branch_id: input.branchId, updated_at: new Date() })
        .where('id', '=', user.emp_id)
        .execute();
    }

    const changes = [
      input.roleId !== undefined && 'role',
      input.isActive !== undefined && `status=${input.isActive ? 'active' : 'disabled'}`,
      input.branchId !== undefined && `branch=${input.branchId}`,
      input.password !== undefined && 'password reset',
    ].filter(Boolean);

    await writeAudit(
      principal,
      {
        form: 'User Logins',
        action: 'Edit',
        detail: `Updated login ${updated.username}: ${changes.join(', ')}`,
        invId: id,
      },
      tx,
    );

    return updated;
  });
}

// ---------------------------------------------------------------------------
// User logs — read-only audit trail
// ---------------------------------------------------------------------------

export interface LogFilters {
  form?: string | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export async function listLogs(principal: Principal, q: ListQuery, filters: LogFilters) {
  let base = db.selectFrom('user_log');

  if (!principal.isSuperAdmin) base = base.where('branch_id', '=', principal.branchId);

  if (filters.form) base = base.where('form', '=', filters.form);
  if (filters.action) base = base.where('action', '=', filters.action);
  if (filters.from) base = base.where('datetime', '>=', new Date(filters.from));
  // Inclusive of the whole end day.
  if (filters.to) base = base.where('datetime', '<', new Date(`${filters.to}T23:59:59.999Z`));

  const term = likeTerm(q.search);
  if (term) base = base.where('detail', 'ilike', term);

  const [rows, count] = await Promise.all([
    base
      .select(['id', 'datetime', 'username', 'form', 'action', 'detail', 'inv_id', 'branch_id'])
      .orderBy('id', 'desc')
      .limit(q.pageSize)
      .offset(offset(q))
      .execute(),
    base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
  ]);

  return paged(rows, Number(count.n), q);
}

/** Distinct form names, for the log filter dropdown. */
export async function logFormNames() {
  const rows = await db
    .selectFrom('user_log')
    .select('form')
    .distinct()
    .where('form', 'is not', null)
    .orderBy('form')
    .execute();

  return rows.map((r) => r.form).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Login history — who signed in, when, from where
// ---------------------------------------------------------------------------

export async function listLoginHistory(principal: Principal, q: ListQuery) {
  let base = db.selectFrom('login_history').leftJoin('branch', 'branch.id', 'login_history.branch_id');

  if (!principal.isSuperAdmin) {
    base = base.where('login_history.branch_id', '=', principal.branchId);
  }

  const term = likeTerm(q.search);
  if (term) base = base.where('login_history.username', 'ilike', term);

  const [rows, count] = await Promise.all([
    base
      .select([
        'login_history.id',
        'login_history.at',
        'login_history.username',
        'login_history.ip',
        'login_history.user_agent',
        'branch.name as branch_name',
      ])
      .orderBy('login_history.id', 'desc')
      .limit(q.pageSize)
      .offset(offset(q))
      .execute(),
    base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
  ]);

  return paged(rows, Number(count.n), q);
}

// ---------------------------------------------------------------------------
// Company settings — a single row
// ---------------------------------------------------------------------------

export async function getSettings() {
  const row = await db.selectFrom('setting').selectAll().orderBy('id').executeTakeFirst();

  return (
    row ?? {
      id: 0,
      name: null,
      phone: null,
      address: null,
      email: null,
      image: null,
      delivery_charges: '0.00',
    }
  );
}

export interface SettingsInput {
  name?: string | null | undefined;
  phone?: string | null | undefined;
  address?: string | null | undefined;
  email?: string | null | undefined;
  deliveryCharges: string;
}

export async function updateSettings(principal: Principal, input: SettingsInput, outerTx?: Tx) {
  return inTransaction(outerTx, async (tx) => {
    const existing = await tx.selectFrom('setting').select('id').orderBy('id').executeTakeFirst();

    const values = {
      name: input.name ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
      email: input.email ?? null,
      delivery_charges: input.deliveryCharges,
    };

    const row = existing
      ? await tx
          .updateTable('setting')
          .set(values)
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await tx.insertInto('setting').values(values).returningAll().executeTakeFirstOrThrow();

    await writeAudit(
      principal,
      { form: 'Setting', action: 'Edit', detail: 'Updated company profile', invId: row.id },
      tx,
    );

    return row;
  });
}
