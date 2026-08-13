/**
 * Admin tests (Phase 2) — login history and the subset-of-own-grants rule.
 *
 * The subset rule is the new teeth on the permission matrix: a branch admin
 * must not be able to hand out a permission it does not itself hold, whether by
 * editing a role's grants directly or by assigning an over-privileged role to a
 * user.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { signAccessToken } from '../src/core/auth/tokens.js';
import { hashPassword } from '../src/core/auth/password.js';
import { closeDb, db } from '../src/core/db/index.js';
import { login } from '../src/modules/auth/service.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

/** A real branch id — roles and logins need a branch that actually exists. */
async function realBranchId(): Promise<number> {
  const b = await db.selectFrom('branch').select('id').where('id', '>', 0).executeTakeFirstOrThrow();
  return b.id;
}

describe('login history', () => {
  it('records a row on a successful sign-in', async () => {
    const branchId = await realBranchId();
    const username = `loginhist-${Date.now()}`;

    const employee = await db
      .insertInto('employee')
      .values({ first_name: 'Login History Test', branch_id: branchId })
      .returning('id')
      .executeTakeFirstOrThrow();

    const user = await db
      .insertInto('user_logins')
      .values({
        username,
        password_hash: await hashPassword('a-strong-password'),
        role_id: null,
        emp_id: employee.id,
        branch_id: branchId,
        is_active: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    try {
      const result = await login(username, 'a-strong-password', {
        ip: '203.0.113.7',
        userAgent: 'vitest',
      });

      expect(result.user.username).toBe(username);

      const row = await db
        .selectFrom('login_history')
        .select(['username', 'ip', 'user_agent'])
        .where('user_id', '=', user.id)
        .executeTakeFirst();

      expect(row?.username).toBe(username);
      expect(row?.ip).toBe('203.0.113.7');
      expect(row?.user_agent).toBe('vitest');
    } finally {
      await db.deleteFrom('login_history').where('user_id', '=', user.id).execute();
      await db.deleteFrom('refresh_token').where('user_id', '=', user.id).execute();
      await db.deleteFrom('user_logins').where('id', '=', user.id).execute();
      await db.deleteFrom('employee').where('id', '=', employee.id).execute();
    }
  });
});

describe('subset-of-own-grants', () => {
  it('rejects a branch admin granting a permission it does not hold', async () => {
    const branchId = await realBranchId();
    const suffix = Date.now();

    // The branch admin's own role: it may edit role assignment (15/8023), but
    // does NOT hold "view product" (6/2051).
    const adminRole = await db
      .insertInto('role')
      .values({ name: `Subset Admin ${suffix}`, branch_id: branchId })
      .returning('id')
      .executeTakeFirstOrThrow();

    const targetRole = await db
      .insertInto('role')
      .values({ name: `Subset Target ${suffix}`, branch_id: branchId })
      .returning('id')
      .executeTakeFirstOrThrow();

    await db
      .insertInto('role_assign')
      .values({
        role_id: adminRole.id,
        head_id: 8,
        form_id: 15,
        action_id: 8023,
        branch_id: branchId,
        created_by: 0,
        updated_by: 0,
      })
      .execute();

    try {
      const token = await signAccessToken({
        sub: '999999',
        username: 'branch-admin',
        empId: 999999,
        branchId,
        roleId: adminRole.id,
        isSuperAdmin: false,
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/roles/${targetRole.id}/permissions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          grants: [{ headId: 2, formId: 6, actionId: 2051 }],
        },
      });

      expect(res.statusCode).toBe(403);

      // Nothing was written — the target role still has no grants.
      const grants = await db
        .selectFrom('role_assign')
        .select('id')
        .where('role_id', '=', targetRole.id)
        .execute();
      expect(grants).toHaveLength(0);
    } finally {
      await db.deleteFrom('role_assign').where('role_id', 'in', [adminRole.id, targetRole.id]).execute();
      await db.deleteFrom('role').where('id', 'in', [adminRole.id, targetRole.id]).execute();
    }
  });

  it('lets a super admin grant anything', async () => {
    const branchId = await realBranchId();
    const suffix = Date.now();

    const targetRole = await db
      .insertInto('role')
      .values({ name: `Subset Super ${suffix}`, branch_id: branchId })
      .returning('id')
      .executeTakeFirstOrThrow();

    try {
      const token = await signAccessToken({
        sub: '0',
        username: 'super',
        empId: 0,
        branchId: 0,
        roleId: null,
        isSuperAdmin: true,
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/roles/${targetRole.id}/permissions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          grants: [{ headId: 2, formId: 6, actionId: 2051 }],
        },
      });

      expect(res.statusCode).toBe(200);

      const grants = await db
        .selectFrom('role_assign')
        .select(['form_id', 'action_id'])
        .where('role_id', '=', targetRole.id)
        .execute();
      expect(grants).toContainEqual({ form_id: 6, action_id: 2051 });
    } finally {
      await db.deleteFrom('role_assign').where('role_id', '=', targetRole.id).execute();
      await db.deleteFrom('role').where('id', '=', targetRole.id).execute();
    }
  });
});
