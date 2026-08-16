/**
 * Every screen is reachable, and no two screens share a permission.
 *
 * This file exists because of two failures that green tests could not see.
 *
 * The first: Warranty, E-Store and Excel import each shipped "complete" with a
 * passing service test and no interface at all — no nav entry, no route, no
 * page. A service test cannot tell you the screen is missing. What it CAN tell
 * you is whether the endpoints a screen depends on actually answer, which is
 * what the first block below checks. It is not a substitute for driving the app
 * by hand, but it is the part that can be automated, and it fails loudly the
 * day someone renames an endpoint out from under a page.
 *
 * The second: two different screens claimed one permission id, twice. Stock
 * Adjustment ended up authorising against E-Store's grant, and Opening Balances
 * against Account Registration's, so ticking one box opened a door nobody meant
 * to open. Both were found by reading migrations, which is not a durable way to
 * find anything. The second block makes the collision impossible to reintroduce
 * quietly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { buildApp } from '../src/app.js';
import { signAccessToken } from '../src/core/auth/tokens.js';
import { closeDb, db } from '../src/core/db/index.js';

let app: FastifyInstance;
let superToken: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  // A synthetic principal, minted directly. No real account is involved and no
  // password is used — the token is signed with the test JWT secret.
  superToken = await signAccessToken({
    sub: '0',
    username: 'test-super',
    empId: 0,
    branchId: 0,
    roleId: null,
    isSuperAdmin: true,
  });
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

/**
 * The read endpoints each new screen calls as it mounts. If any of these stops
 * answering, that page opens to an error — which is exactly how the three
 * missing screens went unnoticed.
 */
const SCREEN_ENDPOINTS: ReadonlyArray<{ screen: string; url: string }> = [
  { screen: 'Warranty', url: '/api/v1/warranty/form-data' },
  { screen: 'Warranty', url: '/api/v1/warranty/claims?page=1&pageSize=20' },
  { screen: 'E-Store', url: '/api/v1/estore/form-data' },
  { screen: 'E-Store', url: '/api/v1/estore?page=1&pageSize=20' },
  { screen: 'Stock Adjustment', url: '/api/v1/adjustments/form-data' },
  { screen: 'Opening Balances', url: '/api/v1/opening' },
];

describe('every screen can load', () => {
  for (const { screen, url } of SCREEN_ENDPOINTS) {
    it(`${screen}: ${url} answers for a super admin`, async () => {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${superToken}` },
      });

      // 404 would mean the route is not registered; 403 would mean the screen's
      // permission id does not resolve. Both are the failure modes this catches.
      expect(res.statusCode).toBe(200);
      expect(() => JSON.parse(res.body)).not.toThrow();
    });
  }

  it('Import rejects a non-super-admin, because raw items are master catalog', async () => {
    const branchToken = await signAccessToken({
      sub: '999999',
      username: 'branch-user',
      empId: 999999,
      branchId: 1,
      roleId: null,
      isSuperAdmin: false,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/import/raw-products/commit',
      headers: { authorization: `Bearer ${branchToken}` },
      payload: { rows: [] },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('no two screens share a permission', () => {
  it('every form_code is unique', async () => {
    // The check that would have caught both collisions on the day they landed.
    const dupes = await sql<{ form_code: number; forms: string }>`
      SELECT form_code, string_agg(form_name, ', ' ORDER BY id) AS forms
      FROM   form
      GROUP  BY form_code
      HAVING count(*) > 1
    `.execute(db);

    expect(
      dupes.rows.map((r) => `${r.form_code}: ${r.forms}`),
      'two screens are sharing one permission code',
    ).toEqual([]);
  });

  it('every action_code is unique', async () => {
    const dupes = await sql<{ action_code: number; n: number }>`
      SELECT action_code, count(*)::int AS n
      FROM   forms_action
      GROUP  BY action_code
      HAVING count(*) > 1
    `.execute(db);

    expect(dupes.rows.map((r) => r.action_code)).toEqual([]);
  });

  it('the screens added since the catalog split hold the ids they claim', async () => {
    // Pinned deliberately. These are the ids `web/src/lib/nav.ts` gates on, and
    // a silent renumber here would leave a menu item that opens nothing — or
    // worse, opens something else.
    const expected: ReadonlyArray<[id: number, name: string, code: number]> = [
      [53, 'My Prices', 1201],
      [54, 'Login History', 805],
      [55, 'Remittance', 511],
      [56, 'Expenses', 806],
      [57, 'Warranty', 512],
      [58, 'E-Store', 513],
      [59, 'Stock Adjustment', 1002],
      [60, 'Opening Balances', 714],
    ];

    const rows = await db
      .selectFrom('form')
      .select(['id', 'form_name', 'form_code'])
      .where('id', 'in', expected.map(([id]) => id))
      .orderBy('id')
      .execute();

    expect(rows.map((r) => [r.id, r.form_name, r.form_code])).toEqual(
      expected.map(([id, name, code]) => [id, name, code]),
    );
  });
});
