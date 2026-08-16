/**
 * The status pill — DESIGN §4.
 *
 * Four reserved roles, and **never colour alone**: every pill carries an icon
 * and a word, so it survives a colour-blind reader, a photocopier, and a
 * washed-out counter monitor. Nothing else on a screen may use these colours
 * (DESIGN §6.2), which is why they live here rather than being reached for ad
 * hoc — a `bg-emerald-100` sprinkled into a table is exactly how a design system
 * stops meaning anything.
 *
 * Add a status to STATUS_ROLE rather than passing a role in: keeping the mapping
 * in one place is what stops "Rejected" being amber on one screen and red on
 * the next.
 */
import { AlertCircle, Check, Circle, Clock } from 'lucide-react';
import { cn } from '@/lib/cn';

export type StatusRole = 'good' | 'warning' | 'critical' | 'neutral';

/** Every document status in the system, mapped to its role. */
const STATUS_ROLE: Record<string, StatusRole> = {
  // good — the thing completed as intended
  PAID: 'good',
  RECEIVED: 'good',
  ACCEPTED: 'good',
  READY: 'good',
  CONFIRMED: 'good',
  CLOSED: 'good',
  APPROVED: 'good',
  DELIVERED: 'good',
  REPAIRED: 'good',
  RETURNED_REPAIRED: 'good',
  REPLACED_NEW: 'good',

  // warning — in flight, waiting on somebody
  PARTIAL: 'warning',
  PENDING: 'warning',
  RAISED: 'warning',
  SHIPPED: 'warning',
  DISPATCHED: 'warning',
  ASSESSED: 'warning',
  IN_TRANSIT: 'warning',

  // critical — wrong, late, or owed
  DUE: 'critical',
  REJECTED: 'critical',
  DAMAGED: 'critical',
  OVERDUE: 'critical',
  CANCELLED: 'critical',
  NOT_REPAIRABLE: 'critical',

  // neutral — parked, not yet in play
  DRAFT: 'neutral',
  HELD: 'neutral',
  INACTIVE: 'neutral',
  CONVERTED: 'neutral',
};

const ROLE_STYLE: Record<StatusRole, string> = {
  good: 'bg-emerald-50 text-[var(--color-status-good)]',
  warning: 'bg-amber-50 text-[var(--color-status-warning)]',
  critical: 'bg-red-50 text-[var(--color-status-critical)]',
  neutral: 'bg-slate-100 text-slate-600',
};

const ROLE_ICON: Record<StatusRole, typeof Check> = {
  good: Check,
  warning: Clock,
  critical: AlertCircle,
  neutral: Circle,
};

export function statusRole(status: string): StatusRole {
  return STATUS_ROLE[status.toUpperCase()] ?? 'neutral';
}

/** `RETURNED_REPAIRED` reads badly on a counter screen. `Returned repaired` does. */
function humanise(status: string): string {
  const s = status.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface StatusPillProps {
  status: string;
  /** Override the derived role when a screen genuinely means something else. */
  role?: StatusRole;
  className?: string;
}

export function StatusPill({ status, role, className }: StatusPillProps) {
  const resolved = role ?? statusRole(status);
  const Icon = ROLE_ICON[resolved];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium',
        ROLE_STYLE[resolved],
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {humanise(status)}
    </span>
  );
}
