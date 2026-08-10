import argon2 from 'argon2';

/**
 * OWASP-recommended argon2id parameters (19 MiB, 2 iterations, parallelism 1).
 *
 * The legacy system compared passwords with `e.Password == login.Password`
 * against a plaintext column. Migrated users therefore have NO usable hash —
 * the ETL imports them with `password_hash = ''` and a forced reset.
 */
const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  // An empty hash means "migrated from legacy, never set" — always reject, but
  // still burn comparable time so it isn't distinguishable by timing.
  if (!hash) {
    await argon2.hash(plain, OPTIONS);
    return false;
  }

  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/** True when the stored hash predates argon2 and should be upgraded on next login. */
export function needsRehash(hash: string): boolean {
  return !hash.startsWith('$argon2id$');
}
