/**
 * Notifications — the top-bar bell.
 *
 * A lightweight event feed for stock exchanges. Every demand order, dispatch,
 * receipt and remittance drops one row here so the receiving side sees it
 * without polling the underlying tables. A branch reads only its own feed; the
 * super admin reads everything.
 */
import { db, withTransaction, type Tx } from '../../core/db/index.js';
import { assertBranchAccess, type Principal } from '../../core/rbac.js';
import { notFound } from '../../core/errors.js';

export interface NotificationInput {
  type?: string;
  title: string;
  body?: string | null;
  link?: string | null;
}

/** Insert one notification, targeted at a branch. Safe to call inside a tx. */
export async function notify(
  executor: Tx | typeof db,
  branchId: number,
  input: NotificationInput,
): Promise<void> {
  await executor
    .insertInto('notification')
    .values({
      branch_id: branchId,
      type: input.type ?? 'DEMAND',
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    })
    .execute();
}

export interface NotificationRow {
  id: number;
  branch_id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  is_read: boolean;
  created_at: Date;
}

export async function listNotifications(principal: Principal): Promise<NotificationRow[]> {
  let base = db.selectFrom('notification');

  if (!principal.isSuperAdmin) {
    base = base.where('branch_id', '=', principal.branchId);
  }

  return base
    .select(['id', 'branch_id', 'type', 'title', 'body', 'link', 'is_read', 'created_at'])
    .orderBy('is_read', 'asc')
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();
}

export async function unreadCount(principal: Principal): Promise<number> {
  let base = db.selectFrom('notification').where('is_read', '=', false);

  if (!principal.isSuperAdmin) {
    base = base.where('branch_id', '=', principal.branchId);
  }

  const row = await base.select(({ fn }) => fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  return row.n;
}

export async function markRead(principal: Principal, id: number): Promise<void> {
  const existing = await db
    .selectFrom('notification')
    .select(['id', 'branch_id'])
    .where('id', '=', id)
    .executeTakeFirst();

  if (!existing) throw notFound('Notification');
  assertBranchAccess(principal, existing.branch_id);

  await db.updateTable('notification').set({ is_read: true }).where('id', '=', id).execute();
}

export async function markAllRead(principal: Principal): Promise<void> {
  return withTransaction(async (tx) => {
    if (principal.isSuperAdmin) {
      await tx.updateTable('notification').set({ is_read: true }).execute();
    } else {
      await tx
        .updateTable('notification')
        .set({ is_read: true })
        .where('branch_id', '=', principal.branchId)
        .execute();
    }
  });
}
