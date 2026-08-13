import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
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
import { Boxes, Package, Receipt, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/money';
import { PageHeader } from '@/components/ui/Field';
import { CHART, axisProps, chartGrid, seqColor } from '@/components/ui/Chart';

interface DashboardData {
  hero: { month: string; previous: string };
  figures: {
    salesToday: string;
    stockValue: string;
    lowStock: string;
    deadStock: string;
    dues: string;
    receivables: string;
    productionPieces: string;
    warrantyUnits: string;
    labRevenue: string;
    estoreShipments: string;
  };
  charts: {
    salesByMonth: Array<{ month: string; total: string }>;
    salesByBranch: Array<{ name: string; total: string }>;
    bestSellers: Array<{ name: string; qty: string }>;
  };
}

const tooltipStyle = {
  borderRadius: 6,
  border: '1px solid #e2e8f0',
  fontSize: 12,
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
} as const;

export function DashboardPage() {
  const { user } = useAuth();
  const isSuper = user?.isSuperAdmin ?? false;

  const { data } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/dashboard'),
  });

  const current = Number(data?.hero.month ?? 0);
  const previous = Number(data?.hero.previous ?? 0);
  const delta = previous > 0 ? ((current - previous) / previous) * 100 : 0;

  const tiles = [
    { label: 'Sales today', value: fmtMoney(data?.figures.salesToday ?? '0'), icon: Receipt, to: '/reports/sales' },
    { label: 'Stock value', value: fmtMoney(data?.figures.stockValue ?? '0'), icon: Boxes, to: '/reports/finish/stock' },
    { label: 'Receivables', value: fmtMoney(data?.figures.receivables ?? '0'), icon: Users, to: '/customers/statement' },
    { label: 'Low stock', value: String(data?.figures.lowStock ?? 0), icon: Package, to: '/reports/finish/stock' },
    { label: 'Dead stock', value: String(data?.figures.deadStock ?? 0), icon: Boxes, to: '/reports/finish/stock' },
    { label: 'Branch dues', value: fmtMoney(data?.figures.dues ?? '0'), icon: Users, to: '/remittances' },
    { label: 'Production', value: String(data?.figures.productionPieces ?? 0), icon: Package, to: '/production' },
    { label: 'Warranty', value: String(data?.figures.warrantyUnits ?? 0), icon: Package, to: '/demand-orders/raw' },
    { label: 'Lab revenue', value: fmtMoney(data?.figures.labRevenue ?? '0'), icon: Receipt, to: '/lab/receiving' },
    { label: 'E-Store', value: String(data?.figures.estoreShipments ?? 0), icon: Package, to: '/demand-orders/finish' },
  ];

  return (
    <>
      <PageHeader title="Dashboard" subtitle={`Signed in as ${user?.username} — ${user?.branchName}`} />

      {/* The one hero figure */}
      <div className="card mb-4 p-4">
        <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">Sales this month</p>
        <div className="flex items-end gap-3">
          <p className="text-hero font-semibold text-slate-900 tabular">{fmtMoney(data?.hero.month ?? '0')}</p>
          <p className={delta >= 0 ? 'text-sm font-medium text-emerald-700' : 'text-sm font-medium text-red-600'}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}% vs last month
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {tiles.map((t) => (
          <Link key={t.label} to={t.to} className="card p-3 transition hover:border-brand-300">
            <div className="flex items-start justify-between">
              <span className="text-xs font-medium tracking-wide text-slate-500 uppercase">{t.label}</span>
              <t.icon className="size-4 text-slate-400" />
            </div>
            <p className="mt-1.5 text-stat font-semibold text-slate-900 tabular">{t.value}</p>
          </Link>
        ))}
      </div>

      {isSuper && (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div className="card p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-900">Sales — 12 months</h2>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={data?.charts.salesByMonth ?? []}>
                <CartesianGrid {...chartGrid} />
                <XAxis dataKey="month" {...axisProps} />
                <YAxis {...axisProps} />
                <Tooltip contentStyle={tooltipStyle} />
                <Line type="monotone" dataKey="total" stroke={CHART.series[0]} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="card p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-900">Sales by branch</h2>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data?.charts.salesByBranch ?? []} layout="vertical">
                <CartesianGrid {...chartGrid} />
                <XAxis type="number" {...axisProps} />
                <YAxis type="category" dataKey="name" width={120} {...axisProps} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="total" radius={[0, 3, 3, 0]}>
                  {(data?.charts.salesByBranch ?? []).map((_, i) => (
                    <Cell key={i} fill={seqColor(i)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card p-4 lg:col-span-2">
            <h2 className="mb-2 text-sm font-semibold text-slate-900">Best sellers</h2>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data?.charts.bestSellers ?? []} layout="vertical">
                <CartesianGrid {...chartGrid} />
                <XAxis type="number" {...axisProps} />
                <YAxis type="category" dataKey="name" width={180} {...axisProps} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="qty" radius={[0, 3, 3, 0]}>
                  {(data?.charts.bestSellers ?? []).map((_, i) => (
                    <Cell key={i} fill={seqColor(i)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </>
  );
}
