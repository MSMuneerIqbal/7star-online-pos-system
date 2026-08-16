/**
 * The chart system — DESIGN §6.
 *
 * Features import from here and NEVER from `recharts` directly (DESIGN §6.7).
 * Recharts' defaults violate half the mark spec — dashed grids, categorical
 * colour by default, a dot on every point — so the wrapper's whole job is to
 * make the correct chart the easy one to reach for.
 *
 * Three rules this file exists to hold:
 *
 *   - Gridlines are a **1px solid hairline**, never dashed (§6.4).
 *   - **Branches are never a categorical colour dimension** (§6.1). Comparing
 *     them is a magnitude job: one hue, sorted, the ramp tracking value rather
 *     than array position.
 *   - **Every chart has a table view** (§6.6). A tooltip enhances; it never
 *     gates. The toggle here is also where the Excel export gets its shape.
 */
import { useState, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Table2, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/cn';

export const CHART = {
  surface: '#ffffff',
  grid: '#e2e8f0',
  axis: '#94a3b8',
  series: ['#346dd7', '#c57800', '#009d89', '#6f3bb2'],
  muted: '#cbd5e1',
  /** Light → dark. Index by VALUE, never by position. */
  seq: ['#bad9ff', '#92beff', '#6ca2ff', '#4b86f3', '#346dd7', '#2455b0', '#193e84'],
  status: { good: '#1c882d', warning: '#d78d00', critical: '#dc2626' },
} as const;

/** 1px solid hairline. DESIGN §6.4 is explicit that gridlines are never dashed. */
const gridProps = { stroke: CHART.grid, vertical: false } as const;

const axisProps = {
  tick: { fill: CHART.axis, fontSize: 11 },
  axisLine: { stroke: CHART.grid },
  tickLine: false as const,
} as const;

const tooltipProps = {
  contentStyle: {
    borderRadius: 6,
    border: `1px solid ${CHART.grid}`,
    fontSize: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  },
  cursor: { fill: 'rgba(148,163,184,0.08)' },
} as const;

/**
 * A bar's fill from its share of the largest value, so the ramp carries
 * magnitude rather than the order rows happened to arrive in.
 */
function rampByValue(value: number, max: number): string {
  if (max <= 0) return CHART.seq[CHART.seq.length - 1]!;
  const i = Math.min(CHART.seq.length - 1, Math.round((value / max) * (CHART.seq.length - 1)));
  return CHART.seq[i]!;
}

interface Datum {
  [key: string]: string | number | null;
}

interface ChartCardProps {
  title: string;
  rows: Datum[];
  labelKey: string;
  valueKey: string;
  /** How a value reads in the table view and the tooltip. */
  format?: (v: string | number) => string;
  className?: string;
  children: ReactNode;
}

/**
 * The card, the heading and the chart/table toggle. Every panel gets one, so the
 * table view is never something a screen has to remember to add.
 */
function ChartCard({ title, rows, labelKey, valueKey, format, className, children }: ChartCardProps) {
  const [asTable, setAsTable] = useState(false);
  const fmt = format ?? ((v: string | number) => String(v));

  return (
    <div className={cn('card p-4', className)}>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          title={asTable ? 'Show the chart' : 'Show the numbers'}
          aria-label={asTable ? 'Show the chart' : 'Show the numbers'}
          className="rounded-sm p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
        >
          {asTable ? <TrendingUp className="size-3.5" /> : <Table2 className="size-3.5" />}
        </button>
      </div>

      {asTable ? (
        <div className="max-h-[220px] overflow-y-auto">
          <table className="w-full text-sm">
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  <td className="py-1 text-slate-700">{String(r[labelKey] ?? '—')}</td>
                  <td className="py-1 text-right font-medium text-slate-900 tabular">
                    {fmt(r[valueKey] ?? 0)}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="py-2 text-slate-400">Nothing to show yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

interface TrendChartProps {
  title: string;
  rows: Datum[];
  labelKey: string;
  valueKey: string;
  format?: (v: string | number) => string;
  className?: string;
}

/** Change over time: a 2px line in one hue, no dot on every point (§6.3). */
export function TrendChart({ title, rows, labelKey, valueKey, format, className }: TrendChartProps) {
  return (
    <ChartCard
      title={title}
      rows={rows}
      labelKey={labelKey}
      valueKey={valueKey}
      {...(format ? { format } : {})}
      {...(className ? { className } : {})}
    >
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={rows} role="img" aria-label={title}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey={labelKey} {...axisProps} />
          <YAxis {...axisProps} />
          <Tooltip {...tooltipProps} />
          <Line
            type="monotone"
            dataKey={valueKey}
            stroke={CHART.series[0]}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: '#ffffff' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

interface MagnitudeChartProps {
  title: string;
  rows: Datum[];
  labelKey: string;
  valueKey: string;
  format?: (v: string | number) => string;
  labelWidth?: number;
  className?: string;
}

/**
 * Compare magnitude: a sorted horizontal bar in ONE hue, longest first.
 *
 * This is the shape branches get. Seven coloured lines is a plate of spaghetti
 * nobody reads, and spending a categorical slot on "Faisalabad" wastes the
 * strongest ink on the screen (§6.1).
 */
export function MagnitudeChart({
  title,
  rows,
  labelKey,
  valueKey,
  format,
  labelWidth = 120,
  className,
}: MagnitudeChartProps) {
  const sorted = [...rows].sort((a, b) => Number(b[valueKey] ?? 0) - Number(a[valueKey] ?? 0));
  const max = Math.max(0, ...sorted.map((r) => Number(r[valueKey] ?? 0)));

  return (
    <ChartCard
      title={title}
      rows={sorted}
      labelKey={labelKey}
      valueKey={valueKey}
      {...(format ? { format } : {})}
      {...(className ? { className } : {})}
    >
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={sorted} layout="vertical" role="img" aria-label={title}>
          <CartesianGrid {...gridProps} horizontal={false} vertical />
          <XAxis type="number" {...axisProps} />
          <YAxis type="category" dataKey={labelKey} width={labelWidth} {...axisProps} />
          <Tooltip {...tooltipProps} />
          <Bar dataKey={valueKey} maxBarSize={24} radius={[0, 4, 4, 0]}>
            {sorted.map((r, i) => (
              <Cell key={i} fill={rampByValue(Number(r[valueKey] ?? 0), max)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

interface RankedListProps {
  title: string;
  rows: Datum[];
  labelKey: string;
  valueKey: string;
  format?: (v: string | number) => string;
  className?: string;
}

/**
 * A ranked list is a TABLE, not a chart (DESIGN §6.3).
 *
 * Ten products with ten colours is the classic dashboard mistake; a table reads
 * faster and carries the exact number, which is what anyone acting on "best
 * sellers" actually needs.
 */
export function RankedList({ title, rows, labelKey, valueKey, format, className }: RankedListProps) {
  const fmt = format ?? ((v: string | number) => String(v));
  const sorted = [...rows].sort((a, b) => Number(b[valueKey] ?? 0) - Number(a[valueKey] ?? 0));

  return (
    <div className={cn('card p-4', className)}>
      <h2 className="mb-2 text-sm font-semibold text-slate-900">{title}</h2>
      <table className="w-full text-sm">
        <tbody>
          {sorted.map((r, i) => (
            <tr key={i} className="border-b border-slate-100 last:border-0">
              <td className="w-6 py-1 text-xs text-slate-400 tabular">{i + 1}</td>
              <td className="py-1 text-slate-700">{String(r[labelKey] ?? '—')}</td>
              <td className="py-1 text-right font-medium text-slate-900 tabular">
                {fmt(r[valueKey] ?? 0)}
              </td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td className="py-2 text-slate-400">Nothing has moved yet</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
