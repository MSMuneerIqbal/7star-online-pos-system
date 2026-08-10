/**
 * Test environment.
 *
 * Order matters: `.env` is loaded FIRST, because dotenv never overrides an
 * already-set variable. Applying fallbacks before loading it would pin
 * DATABASE_URL to the placeholder and silently ignore the real one.
 */
import { config as loadEnv } from 'dotenv';

loadEnv();

process.env.NODE_ENV = 'test';
// Unconditional: `.env` sets LOG_LEVEL for development, and a `??=` here would
// let it through and drown the test output in request logs.
process.env.LOG_LEVEL = 'silent';
process.env.PORT ??= '0';
process.env.JWT_SECRET ??= 'test-only-secret-that-is-long-enough-to-pass-validation';

// Prefer a dedicated test database when one is configured.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Unit tests that never open a connection still need a syntactically valid URL.
process.env.DATABASE_URL ??= 'postgres://postgres:postgres@localhost:5432/sevenstar_pos_test';
