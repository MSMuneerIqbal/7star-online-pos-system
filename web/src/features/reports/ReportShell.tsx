import { useState, type ReactNode } from 'react';
import { Loader2, Printer, Search } from 'lucide-react';
import { PageHeader } from '@/components/ui/Field';

export type Filter = 'range' | 'asAt' | 'rangeWithItem';

export interface ReportParams {
  from: string;
  to: string;
  asAt: string;
  pid: number | null;
}

const startOfYear = () => `${new Date().getFullYear()}-01-01`;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Common shell for every report: title, filter bar, print button, loading and
 * error handling. Nine reports share it, so they stay visually consistent and a
 * new one is a query plus a table.
 */
export function ReportShell({
  title,
  subtitle,
  filter,
  items,
  loading,
  error,
  onRun,
  children,
}: {
  title: string;
  subtitle: string;
  filter: Filter;
  /** Item picker options, for the item-ledger reports. */
  items?: { id: number; name: string | null }[];
  loading?: boolean;
  error?: string | null;
  onRun: (params: ReportParams) => void;
  children: ReactNode;
}) {
  const [from, setFrom] = useState(startOfYear());
  const [to, setTo] = useState(today());
  const [asAt, setAsAt] = useState(today());
  const [pid, setPid] = useState<number | null>(null);

  const needsItem = filter === 'rangeWithItem';
  const showRange = filter !== 'asAt';

  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />

      <form
        className="card no-print mb-4 flex flex-wrap items-end gap-3 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          onRun({ from, to, asAt, pid });
        }}
      >
        {needsItem && (
          <div className="min-w-56 flex-1">
            <label htmlFor="item" className="field-label">
              Item
            </label>
            <select
              id="item"
              className="field-input"
              value={pid ?? ''}
              onChange={(e) => setPid(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select an item…</option>
              {items?.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {showRange ? (
          <>
            <div>
              <label htmlFor="from" className="field-label">
                From
              </label>
              <input
                id="from"
                type="date"
                className="field-input"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="to" className="field-label">
                To
              </label>
              <input
                id="to"
                type="date"
                className="field-input"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </>
        ) : (
          <div>
            <label htmlFor="asAt" className="field-label">
              As at
            </label>
            <input
              id="asAt"
              type="date"
              className="field-input"
              value={asAt}
              onChange={(e) => setAsAt(e.target.value)}
            />
          </div>
        )}

        <button type="submit" className="btn-primary" disabled={needsItem && pid === null}>
          <Search className="size-3.5" />
          Run
        </button>

        <button type="button" className="btn-secondary" onClick={() => window.print()}>
          <Printer className="size-3.5" />
          Print
        </button>
      </form>

      {loading && (
        <div className="grid place-items-center p-10">
          <Loader2 className="size-5 animate-spin text-slate-400" />
        </div>
      )}

      {error && <p className="card p-4 text-sm text-red-600">{error}</p>}

      {!loading && !error && children}
    </>
  );
}

/** A plain report table with an optional footer row. */
export function ReportTable({
  headers,
  children,
  footer,
  empty,
  isEmpty,
}: {
  headers: ReadonlyArray<{ label: string; numeric?: boolean; width?: string }>;
  children: ReactNode;
  footer?: ReactNode;
  empty?: string;
  isEmpty?: boolean;
}) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase">
            {headers.map((h) => (
              <th
                key={h.label}
                scope="col"
                style={h.width ? { width: h.width } : undefined}
                className={h.numeric ? 'px-2 py-2 text-right' : 'px-2 py-2 text-left'}
              >
                {h.label}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {isEmpty ? (
            <tr>
              <td
                colSpan={headers.length}
                className="px-2 py-8 text-center text-sm text-slate-400"
              >
                {empty ?? 'Nothing to show for this period'}
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>

        {footer && !isEmpty && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  );
}
