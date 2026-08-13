/**
 * Audit log.
 *
 * Ports LogHistoryService.SaveLog(form, action, detail, invId). The detail
 * string format is preserved deliberately so historical rows migrated from the
 * legacy `UserLog` table stay comparable with new ones.
 *
 * Difference from legacy: SaveLog threw on failure, which could abort an
 * otherwise-successful save. Here a logging failure never breaks the operation
 * it is describing — but it is reported.
 */
import type { Executor } from './db/index.js';
import { db } from './db/index.js';
import type { Principal } from './rbac.js';

export type AuditAction = 'New' | 'Edit' | 'Delete' | 'Approve' | 'Deliver' | 'Print' | 'Login' | 'Logout' | 'Import';

export interface AuditEntry {
  form: string;
  action: AuditAction;
  detail: string;
  invId?: number;
}

/**
 * Write an audit row.
 *
 * Pass the surrounding transaction as `executor` so the log commits or rolls
 * back atomically with the thing it describes.
 */
export async function writeAudit(
  principal: Principal,
  entry: AuditEntry,
  executor: Executor = db,
): Promise<void> {
  try {
    await executor
      .insertInto('user_log')
      .values({
        inv_id: entry.invId ?? null,
        branch_id: principal.branchId,
        user_id: principal.empId,
        username: principal.username,
        form: entry.form,
        action: entry.action,
        detail: entry.detail,
      })
      .execute();
  } catch (err) {
    // Never let auditing break the business operation.
    // eslint-disable-next-line no-console
    console.error('Failed to write audit log', { entry, err });
  }
}

// ---------------------------------------------------------------------------
// Detail formatting — mirrors the legacy strings.
// ---------------------------------------------------------------------------

export interface LineItem {
  pid: number;
  qty: string;
  price: string;
  total: string;
  discount: string;
  netTotal: string;
}

/** `[PID:12, Qty:3, Rate:1,500.00, Total:4,500.00, Disc:0.00, Net:4,500.00] | ` */
export function formatLineItems(items: readonly LineItem[]): string {
  return items
    .map(
      (i) =>
        `[PID:${i.pid}, Qty:${i.qty}, Rate:${i.price}, ` +
        `Total:${i.total}, Disc:${i.discount}, Net:${i.netTotal}]`,
    )
    .join(' | ');
}

export function formatInvoiceAudit(opts: {
  invoiceId: number;
  action: AuditAction;
  module: string;
  party: string;
  gross: string;
  discount: string;
  service?: string;
  net: string;
  received: string;
  remaining: string;
  items: readonly LineItem[];
}): string {
  const service = opts.service === undefined ? '' : `Service:${opts.service}, `;

  return (
    `Invoice:${opts.invoiceId} | ${opts.action} ${opts.module} | ${opts.party} | ` +
    `Gross:${opts.gross}, Discount:${opts.discount}, ${service}Net:${opts.net}, ` +
    `Received:${opts.received}, Remaining:${opts.remaining} | ` +
    `Products => ${formatLineItems(opts.items)}`
  );
}
