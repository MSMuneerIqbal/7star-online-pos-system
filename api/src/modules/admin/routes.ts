/**
 * User management and settings — phase 10.
 *
 * Legacy forms: 14 Roles (801), 15 Role Assignment (802), 16 User Logins (803),
 * 38 User Logs (804), 37 Settings (901).
 *
 * Role Assignment is the important one: it edits the `role_assign` rows that
 * every permission check in the system reads, over the head → form → action
 * tree reconstructed in migration 1700000000003.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, withTransaction } from '../../core/db/index.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { invalidateRoleCache, resolveBranchId } from '../../core/rbac.js';
import { hashPassword } from '../../core/auth/password.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';

const ROLES = formPermissions(14, 801);
const ROLE_ASSIGN = formPermissions(15, 802);
const LOGINS = formPermissions(16, 803);
const LOGS = formPermissions(38, 804);
const SETTINGS = formPermissions(37, 901);

const idParam = z.object({ id: z.coerce.number().int().positive() });

export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------

  app.get('/roles', {
    preHandler: app.requireAction(ROLES.formId, ROLES.view),
    handler: async (req) => {
      let q = db
        .selectFrom('role')
        .leftJoin('branch', 'branch.id', 'role.branch_id')
        .select(['role.id', 'role.name', 'role.branch_id', 'branch.name as branch_name']);

      if (!req.principal.isSuperAdmin) {
        q = q.where('role.branch_id', '=', req.principal.branchId);
      }

      return q.orderBy('role.name').execute();
    },
  });

  app.post('/roles', {
    preHandler: app.requireAction(ROLES.formId, ROLES.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1, 'Name is required').max(150),
          branchId: z.coerce.number().int().optional(),
        })
        .parse(req.body);

      const branchId = resolveBranchId(req.principal, body.branchId);

      const clash = await db
        .selectFrom('role')
        .select('id')
        .where('name', 'ilike', body.name)
        .where('branch_id', '=', branchId)
        .executeTakeFirst();

      if (clash) throw conflict(`A role named "${body.name}" already exists for this branch`);

      const row = await withTransaction(async (tx) => {
        const created = await tx
          .insertInto('role')
          .values({
            name: body.name,
            branch_id: branchId,
            created_by: req.principal.empId,
            updated_by: req.principal.empId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          req.principal,
          {
            form: 'User Roles',
            action: 'New',
            detail: `Created role: ${created.name}`,
            invId: created.id,
          },
          tx,
        );

        return created;
      });

      return reply.status(201).send(row);
    },
  });

  app.delete('/roles/:id', {
    preHandler: app.requireAction(ROLES.formId, ROLES.remove),
    handler: async (req, reply) => {
      const { id } = idParam.parse(req.params);

      const role = await db
        .selectFrom('role')
        .select(['id', 'name'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!role) throw notFound('Role');

      // Refuse while users still depend on it — deleting would silently strip
      // their permissions.
      const inUse = await db
        .selectFrom('user_logins')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .where('role_id', '=', id)
        .executeTakeFirstOrThrow();

      if (Number(inUse.n) > 0) {
        throw conflict(`${inUse.n} user login(s) still use this role`);
      }

      await withTransaction(async (tx) => {
        await tx.deleteFrom('role_assign').where('role_id', '=', id).execute();
        await tx.deleteFrom('role').where('id', '=', id).execute();

        await writeAudit(
          req.principal,
          {
            form: 'User Roles',
            action: 'Delete',
            detail: `Deleted role: ${role.name}`,
            invId: id,
          },
          tx,
        );
      });

      invalidateRoleCache(id);
      return reply.status(204).send();
    },
  });

  // -------------------------------------------------------------------------
  // Role assignment — the permission matrix
  // -------------------------------------------------------------------------

  /** The full head → form → action tree, for rendering the matrix. */
  app.get('/permission-tree', {
    preHandler: app.requireAction(ROLE_ASSIGN.formId, ROLE_ASSIGN.view),
    handler: async () => {
      const [heads, forms, actions] = await Promise.all([
        db.selectFrom('form_head').selectAll().orderBy('sr').execute(),
        db.selectFrom('form').selectAll().orderBy('sr').execute(),
        db.selectFrom('forms_action').selectAll().orderBy('form_id').orderBy('sr').execute(),
      ]);

      return {
        heads,
        forms,
        actions,
      };
    },
  });

  app.get('/roles/:id/permissions', {
    preHandler: app.requireAction(ROLE_ASSIGN.formId, ROLE_ASSIGN.view),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);

      return db
        .selectFrom('role_assign')
        .select(['head_id', 'form_id', 'action_id'])
        .where('role_id', '=', id)
        .execute();
    },
  });

  /**
   * Replace a role's entire permission set.
   *
   * Whole-set replacement rather than add/remove deltas: the matrix is edited
   * as a unit, and a partial update would leave a half-applied grant if the
   * request failed midway.
   */
  app.put('/roles/:id/permissions', {
    preHandler: app.requireAction(ROLE_ASSIGN.formId, ROLE_ASSIGN.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);

      const body = z
        .object({
          grants: z.array(
            z.object({
              headId: z.coerce.number().int().positive(),
              formId: z.coerce.number().int().positive(),
              actionId: z.coerce.number().int().positive(),
            }),
          ),
        })
        .parse(req.body);

      const role = await db
        .selectFrom('role')
        .select(['id', 'name', 'branch_id'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!role) throw notFound('Role');

      // Reject any grant that does not exist in the tree — a typo would
      // otherwise create a permission nothing ever checks.
      if (body.grants.length > 0) {
        const known = await db
          .selectFrom('forms_action')
          .select(['form_id', 'action_code'])
          .execute();

        const valid = new Set(known.map((k) => `${k.form_id}:${k.action_code}`));
        const unknown = body.grants.filter((g) => !valid.has(`${g.formId}:${g.actionId}`));

        if (unknown.length > 0) {
          throw badRequest(
            `Unknown permission(s): ${unknown.map((u) => `${u.formId}/${u.actionId}`).join(', ')}`,
          );
        }
      }

      await withTransaction(async (tx) => {
        await tx.deleteFrom('role_assign').where('role_id', '=', id).execute();

        if (body.grants.length > 0) {
          await tx
            .insertInto('role_assign')
            .values(
              body.grants.map((g) => ({
                role_id: id,
                head_id: g.headId,
                form_id: g.formId,
                action_id: g.actionId,
                branch_id: role.branch_id,
                created_by: req.principal.empId,
                updated_by: req.principal.empId,
              })),
            )
            .execute();
        }

        await writeAudit(
          req.principal,
          {
            form: 'Role Assignment',
            action: 'Edit',
            detail: `Set ${body.grants.length} permission(s) for role ${role.name}`,
            invId: id,
          },
          tx,
        );
      });

      // Permissions are cached for 60s; drop this role's entry immediately so
      // the change takes effect on the next request.
      invalidateRoleCache(id);

      return { roleId: id, granted: body.grants.length };
    },
  });

  // -------------------------------------------------------------------------
  // User logins
  // -------------------------------------------------------------------------

  app.get('/logins', {
    preHandler: app.requireAction(LOGINS.formId, LOGINS.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);

      let base = db
        .selectFrom('user_logins')
        .leftJoin('role', 'role.id', 'user_logins.role_id')
        .leftJoin('employee', 'employee.id', 'user_logins.emp_id');

      if (!req.principal.isSuperAdmin) {
        base = base.where('user_logins.branch_id', '=', req.principal.branchId);
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
    },
  });

  app.post('/logins', {
    preHandler: app.requireAction(LOGINS.formId, LOGINS.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          username: z.string().trim().min(3, 'Username must be at least 3 characters').max(100),
          password: z.string().min(10, 'Password must be at least 10 characters').max(200),
          roleId: z.coerce.number().int().positive(),
          empId: z.coerce.number().int().positive(),
          branchId: z.coerce.number().int().optional(),
        })
        .parse(req.body);

      const clash = await db
        .selectFrom('user_logins')
        .select('id')
        .where('username', 'ilike', body.username)
        .executeTakeFirst();

      if (clash) throw conflict(`Username "${body.username}" is taken`);

      const employee = await db
        .selectFrom('employee')
        .select(['id', 'branch_id'])
        .where('id', '=', body.empId)
        .executeTakeFirst();

      if (!employee) throw badRequest(`Unknown employee id ${body.empId}`);

      const row = await withTransaction(async (tx) => {
        const created = await tx
          .insertInto('user_logins')
          .values({
            username: body.username,
            password_hash: await hashPassword(body.password),
            role_id: body.roleId,
            // A login's branch always follows its employee — never the request.
            emp_id: body.empId,
            branch_id: employee.branch_id,
            is_active: true,
            created_by: req.principal.empId,
            updated_by: req.principal.empId,
          })
          .returning(['id', 'username'])
          .executeTakeFirstOrThrow();

        await writeAudit(
          req.principal,
          {
            form: 'User Logins',
            action: 'New',
            detail: `Created login ${created.username} for employee ${body.empId}`,
            invId: created.id,
          },
          tx,
        );

        return created;
      });

      return reply.status(201).send(row);
    },
  });

  app.put('/logins/:id', {
    preHandler: app.requireAction(LOGINS.formId, LOGINS.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);

      const body = z
        .object({
          roleId: z.coerce.number().int().positive().optional(),
          isActive: z.boolean().optional(),
          /** Optional reset; omitted leaves the existing hash alone. */
          password: z.string().min(10).max(200).optional(),
        })
        .parse(req.body);

      const user = await db
        .selectFrom('user_logins')
        .select(['id', 'username', 'emp_id'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!user) throw notFound('User login');

      // A super admin's own account cannot be disabled through this screen —
      // that is how you lock everyone out of the system.
      if (user.emp_id === 0 && body.isActive === false) {
        throw conflict('A super admin login cannot be disabled here');
      }

      return withTransaction(async (tx) => {
        const updated = await tx
          .updateTable('user_logins')
          .set({
            ...(body.roleId !== undefined ? { role_id: body.roleId } : {}),
            ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
            ...(body.password !== undefined
              ? { password_hash: await hashPassword(body.password) }
              : {}),
            updated_at: new Date(),
            updated_by: req.principal.empId,
          })
          .where('id', '=', id)
          .returning(['id', 'username', 'is_active'])
          .executeTakeFirstOrThrow();

        const changes = [
          body.roleId !== undefined && 'role',
          body.isActive !== undefined && `status=${body.isActive ? 'active' : 'disabled'}`,
          body.password !== undefined && 'password reset',
        ].filter(Boolean);

        await writeAudit(
          req.principal,
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
    },
  });

  // -------------------------------------------------------------------------
  // User logs — read-only audit trail
  // -------------------------------------------------------------------------

  app.get('/logs', {
    preHandler: app.requireAction(LOGS.formId, LOGS.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);
      const filters = z
        .object({
          form: z.string().max(100).optional(),
          action: z.string().max(50).optional(),
          from: z.string().optional(),
          to: z.string().optional(),
        })
        .parse(req.query);

      let base = db.selectFrom('user_log');

      if (!req.principal.isSuperAdmin) {
        base = base.where('branch_id', '=', req.principal.branchId);
      }

      if (filters.form) base = base.where('form', '=', filters.form);
      if (filters.action) base = base.where('action', '=', filters.action);
      if (filters.from) base = base.where('datetime', '>=', new Date(filters.from));
      if (filters.to) {
        // Inclusive of the whole end day.
        base = base.where('datetime', '<', new Date(`${filters.to}T23:59:59.999Z`));
      }

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
    },
  });

  /** Distinct form names, for the log filter dropdown. */
  app.get('/logs/forms', {
    preHandler: app.requireAction(LOGS.formId, LOGS.view),
    handler: async () => {
      const rows = await db
        .selectFrom('user_log')
        .select('form')
        .distinct()
        .where('form', 'is not', null)
        .orderBy('form')
        .execute();

      return rows.map((r) => r.form).filter(Boolean);
    },
  });

  // -------------------------------------------------------------------------
  // Company settings — a single row
  // -------------------------------------------------------------------------

  app.get('/settings', {
    preHandler: app.requireAction(SETTINGS.formId, SETTINGS.view),
    handler: async () => {
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
    },
  });

  app.put('/settings', {
    preHandler: app.requireAction(SETTINGS.formId, SETTINGS.edit),
    handler: async (req) => {
      const body = z
        .object({
          name: z.string().trim().max(150).nullish(),
          phone: z.string().trim().max(50).nullish(),
          address: z.string().trim().max(500).nullish(),
          email: z.string().trim().max(150).nullish(),
          deliveryCharges: z.union([z.string(), z.number()]).transform(String).default('0'),
        })
        .parse(req.body);

      return withTransaction(async (tx) => {
        const existing = await tx.selectFrom('setting').select('id').orderBy('id').executeTakeFirst();

        const values = {
          name: body.name ?? null,
          phone: body.phone ?? null,
          address: body.address ?? null,
          email: body.email ?? null,
          delivery_charges: body.deliveryCharges,
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
          req.principal,
          { form: 'Setting', action: 'Edit', detail: `Updated company profile`, invId: row.id },
          tx,
        );

        return row;
      });
    },
  });
}
