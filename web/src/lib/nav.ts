/**
 * Navigation + permission map.
 *
 * Every id here was extracted verbatim from the legacy Views/Shared/_Layout.cshtml
 * so existing `role_assign` rows keep granting exactly what they granted before.
 * Do not renumber without migrating that table.
 *
 * `status` marks whether the screen is built. Every entry is now 'ported' —
 * including the ten reports the legacy sidebar linked but never implemented,
 * and the Lab Invoice screen that was a stub there.
 *
 *   'ported' — built and working
 *   'stub'   — partially built; the badge warns the operator
 *   'new'    — not built yet; the badge warns the operator
 *
 * Keep these honest: the badge is what tells someone a menu item will not do
 * what they expect.
 */

export type FeatureStatus = 'ported' | 'stub' | 'new';

export interface NavItem {
  label: string;
  path: string;
  /** Gate on a form id alone (legacy HasForm). */
  formId?: number;
  /** Gate on a form + action pair (legacy HasAction). */
  action?: readonly [formId: number, actionId: number];
  status: FeatureStatus;
  children?: readonly NavItem[];
}

export interface NavSection {
  /** Legacy HasHead id. Undefined means always visible. */
  headId?: number;
  title?: string;
  items: readonly NavItem[];
}

export const NAV: readonly NavSection[] = [
  {
    title: 'Main Menu',
    items: [{ label: 'Dashboard', path: '/', formId: 1, status: 'ported' }],
  },

  {
    headId: 2,
    title: 'Registration',
    items: [
      { label: 'Branch', path: '/branches', formId: 2, status: 'ported' },
      { label: 'Brand', path: '/brands', formId: 3, status: 'ported' },
      { label: 'Category', path: '/categories', formId: 4, status: 'ported' },
      { label: 'Raw Item', path: '/raw-products', formId: 5, status: 'ported' },
      { label: 'Finish Product', path: '/products', formId: 6, status: 'ported' },
      { label: 'Customer', path: '/customers', formId: 7, status: 'ported' },
      { label: 'Vendor', path: '/suppliers', formId: 8, status: 'ported' },
      { label: 'Employee', path: '/employees', formId: 9, status: 'ported' },
    ],
  },

  {
    headId: 12,
    title: 'Branch Catalog',
    items: [
      { label: 'My Prices', path: '/branch-products', action: [53, 12011], status: 'ported' },
    ],
  },

  {
    headId: 3,
    title: 'Purchase',
    items: [
      { label: 'Purchase', path: '/purchases', action: [10, 3011], status: 'ported' },
      { label: 'Purchase Return', path: '/purchase-returns', action: [11, 3021], status: 'ported' },
    ],
  },

  {
    headId: 4,
    title: 'Sale',
    items: [
      { label: 'Sale', path: '/sales', action: [12, 4011], status: 'ported' },
      { label: 'Sale Return', path: '/sale-returns', action: [13, 4021], status: 'ported' },
      { label: 'Hold Sale', path: '/hold-sales', action: [51, 4031], status: 'ported' },
    ],
  },

  {
    headId: 5,
    title: 'Demand Order',
    items: [
      {
        label: "Raw Item's",
        path: '/demand-orders/raw',
        status: 'ported',
        children: [
          { label: 'Demand Order', path: '/demand-orders/raw', action: [17, 5011], status: 'ported' },
          { label: 'DO Request', path: '/demand-orders/raw/requests', action: [18, 5021], status: 'ported' },
          // NOTE: the legacy parent conditional tested HasAction(19, 5071) while
          // the item tested HasAction(39, 5071) — a form-id typo. 39 is correct.
          { label: 'Branch Transfer', path: '/demand-orders/raw/transfers', action: [39, 5071], status: 'ported' },
          { label: 'Receiving Request', path: '/demand-orders/raw/receiving', action: [19, 5031], status: 'ported' },
          { label: 'DO Received', path: '/demand-orders/raw/received', action: [41, 5091], status: 'ported' },
        ],
      },
      {
        label: "Finish Item's",
        path: '/demand-orders/finish',
        status: 'ported',
        children: [
          { label: 'Demand Order', path: '/demand-orders/finish', action: [20, 5041], status: 'ported' },
          { label: 'DO Request', path: '/demand-orders/finish/requests', action: [21, 5051], status: 'ported' },
          { label: 'Branch Transfer', path: '/demand-orders/finish/transfers', action: [40, 5081], status: 'ported' },
          { label: 'Receiving Request', path: '/demand-orders/finish/receiving', action: [22, 5061], status: 'ported' },
          { label: 'DO Received', path: '/demand-orders/finish/received', action: [49, 5101], status: 'ported' },
        ],
      },
      { label: 'Remittance', path: '/remittances', action: [55, 5111], status: 'ported' },
    ],
  },

  {
    headId: 10,
    title: 'Production',
    items: [{ label: 'Production', path: '/production', action: [47, 10011], status: 'ported' }],
  },

  {
    headId: 11,
    title: 'Lab',
    items: [
      // Own form id since migration 1700000000007 — it used to share [49, 5101]
      // with DO Finish Received, so one grant opened both screens.
      { label: 'Lab Receiving', path: '/lab/receiving', action: [52, 5211], status: 'ported' },
      { label: 'Lab Invoices', path: '/lab/invoices', action: [50, 5201], status: 'ported' },
    ],
  },

  {
    headId: 6,
    title: 'Reports',
    items: [
      {
        label: 'Raw Material',
        path: '/reports/raw',
        status: 'ported',
        children: [
          { label: 'Stock Report', path: '/reports/raw/stock', action: [31, 6011], status: 'ported' },
          { label: 'Item Ledger', path: '/reports/raw/ledger', action: [32, 6021], status: 'ported' },
        ],
      },
      {
        label: 'Finish Material',
        path: '/reports/finish',
        status: 'ported',
        children: [
          { label: 'Stock Report', path: '/reports/finish/stock', action: [33, 6031], status: 'ported' },
          { label: 'Item Ledger', path: '/reports/finish/ledger', action: [34, 6041], status: 'ported' },
        ],
      },
      { label: 'Sale Report', path: '/reports/sales', action: [35, 6051], status: 'ported' },
      { label: 'Purchase Report', path: '/reports/purchases', action: [36, 6061], status: 'ported' },
      { label: 'Customer Statement', path: '/customers/statement', formId: 7, status: 'ported' },
    ],
  },

  {
    headId: 7,
    title: 'Accounts',
    items: [
      {
        label: 'Account Registration',
        path: '/accounts/chart',
        status: 'ported',
        children: [
          { label: 'First Level', path: '/accounts/chart/first', action: [23, 7011], status: 'ported' },
          { label: 'Second Level', path: '/accounts/chart/second', action: [24, 7021], status: 'ported' },
          { label: 'Final Account', path: '/accounts/chart/final', action: [25, 7031], status: 'ported' },
        ],
      },
      {
        label: 'Vouchers',
        path: '/vouchers',
        status: 'ported',
        children: [
          { label: 'Bank Payment (BPV)', path: '/vouchers/bank-payment', action: [45, 7121], status: 'ported' },
          { label: 'Bank Receipt (BRV)', path: '/vouchers/bank-receipt', action: [44, 7111], status: 'ported' },
          { label: 'Cash Payment (CPV)', path: '/vouchers/cash-payment', action: [43, 7101], status: 'ported' },
          { label: 'Cash Receipt (CRV)', path: '/vouchers/cash-receipt', action: [42, 7091], status: 'ported' },
          { label: 'Journal Voucher (JV)', path: '/vouchers/journal', action: [46, 7131], status: 'ported' },
        ],
      },
      {
        label: 'Ledger Reports',
        path: '/ledger',
        status: 'ported',
        children: [
          { label: 'Account Ledger', path: '/ledger', action: [26, 7041], status: 'ported' },
          { label: 'Cash Book', path: '/ledger/cash-book', action: [27, 7051], status: 'ported' },
        ],
      },
      {
        label: 'Financial Reports',
        path: '/financials',
        status: 'ported',
        children: [
          { label: 'Trial Balance', path: '/financials/trial-balance', action: [28, 7061], status: 'ported' },
          { label: 'Income Statement', path: '/financials/income-statement', action: [29, 7071], status: 'ported' },
          { label: 'Balance Sheet', path: '/financials/balance-sheet', action: [30, 7081], status: 'ported' },
        ],
      },
    ],
  },

  {
    headId: 8,
    title: 'User Management',
    items: [
      { label: 'User Roles', path: '/users/roles', action: [14, 8011], status: 'ported' },
      { label: 'Role Assignment', path: '/users/role-assign', action: [15, 8021], status: 'ported' },
      { label: 'User Logins', path: '/users/logins', action: [16, 8031], status: 'ported' },
      { label: 'User Logs', path: '/users/logs', action: [38, 8041], status: 'ported' },
      { label: 'Login History', path: '/users/login-history', action: [54, 8051], status: 'ported' },
    ],
  },

  {
    title: 'General Setting',
    items: [{ label: 'Setting', path: '/settings', action: [37, 9011], status: 'ported' }],
  },
] as const;
