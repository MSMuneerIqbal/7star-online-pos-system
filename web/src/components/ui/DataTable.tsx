import { type ReactNode } from 'react';
import { Loader2, Inbox } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface Column<T> {
  key: string;
  header: string;
  /** Render the cell. Defaults to the raw value at `key`. */
  cell?: (row: T) => ReactNode;
  /** Right-align and use tabular figures — for money and quantities. */
  numeric?: boolean;
  width?: string;
}

interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string | number;
  loading?: boolean;
  error?: string | null;
  emptyMessage?: string;
  /** Rendered in a trailing column, right-aligned — edit/delete buttons. */
  actions?: (row: T) => ReactNode;
  onRowClick?: (row: T) => void;
}

/**
 * Dense data table. Replaces jQuery DataTables.
 *
 * Paging, sorting and searching are server-side (see core/crud.ts), so this is
 * a presentational component — it never holds the dataset.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  emptyMessage = 'No records found',
  actions,
  onRowClick,
}: DataTableProps<T>) {
  const colSpan = columns.length + (actions ? 1 : 0);

  return (
    // Wide tables scroll inside their own container so the page never does.
    <div className="card overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={c.width ? { width: c.width } : undefined}
                className={cn(
                  'px-3 py-2 text-xs font-semibold tracking-wide text-slate-600 uppercase',
                  c.numeric ? 'text-right' : 'text-left',
                )}
              >
                {c.header}
              </th>
            ))}
            {actions && <th className="w-px px-3 py-2" />}
          </tr>
        </thead>

        <tbody>
          {loading && (
            <tr>
              <td colSpan={colSpan} className="px-3 py-10 text-center text-slate-400">
                <Loader2 className="mx-auto size-5 animate-spin" />
              </td>
            </tr>
          )}

          {!loading && error && (
            <tr>
              <td colSpan={colSpan} className="px-3 py-10 text-center text-sm text-red-600">
                {error}
              </td>
            </tr>
          )}

          {!loading && !error && rows.length === 0 && (
            <tr>
              <td colSpan={colSpan} className="px-3 py-10 text-center text-slate-400">
                <Inbox className="mx-auto mb-2 size-6" />
                <p className="text-sm">{emptyMessage}</p>
              </td>
            </tr>
          )}

          {!loading &&
            !error &&
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  'border-b border-slate-100 last:border-0',
                  onRowClick && 'cursor-pointer',
                  'hover:bg-slate-50',
                )}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      'px-3 py-1.5 text-slate-700',
                      c.numeric && 'tabular text-right',
                    )}
                  >
                    {c.cell ? c.cell(row) : String((row as Record<string, unknown>)[c.key] ?? '')}
                  </td>
                ))}

                {actions && (
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">{actions(row)}</td>
                )}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ page, pageSize, total, onPageChange }: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="no-print mt-3 flex items-center justify-between text-sm text-slate-600">
      <span>
        Showing <strong className="tabular">{from}</strong>–<strong className="tabular">{to}</strong>{' '}
        of <strong className="tabular">{total}</strong>
      </span>

      <div className="flex gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </button>
        <span className="self-center px-1 text-xs text-slate-500">
          Page {page} of {pages}
        </span>
        <button
          type="button"
          className="btn-secondary"
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
