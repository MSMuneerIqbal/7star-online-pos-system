import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Boxes, Package, Receipt, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/money';
import { PageHeader } from '@/components/ui/Field';

interface Paged<T> {
  rows: T[];
  total: number;
}

const today = () => new Date().toISOString().slice(0, 10);
const startOfMonth = () => `${new Date().toISOString().slice(0, 7)}-01`;

/** The steps a brand-new installation needs, in the order they make sense. */
const SETUP_STEPS = [
  { label: 'Add your branches', path: '/branches', key: 'branches' },
  { label: 'Add brands and categories', path: '/brands', key: 'brands' },
  { label: 'Add raw materials', path: '/raw-products', key: 'rawProducts' },
  { label: 'Add products you sell', path: '/products', key: 'products' },
  { label: 'Add customers', path: '/customers', key: 'customers' },
  { label: 'Add vendors', path: '/suppliers', key: 'suppliers' },
] as const;

export function DashboardPage() {
  const { user } = useAuth();

  // Counts drive both the tiles and the setup checklist, so one set of queries
  // serves an empty system and a running one.
  const counts = useQuery({
    queryKey: ['dashboard', 'counts'],
    queryFn: async () => {
      const [branches, brands, rawProducts, products, customers, suppliers] = await Promise.all([
        api.get<Paged<unknown>>('/branches?pageSize=1'),
        api.get<Paged<unknown>>('/brands?pageSize=1'),
        api.get<Paged<unknown>>('/raw-products?pageSize=1'),
        api.get<Paged<unknown>>('/products?pageSize=1'),
        api.get<Paged<unknown>>('/customers?pageSize=1'),
        api.get<Paged<unknown>>('/suppliers?pageSize=1'),
      ]);

      return {
        branches: branches.total,
        brands: brands.total,
        rawProducts: rawProducts.total,
        products: products.total,
        // The walk-in customer is created by setup, so it does not count as
        // the user having added anyone.
        customers: Math.max(0, customers.total - 1),
        suppliers: suppliers.total,
      };
    },
  });

  const sales = useQuery({
    queryKey: ['dashboard', 'sales'],
    queryFn: () => api.get<{ totals: { net: string; remaining: string }; count: number }>(
      `/reports/sales?from=${startOfMonth()}&to=${today()}`,
    ),
  });

  const stock = useQuery({
    queryKey: ['dashboard', 'stock'],
    queryFn: () => api.get<{ totalValue: string; rows: { belowReorder: boolean }[] }>(
      `/reports/stock/finish?asAt=${today()}`,
    ),
  });

  const remaining = SETUP_STEPS.filter((s) => (counts.data?.[s.key] ?? 0) === 0);
  const setupComplete = counts.data !== undefined && remaining.length === 0;

  const tiles = [
    {
      label: 'Sales this month',
      value: fmtMoney(sales.data?.totals.net ?? '0'),
      sub: `${sales.data?.count ?? 0} invoice(s)`,
      icon: Receipt,
      to: '/reports/sales',
    },
    {
      label: 'Outstanding',
      value: fmtMoney(sales.data?.totals.remaining ?? '0'),
      sub: 'Owed by customers',
      icon: Users,
      to: '/ledger',
    },
    {
      label: 'Stock value',
      value: fmtMoney(stock.data?.totalValue ?? '0'),
      sub: 'Finished goods at cost',
      icon: Boxes,
      to: '/reports/finish/stock',
    },
    {
      label: 'Low stock',
      value: String(stock.data?.rows.filter((r) => r.belowReorder).length ?? 0),
      sub: 'Items below reorder level',
      icon: Package,
      to: '/reports/finish/stock',
    },
  ];

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Signed in as ${user?.username} — ${user?.branchName}`}
      />

      {/* A new installation gets a checklist instead of empty tiles. */}
      {!setupComplete && counts.data && (
        <div className="card mb-4 border-brand-200 bg-brand-50 p-4">
          <h2 className="text-sm font-semibold text-brand-900">Finish setting up</h2>
          <p className="mt-0.5 text-sm text-brand-800">
            The chart of accounts and permissions are ready. Add your own data to start trading.
          </p>

          <ul className="mt-3 space-y-1">
            {SETUP_STEPS.map((step) => {
              const done = (counts.data?.[step.key] ?? 0) > 0;

              return (
                <li key={step.key}>
                  <Link
                    to={step.path}
                    className={
                      done
                        ? 'flex items-center gap-2 text-sm text-brand-700 line-through opacity-60'
                        : 'flex items-center gap-2 text-sm font-medium text-brand-900 hover:underline'
                    }
                  >
                    <span
                      className={
                        done
                          ? 'grid size-4 place-items-center rounded-full bg-brand-600 text-[10px] text-white'
                          : 'size-4 rounded-full border-2 border-brand-400'
                      }
                    >
                      {done ? '✓' : ''}
                    </span>
                    {step.label}
                    {!done && <ArrowRight className="size-3" />}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.label} to={t.to} className="card p-4 transition hover:border-brand-300">
            <div className="flex items-start justify-between">
              <span className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                {t.label}
              </span>
              <t.icon className="size-4 text-slate-400" />
            </div>
            <p className="mt-2 text-xl font-semibold text-slate-900 tabular">{t.value}</p>
            <p className="mt-0.5 text-xs text-slate-500">{t.sub}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
