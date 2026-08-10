import { db, withTransaction, type Executor } from '../../core/db/index.js';
import { config } from '../../core/config.js';
import { unauthorized } from '../../core/errors.js';
import { hashPassword, needsRehash, verifyPassword } from '../../core/auth/password.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  ttlToMs,
} from '../../core/auth/tokens.js';
import { Permissions, type Principal } from '../../core/rbac.js';
import { writeAudit } from '../../core/audit.js';
import type { UserLogin } from '../../core/db/types.js';

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: number;
    username: string;
    empId: number;
    branchId: number;
    branchName: string;
    roleId: number | null;
    isSuperAdmin: boolean;
    mustResetPassword: boolean;
  };
  permissions: ReturnType<Permissions['toJSON']>;
}

export interface ClientInfo {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

// ---------------------------------------------------------------------------
// Shared session construction
// ---------------------------------------------------------------------------

/**
 * Resolve the principal for a user row.
 *
 * Legacy behaviour preserved: `emp_id === 0` means super admin on branch 0
 * ("All"); otherwise the branch is read from the linked employee record. The
 * client never gets to choose its own branch.
 */
async function resolvePrincipal(
  user: UserLogin,
): Promise<{ principal: Principal; branchName: string }> {
  const isSuperAdmin = user.emp_id === 0;

  if (isSuperAdmin) {
    return {
      principal: {
        userId: user.id,
        username: user.username,
        empId: 0,
        branchId: 0,
        roleId: user.role_id,
        isSuperAdmin: true,
      },
      branchName: 'All',
    };
  }

  const emp = await db
    .selectFrom('employee')
    .select('branch_id')
    .where('id', '=', user.emp_id)
    .executeTakeFirst();

  if (!emp) throw unauthorized('Employee record not found for this login');

  const branch = await db
    .selectFrom('branch')
    .select('name')
    .where('id', '=', emp.branch_id)
    .executeTakeFirst();

  return {
    principal: {
      userId: user.id,
      username: user.username,
      empId: user.emp_id,
      branchId: emp.branch_id,
      roleId: user.role_id,
      isSuperAdmin: false,
    },
    branchName: branch?.name ?? '',
  };
}

/**
 * Issue an access token + a fresh refresh token for an authenticated user.
 * Used by both the password login and the refresh rotation so the two paths
 * cannot drift apart.
 */
async function issueSession(
  user: UserLogin,
  client: ClientInfo,
  executor: Executor = db,
): Promise<LoginResult> {
  const { principal, branchName } = await resolvePrincipal(user);
  const permissions = await Permissions.forPrincipal(principal);

  const accessToken = await signAccessToken({
    sub: String(principal.userId),
    username: principal.username,
    empId: principal.empId,
    branchId: principal.branchId,
    roleId: principal.roleId,
    isSuperAdmin: principal.isSuperAdmin,
  });

  const { token: refreshToken, hash } = generateRefreshToken();

  await executor
    .insertInto('refresh_token')
    .values({
      user_id: user.id,
      token_hash: hash,
      expires_at: new Date(Date.now() + ttlToMs(config.JWT_REFRESH_TTL)),
      user_agent: client.userAgent ?? null,
      ip: client.ip ?? null,
    })
    .execute();

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      empId: principal.empId,
      branchId: principal.branchId,
      branchName,
      roleId: principal.roleId,
      isSuperAdmin: principal.isSuperAdmin,
      // Users migrated from the legacy plaintext table have no usable hash.
      mustResetPassword: needsRehash(user.password_hash),
    },
    permissions: permissions.toJSON(),
  };
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

export async function login(
  username: string,
  password: string,
  client: ClientInfo,
): Promise<LoginResult> {
  const user = await db
    .selectFrom('user_logins')
    .selectAll()
    .where('username', '=', username.trim())
    .executeTakeFirst();

  // Always run a verify, even for a missing user, so a wrong username and a
  // wrong password cost the same time.
  const ok = await verifyPassword(user?.password_hash ?? '', password);

  if (!user || !ok) throw unauthorized('Invalid credentials');
  if (!user.is_active) throw unauthorized('This account is disabled');

  return withTransaction(async (tx) => {
    const result = await issueSession(user, client, tx);

    await tx
      .updateTable('user_logins')
      .set({ last_login_at: new Date() })
      .where('id', '=', user.id)
      .execute();

    const { principal } = await resolvePrincipal(user);
    await writeAudit(
      principal,
      { form: 'Auth', action: 'Login', detail: `User ${user.username} signed in` },
      tx,
    );

    return result;
  });
}

/**
 * Exchange a refresh token for a new pair.
 *
 * The presented token is revoked on use (rotation), and branch + permissions
 * are re-derived from the database rather than carried over from the old token.
 */
export async function refresh(rawToken: string, client: ClientInfo): Promise<LoginResult> {
  const hash = hashRefreshToken(rawToken);

  return withTransaction(async (tx) => {
    const stored = await tx
      .selectFrom('refresh_token')
      .selectAll()
      .where('token_hash', '=', hash)
      .forUpdate()
      .executeTakeFirst();

    if (!stored || stored.revoked_at || stored.expires_at < new Date()) {
      throw unauthorized('Invalid or expired refresh token');
    }

    await tx
      .updateTable('refresh_token')
      .set({ revoked_at: new Date() })
      .where('id', '=', stored.id)
      .execute();

    const user = await tx
      .selectFrom('user_logins')
      .selectAll()
      .where('id', '=', stored.user_id)
      .executeTakeFirst();

    if (!user) throw unauthorized('Account no longer exists');
    if (!user.is_active) throw unauthorized('This account is disabled');

    return issueSession(user, client, tx);
  });
}

export async function logout(rawToken: string): Promise<void> {
  await db
    .updateTable('refresh_token')
    .set({ revoked_at: new Date() })
    .where('token_hash', '=', hashRefreshToken(rawToken))
    .where('revoked_at', 'is', null)
    .execute();
}

export async function revokeAllSessions(userId: number): Promise<void> {
  await db
    .updateTable('refresh_token')
    .set({ revoked_at: new Date() })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
}

export async function changePassword(
  principal: Principal,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await db
    .selectFrom('user_logins')
    .select(['id', 'password_hash'])
    .where('id', '=', principal.userId)
    .executeTakeFirst();

  if (!user) throw unauthorized('Account no longer exists');

  // A user migrated from the legacy plaintext table has an empty hash and
  // reaches this through the forced-reset flow, with nothing to verify against.
  if (user.password_hash && !(await verifyPassword(user.password_hash, currentPassword))) {
    throw unauthorized('Current password is incorrect');
  }

  await db
    .updateTable('user_logins')
    .set({ password_hash: await hashPassword(newPassword), updated_at: new Date() })
    .where('id', '=', user.id)
    .execute();

  // Changing a password ends every other session.
  await revokeAllSessions(user.id);
}

/** Current user + permissions, for the client to rehydrate on page load. */
export async function me(principal: Principal): Promise<{
  user: Omit<LoginResult['user'], 'mustResetPassword'>;
  permissions: ReturnType<Permissions['toJSON']>;
}> {
  const branchName = principal.isSuperAdmin
    ? 'All'
    : ((
        await db
          .selectFrom('branch')
          .select('name')
          .where('id', '=', principal.branchId)
          .executeTakeFirst()
      )?.name ?? '');

  const permissions = await Permissions.forPrincipal(principal);

  return {
    user: {
      id: principal.userId,
      username: principal.username,
      empId: principal.empId,
      branchId: principal.branchId,
      branchName,
      roleId: principal.roleId,
      isSuperAdmin: principal.isSuperAdmin,
    },
    permissions: permissions.toJSON(),
  };
}
