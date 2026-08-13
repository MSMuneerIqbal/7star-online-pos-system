import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from '@/lib/auth';
import { AppShell } from '@/components/layout/AppShell';
import { LoginPage } from '@/features/auth/LoginPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { BranchPage } from '@/features/branch/BranchPage';
import { SalePage } from '@/features/sale/SalePage';
import { PurchasePage } from '@/features/purchase/PurchasePage';
import { PrintDocumentPage } from '@/features/print/PrintDocument';
import { ReturnPage, SALE_RETURN, PURCHASE_RETURN } from '@/features/returns/ReturnPage';
import { HoldSalePage } from '@/features/hold-sale/HoldSalePage';
import { BranchProductPage } from '@/features/branch-product/BranchProductPage';
import { VoucherPage } from '@/features/voucher/VoucherPage';
import { LedgerPage } from '@/features/ledger/LedgerPage';
import { TrialBalancePage } from '@/features/ledger/TrialBalancePage';
import { DemandOrderPage } from '@/features/demand-order/DemandOrderPage';
import { RemittancePage } from '@/features/remittance/RemittancePage';
import { CustomerStatementPage } from '@/features/customer/CustomerStatementPage';
import { ExpensePage } from '@/features/expense/ExpensePage';
import {
  BalanceSheetPage,
  CashBookPage,
  IncomeStatementPage,
} from '@/features/reports/FinancialReports';
import { ItemLedgerPage, StockReportPage } from '@/features/reports/StockReports';
import { PurchaseReportPage, SaleReportPage } from '@/features/reports/TradeReports';
import { ProductionPage } from '@/features/production/ProductionPage';
import { LabPage } from '@/features/lab/LabPage';
import { ChartOfAccountsPage } from '@/features/accounts/ChartOfAccountsPage';
import {
  RegistrationPage,
  BRAND,
  CATEGORY,
  RAW_PRODUCT,
  PRODUCT,
  CUSTOMER,
  SUPPLIER,
  EMPLOYEE,
} from '@/features/registration/RegistrationPage';
import { RoleAssignPage } from '@/features/admin/RoleAssignPage';
import {
  RolesPage,
  SettingsPage,
  UserLoginsPage,
  UserLogsPage,
  LoginHistoryPage,
} from '@/features/admin/AdminPages';
import { NotBuiltPage } from '@/components/NotBuiltPage';
import { NAV } from '@/lib/nav';

/** Routes with a real implementation. Everything else gets a placeholder. */
const IMPLEMENTED: Record<string, React.ComponentType> = {
  '/branches': BranchPage,

  // The other seven registration screens share one configured component.
  '/brands': () => <RegistrationPage config={BRAND} />,
  '/categories': () => <RegistrationPage config={CATEGORY} />,
  '/raw-products': () => <RegistrationPage config={RAW_PRODUCT} />,
  '/products': () => <RegistrationPage config={PRODUCT} />,
  '/customers': () => <RegistrationPage config={CUSTOMER} />,
  '/suppliers': () => <RegistrationPage config={SUPPLIER} />,
  '/employees': () => <RegistrationPage config={EMPLOYEE} />,

  '/branch-products': BranchProductPage,

  '/sales': SalePage,
  '/purchases': PurchasePage,
  '/sale-returns': () => <ReturnPage config={SALE_RETURN} />,
  '/purchase-returns': () => <ReturnPage config={PURCHASE_RETURN} />,
  '/hold-sales': HoldSalePage,

  // All five vouchers share one component, parameterised by type.
  '/vouchers/cash-receipt': () => <VoucherPage type="CRV" />,
  '/vouchers/cash-payment': () => <VoucherPage type="CPV" />,
  '/vouchers/bank-receipt': () => <VoucherPage type="BRV" />,
  '/vouchers/bank-payment': () => <VoucherPage type="BPV" />,
  '/vouchers/journal': () => <VoucherPage type="JV" />,

  '/accounts/chart/first': () => <ChartOfAccountsPage level="first" />,
  '/accounts/chart/second': () => <ChartOfAccountsPage level="second" />,
  '/accounts/chart/final': () => <ChartOfAccountsPage level="final" />,

  '/ledger': LedgerPage,
  '/financials/trial-balance': TrialBalancePage,

  // One page covers what the legacy system split across ten controllers.
  '/demand-orders/raw': () => <DemandOrderPage kind="raw" />,
  '/demand-orders/finish': () => <DemandOrderPage kind="finish" />,
  '/remittances': RemittancePage,
  '/customers/statement': CustomerStatementPage,
  '/expenses': ExpensePage,

  // Reports — every one of these was a dead link in the legacy sidebar.
  '/reports/raw/stock': () => <StockReportPage kind="raw" />,
  '/reports/raw/ledger': () => <ItemLedgerPage kind="raw" />,
  '/reports/finish/stock': () => <StockReportPage kind="finish" />,
  '/reports/finish/ledger': () => <ItemLedgerPage kind="finish" />,
  '/reports/sales': SaleReportPage,
  '/reports/purchases': PurchaseReportPage,
  '/ledger/cash-book': CashBookPage,
  '/financials/income-statement': IncomeStatementPage,
  '/financials/balance-sheet': BalanceSheetPage,

  '/production': ProductionPage,

  // Lab Receiving and Lab Invoices share one page — the invoice is raised from
  // the job, which is what the legacy MakeInvoice actions implied.
  '/lab/receiving': LabPage,
  '/lab/invoices': LabPage,

  '/users/roles': RolesPage,
  '/users/role-assign': RoleAssignPage,
  '/users/logins': UserLoginsPage,
  '/users/logs': UserLogsPage,
  '/users/login-history': LoginHistoryPage,
  '/settings': SettingsPage,
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, err) => {
        // Never retry an auth or permission failure.
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403) return false;
        return count < 2;
      },
    },
  },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Loader2 className="size-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  return children;
}

/**
 * Placeholder routes for every menu entry that has no page yet, so the sidebar
 * never dead-ends. Each is replaced as its phase lands.
 */
function placeholderRoutes() {
  const routes: Array<{ path: string; label: string; status: string }> = [];

  for (const section of NAV) {
    for (const item of section.items) {
      const leaves = item.children ?? [item];
      for (const leaf of leaves) {
        if (leaf.path === '/') continue;
        routes.push({ path: leaf.path, label: leaf.label, status: leaf.status });
      }
    }
  }

  // De-duplicate: a parent and its first child can share a path.
  const seen = new Set<string>();

  return routes
    .filter((r) => !seen.has(r.path) && seen.add(r.path))
    .map((r) => {
      const Implemented = IMPLEMENTED[r.path];

      return (
        <Route
          key={r.path}
          path={r.path}
          element={
            Implemented ? <Implemented /> : <NotBuiltPage title={r.label} status={r.status} />
          }
        />
      );
    });
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />

            {/*
              Print routes sit OUTSIDE the app shell: no sidebar or header, so
              the page prints as the document alone. Still behind auth.
            */}
            <Route
              path="/print/:kind/:id"
              element={
                <RequireAuth>
                  <PrintDocumentPage />
                </RequireAuth>
              }
            />

            <Route
              element={
                <RequireAuth>
                  <AppShell />
                </RequireAuth>
              }
            >
              <Route index element={<DashboardPage />} />
              {placeholderRoutes()}
              <Route path="*" element={<NotBuiltPage title="Page not found" status="new" />} />
            </Route>
          </Routes>

          <Toaster position="top-right" richColors closeButton />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
