/**
 * Master catalog tests (Phase 1, the catalog split).
 *
 * Two guarantees this phase adds: the identity rule that keeps one model
 * from becoming two rows, and the super-admin-only guard on master writes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { signAccessToken } from '../src/core/auth/tokens.js';
import { closeDb, db } from '../src/core/db/index.js';
import { inRollback } from './helpers/rollback.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('idx_product_identity', () => {
  it('rejects a case-insensitive duplicate of model + brand + type + placement', async () => {
    await inRollback(async (tx) => {
      await tx
        .insertInto('product')
        .values({ name: 'Dell 5547', type: 'NEW', placement: 'INT' })
        .execute();

      await expect(
        tx
          .insertInto('product')
          .values({ name: 'DELL 5547', type: 'NEW', placement: 'INT' })
          .execute(),
      ).rejects.toThrow();
    });
  });

  it('allows the same model in a different type or placement', async () => {
    await inRollback(async (tx) => {
      await tx
        .insertInto('product')
        .values({ name: 'Dell 5547', type: 'NEW', placement: 'INT' })
        .execute();

      // Different placement — a genuinely different item, not a clash.
      await expect(
        tx
          .insertInto('product')
          .values({ name: 'Dell 5547', type: 'NEW', placement: 'EXT' })
          .execute(),
      ).resolves.not.toThrow();
    });
  });
});

describe('POST /api/v1/products — super-admin-only guard', () => {
  it('rejects a non-super-admin even with no role at all', async () => {
    const token = await signAccessToken({
      sub: '999999',
      username: 'branch-user',
      empId: 999999,
      branchId: 1,
      roleId: null,
      isSuperAdmin: false,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Test Product — should not be created' },
    });

    // Blocked either by RBAC (no grant) or the module's own super-admin
    // guard — both are 403, and either way nothing was written.
    expect(res.statusCode).toBe(403);

    const row = await db
      .selectFrom('product')
      .select('id')
      .where('name', 'ilike', 'Test Product — should not be created')
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('lets a super admin create a master catalog row', async () => {
    const token = await signAccessToken({
      sub: '0',
      username: 'super',
      empId: 0,
      branchId: 0,
      roleId: null,
      isSuperAdmin: true,
    });

    const name = `Test Product ${Date.now()}`;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { authorization: `Bearer ${token}` },
      payload: { name, type: 'NEW', placement: 'INT' },
    });

    try {
      expect(res.statusCode).toBe(201);
      expect(res.json().type).toBe('NEW');
    } finally {
      // Not run inside a rollback — a super admin's create really does
      // commit — so clean up what this test wrote.
      await db.deleteFrom('product').where('name', '=', name).execute();
    }
  });
});
