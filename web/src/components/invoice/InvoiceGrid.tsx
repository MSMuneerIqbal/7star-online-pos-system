import { useRef } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { fmtMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import type { InvoiceLine, PricedLine } from './useInvoiceLines';

export interface GridProduct {
  id: number;
  name: string | null;
  sellingPrice: string;
}

interface InvoiceGridProps {
  lines: readonly PricedLine[];
  products: readonly GridProduct[];
  onAdd: () => void;
  onRemove: (key: string) => void;
  onChange: (key: string, patch: Partial<Omit<InvoiceLine, 'key'>>) => void;
  disabled?: boolean;
}

/**
 * Invoice line-item grid.
 *
 * Built for keyboard-first data entry, because operators enter invoices all day:
 * picking a product fills its price and jumps to quantity, Enter on the last row
 * appends a new one. The legacy screen required a mouse for both.
 */
export function InvoiceGrid({
  lines,
  products,
  onAdd,
  onRemove,
  onChange,
  disabled,
}: InvoiceGridProps) {
  // Indexed by row key so we can move focus after a product is chosen.
  const qtyRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const selectProduct = (key: string, pid: number) => {
    const product = products.find((p) => p.id === pid);
    if (!product) return;

    onChange(key, {
      pid,
      pname: product.name ?? '',
      // Prefill the price; the operator can still negotiate it.
      price: product.sellingPrice,
    });

    // Straight to quantity — the next thing anyone types.
    queueMicrotask(() => qtyRefs.current[key]?.focus());
  };

  return (
    <div className="card overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-xs tracking-wide text-slate-600 uppercase">
            <th scope="col" className="w-8 px-2 py-2 text-left">
              #
            </th>
            <th scope="col" className="px-2 py-2 text-left">
              Item
            </th>
            <th scope="col" className="w-24 px-2 py-2 text-right">
              Qty
            </th>
            <th scope="col" className="w-32 px-2 py-2 text-right">
              Rate
            </th>
            <th scope="col" className="w-32 px-2 py-2 text-right">
              Total
            </th>
            <th scope="col" className="w-28 px-2 py-2 text-right">
              Discount
            </th>
            <th scope="col" className="w-32 px-2 py-2 text-right">
              Net
            </th>
            <th className="w-10 px-2 py-2" />
          </tr>
        </thead>

        <tbody>
          {lines.map((line, i) => {
            const overDiscount = Number(line.discount) > Number(line.total);

            return (
              <tr key={line.key} className="border-b border-slate-100 last:border-0">
                <td className="px-2 py-1 text-xs text-slate-400 tabular">{i + 1}</td>

                <td className="px-2 py-1">
                  <select
                    value={line.pid ?? ''}
                    disabled={disabled}
                    aria-label={`Item for line ${i + 1}`}
                    onChange={(e) => selectProduct(line.key, Number(e.target.value))}
                    className="field-input py-1"
                  >
                    <option value="">Select an item…</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </td>

                <td className="px-2 py-1">
                  <input
                    ref={(el) => {
                      qtyRefs.current[line.key] = el;
                    }}
                    type="number"
                    step="any"
                    min="0"
                    inputMode="decimal"
                    value={line.qty}
                    disabled={disabled}
                    aria-label={`Quantity for line ${i + 1}`}
                    onChange={(e) => onChange(line.key, { qty: e.target.value })}
                    onKeyDown={(e) => {
                      // Enter on the last row appends another, so a long
                      // invoice never needs the mouse.
                      if (e.key === 'Enter' && i === lines.length - 1) {
                        e.preventDefault();
                        onAdd();
                      }
                    }}
                    className="field-input py-1 text-right tabular"
                  />
                </td>

                <td className="px-2 py-1">
                  <input
                    type="number"
                    step="any"
                    min="0"
                    inputMode="decimal"
                    value={line.price}
                    disabled={disabled}
                    aria-label={`Rate for line ${i + 1}`}
                    onChange={(e) => onChange(line.key, { price: e.target.value })}
                    className="field-input py-1 text-right tabular"
                  />
                </td>

                <td className="px-2 py-1 text-right text-slate-600 tabular">
                  {fmtMoney(line.total)}
                </td>

                <td className="px-2 py-1">
                  <input
                    type="number"
                    step="any"
                    min="0"
                    inputMode="decimal"
                    value={line.discount}
                    disabled={disabled}
                    aria-label={`Discount for line ${i + 1}`}
                    aria-invalid={overDiscount || undefined}
                    onChange={(e) => onChange(line.key, { discount: e.target.value })}
                    className={cn(
                      'field-input py-1 text-right tabular',
                      overDiscount && 'border-red-400 focus:border-red-500',
                    )}
                  />
                </td>

                <td className="px-2 py-1 text-right font-medium text-slate-900 tabular">
                  {fmtMoney(line.netTotal)}
                </td>

                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Remove line ${i + 1}`}
                    onClick={() => onRemove(line.key)}
                    className="rounded-sm p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="border-t border-slate-200 px-2 py-1.5">
        <button type="button" className="btn-secondary" onClick={onAdd} disabled={disabled}>
          <Plus className="size-3.5" />
          Add item
        </button>
      </div>
    </div>
  );
}

/**
 * One row of the totals panel. Either a computed figure or an editable input —
 * which of the two is decided by whether `onChange` is supplied.
 */
export interface TotalRow {
  label: string;
  value: string;
  /** Present means the row is an input the operator edits. */
  onChange?: (v: string) => void;
  /** Larger, bold — net total and remaining. */
  emphasis?: boolean;
  /** Draw a separator above this row. */
  divider?: boolean;
}

/**
 * Invoice totals panel.
 *
 * Deliberately driven by a row list rather than named props: sale has service
 * charges and "received", purchase has freight and "paid", and the returns
 * differ again. Five invoice modules share this one component.
 */
export function TotalsPanel({
  rows,
  disabled,
}: {
  rows: readonly TotalRow[];
  disabled?: boolean;
}) {
  return (
    <div className="card ml-auto w-full max-w-sm p-3">
      {rows.map((r) => {
        const name = r.label.toLowerCase().replace(/\s+/g, '-');

        return (
          <div key={r.label}>
            {r.divider && <div className="my-1 border-t border-slate-200" />}

            <div className="flex items-center justify-between gap-3 py-1">
              {r.onChange ? (
                <>
                  <label htmlFor={name} className="text-sm text-slate-600">
                    {r.label}
                  </label>
                  <input
                    id={name}
                    name={name}
                    type="number"
                    step="any"
                    min="0"
                    inputMode="decimal"
                    value={r.value}
                    disabled={disabled}
                    onChange={(e) => r.onChange?.(e.target.value)}
                    className="field-input w-32 py-1 text-right tabular"
                  />
                </>
              ) : (
                <>
                  <span
                    className={cn(
                      'text-sm',
                      r.emphasis ? 'font-semibold text-slate-900' : 'text-slate-600',
                    )}
                  >
                    {r.label}
                  </span>
                  <span
                    className={cn(
                      'tabular',
                      r.emphasis
                        ? 'text-base font-semibold text-slate-900'
                        : 'text-sm text-slate-700',
                    )}
                  >
                    {fmtMoney(r.value)}
                  </span>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
