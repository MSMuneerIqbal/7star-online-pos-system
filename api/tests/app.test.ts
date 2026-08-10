import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

/**
 * Wiring tests: routing, auth gating, validation and error shape.
 * These deliberately do NOT need a database — anything that would hit Postgres
 * is asserted only up to the point where auth or validation rejects it.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('health', () => {
  it('responds, reporting db state', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    // 200 with a database, 503 without one. Both mean the app booted.
    expect([200, 503]).toContain(res.statusCode);

    const body = res.json();
    expect(body).toHaveProperty('db');
    expect(body).toHaveProperty('uptime');
  });
});

describe('error handling', () => {
  it('returns a structured 404 with a request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.json().error.requestId).toBeTruthy();
  });
});

describe('auth gating', () => {
  it('rejects /me without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a malformed bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: 'Bearer not-a-jwt' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    // A structurally valid JWT with a different signature must not be accepted.
    const forged =
      'eyJhbGciOiJIUzI1NiJ9.' +
      Buffer.from(JSON.stringify({ sub: '1', isSuperAdmin: true })).toString('base64url') +
      '.bm90LWEtdmFsaWQtc2lnbmF0dXJl';

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects refresh with no cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh' });
    expect(res.statusCode).toBe(401);
  });
});

describe('validation', () => {
  it('rejects a login missing its password with field detail', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'someone' },
    });

    expect(res.statusCode).toBe(400);

    const { error } = res.json();
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'password' })]),
    );
  });

  it('rejects an empty username', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: '', password: 'whatever' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('logout', () => {
  it('succeeds without a session rather than erroring', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
