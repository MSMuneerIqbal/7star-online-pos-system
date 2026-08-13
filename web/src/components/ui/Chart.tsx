/**
 * The one chart wrapper. Features never import Recharts directly — they use
 * these tokens and helpers so every chart obeys DESIGN.md's mark spec.
 */
export const CHART = {
  surface: '#ffffff',
  grid: '#e2e8f0',
  axis: '#94a3b8',
  series: ['#346dd7', '#c57800', '#009d89', '#6f3bb2'],
  muted: '#cbd5e1',
  seq: ['#bad9ff', '#92beff', '#6ca2ff', '#4b86f3', '#346dd7', '#2455b0', '#193e84'],
  status: { good: '#1c882d', warning: '#d78d00', critical: '#dc2626' },
} as const;

export const chartGrid = { stroke: CHART.grid, strokeDasharray: '3 3' } as const;

export const axisProps = {
  tick: { fill: CHART.axis, fontSize: 11 },
  axisLine: { stroke: CHART.grid },
  tickLine: false as const,
} as const;

/** A bar's fill by index, cycling through the sequential ramp. */
export function seqColor(i: number): string {
  return CHART.seq[i % CHART.seq.length] ?? CHART.series[0];
}
