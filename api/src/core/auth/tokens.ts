import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import { unauthorized } from '../errors.js';

const secret = new TextEncoder().encode(config.JWT_SECRET);
const ISSUER = '7star-pos';
const AUDIENCE = '7star-pos-web';

/**
 * The access-token claims.
 *
 * Deliberately NOT carrying the role-assignment list. The legacy system packed
 * the whole permission set into a cookie claim (`RoleAccessList`), so a
 * permission change only took effect after re-login and the cookie grew with
 * the role. Permissions are loaded per-request from the DB instead (cached).
 */
// Deliberately NOT extending jose's JWTPayload: its `[propName: string]: unknown`
// index signature swallows every named field, which makes Omit<> and excess
// property checks useless.
export interface AccessClaims {
  sub: string;
  username: string;
  empId: number;
  branchId: number;
  roleId: number | null;
  isSuperAdmin: boolean;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.sub)
    .setExpirationTime(config.JWT_ACCESS_TTL)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return payload as unknown as AccessClaims;
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}

/**
 * Refresh tokens are opaque random strings. Only their SHA-256 is stored, so a
 * database leak does not yield usable tokens.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Parse a duration like "7d" / "15m" into milliseconds. */
export function ttlToMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) throw new Error(`Invalid TTL: ${ttl}`);

  const value = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const factor = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];

  return value * factor;
}
