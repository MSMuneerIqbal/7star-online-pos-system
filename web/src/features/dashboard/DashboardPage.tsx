import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Boxes, Package, Receipt, ShieldCheck, ShoppingCart, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/money';
import { PageHeader } from '@/components/ui/Field';
import { MagnitudeChart, RankedList, TrendChart } from '@/components/ui/Chart';

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
  branches: Array<{ id: number; name: string | null }>;
}

export function DashboardPage() {
  const { user } = useAuth();
  const isSuper = user?.isSuperAdmin ?? false;
  const [branchId, setBranchId] = useState<number | null>(null);

  const { data } = useQuery({
    queryKey: ['dashboard', branchId],
    queryFn: () =>
      api.get<DashboardData>(branchId === null ? '/dashboard' : `/dashboard?branchId=${branchId}`),
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
    { label: 'Warranty', value: String(data?.figures.warrantyUnits ?? 0), icon: ShieldCheck, to: '/warranty' },
    { label: 'Lab revenue', value: fmtMoney(data?.figures.labRevenue ?? '0'), icon: Receipt, to: '/lab/receiving' },
    { label: 'E-Store', value: String(data?.figures.estoreShipments ?? 0), icon: ShoppingCart, to: '/estore' },
  ];

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Signed in as ${user?.username} — ${user?.branchName}`}
        actions={
          isSuper && (
            <select
              className="field-input w-48"
              aria-label="Select branch"
              value={branchId ?? ''}
              onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">All branches</option>
              {(data?.branches ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )
        }
      />

      {/* The one hero figure */}
      <div className="card mb-4 p-4">
        <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">Sales this month</p>
        <div className="flex items-end gap-3">
          <p className="text-hero font-semibold text-slate-900 tabular">{fmtMoney(data?.hero.month ?? '0')}</p>
          {/* Status ink, from the reserved tokens — never Tailwind's palette (DESIGN §6.2). */}
          <p
            className="text-sm font-medium"
            style={{
              color: delta >= 0 ? 'var(--color-status-good)' : 'var(--color-status-critical)',
            }}
          >
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

      {/* Charts are head-office only. A branch gets figures (PRINCIPLES §12). */}
      {isSuper && (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <TrendChart
            title="Sales — 12 months"
            rows={data?.charts.salesByMonth ?? []}
            labelKey="month"
            valueKey="total"
            format={(v) => fmtMoney(String(v))}
          />

          <MagnitudeChart
            title="Sales by branch"
            rows={data?.charts.salesByBranch ?? []}
            labelKey="name"
            valueKey="total"
            format={(v) => fmtMoney(String(v))}
          />

          {/* A ranked list is a table, not a chart — DESIGN §6.3. */}
          <RankedList
            title="Best sellers"
            rows={data?.charts.bestSellers ?? []}
            labelKey="name"
            valueKey="qty"
            className="lg:col-span-2"
          />
        </div>
      )}
    </>
  );
}
