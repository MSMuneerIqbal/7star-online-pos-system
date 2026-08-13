/**
 * Kysely table types.
 *
 * Hand-written and kept in step with `migrations/`, which is the source of
 * truth for the schema. `npm run db:types` can regenerate them from a live
 * database if the two ever drift.
 *
 * CONVENTION: `numeric` columns are typed `string`, never `number`. See money.ts.
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** A numeric(18,2) / numeric(18,3) column — string in, string out. */
type Numeric = ColumnType<string, string | number, string | number>;

/** timestamptz managed by the DB default on insert. */
type CreatedAt = ColumnType<Date, Date | string | undefined, Date | string>;

/**
 * A column with a database DEFAULT: always present when read, optional on
 * insert. Distinct from `Generated<T>`, which is for identity columns the
 * application should not normally supply.
 */
type Defaulted<T> = ColumnType<T, T | undefined, T>;

// ---------------------------------------------------------------------------
// Organisation
// ---------------------------------------------------------------------------

export type BranchType = 'BRANCH' | 'WAREHOUSE';

export interface BranchTable {
  id: Generated<number>;
  name: string;
  /**
   * Prefixes every document this branch issues — `MUL-1`, `MUL-DP-1`.
   * Immutable once used. Null only on branch 0, the "All Branches" sentinel,
   * which never issues a document.
   */
  code: string | null;
  /** Exactly one branch is the WAREHOUSE, enforced by a partial unique index. */
  type: Defaulted<BranchType>;
  address: string | null;
  phone: string | null;
  opening_hours: string | null;
  closing_day: string | null;
  /** Deactivating hides a branch without deleting its history. */
  is_active: Defaulted<boolean>;
  longitude: Numeric;
  latitude: Numeric;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

// ---------------------------------------------------------------------------
// Auth & RBAC
// ---------------------------------------------------------------------------

export interface UserLoginsTable {
  id: Generated<number>;
  username: string;
  /** argon2id hash. The legacy system stored this in plaintext. */
  password_hash: string;
  role_id: number | null;
  /** 0 == super admin (bypasses every permission check). */
  emp_id: number;
  branch_id: number;
  is_active: boolean;
  last_login_at: Date | null;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

export interface RoleTable {
  id: Generated<number>;
  name: string;
  branch_id: number;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

export interface EmployeeTable {
  id: Generated<number>;
  first_name: string;
  last_name: string | null;
  phone: string | null;
  mobile: string | null;
  cnic: string | null;
  gender: string | null;
  code: string | null;
  img: string | null;
  city: string | null;
  province: string | null;
  basic_salary: Numeric;
  branch_id: number;
  /** Salary-expense account, so payroll can be posted against the employee. */
  account_no: number;
  dob: ColumnType<string, string | null, string | null> | null;
  join_date: ColumnType<string, string | null, string | null> | null;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: Defaulted<number>;
  updated_by: Defaulted<number>;
}

/**
 * The permission tree. head -> form -> action.
 *
 * The ids are structural: screens and buttons are gated on specific numbers, so
 * they are seeded by migration rather than generated. `legacy-permissions.json`
 * records what the original system required, and
 * `scripts/verify-permissions.ts` checks the database still satisfies it.
 */
export interface FormHeadTable {
  head_id: Generated<number>;
  head_name: string;
  code: number;
  sr: number;
}

export interface FormTable {
  id: Generated<number>;
  head_id: number;
  form_name: string;
  sub: string | null;
  sr: number;
  ids: number;
  form_code: number;
}

export interface FormsActionTable {
  id: Generated<number>;
  form_id: number;
  action_name: string;
  sr: number;
  action_code: number;
}

export interface RoleAssignTable {
  id: Generated<number>;
  role_id: number;
  head_id: number;
  form_id: number;
  action_id: number;
  branch_id: number;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

export interface RefreshTokenTable {
  id: Generated<string>;
  user_id: number;
  /** SHA-256 of the token; the raw token is never stored. */
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: CreatedAt;
  user_agent: string | null;
  ip: string | null;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface UserLogTable {
  id: Generated<string>;
  inv_id: number | null;
  branch_id: number;
  user_id: number;
  username: string | null;
  form: string | null;
  action: string | null;
  detail: string | null;
  datetime: CreatedAt;
}

// ---------------------------------------------------------------------------
// Accounting core (phase 2)
// ---------------------------------------------------------------------------

export interface AccountHeadTable {
  id: Generated<number>;
  name: string;
  code: number;
}

export interface AccountTable {
  id: Generated<number>;
  name: string | null;
  /** The composed posting code, e.g. 1010402. This is what transactions reference. */
  account_id: number;
  head_id: number;
  sub_head_id: number;
  head_code: number;
  sub_code: number;
  third: Defaulted<number>;
  third_code: Defaulted<number>;
  com_id: Defaulted<number>;
  branch_id: Defaulted<number>;
  is_fixed: Defaulted<boolean>;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: Defaulted<number>;
  updated_by: Defaulted<number>;
}

export interface AccountSubHeadTable {
  id: Generated<number>;
  name: string;
  code: number;
  head_code: number;
  head_id: number;
  branch_id: number;
  is_fixed: boolean;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

/** Optional third grouping level between sub-head and account. */
export interface AccountThirdTable {
  id: Generated<number>;
  name: string | null;
  account_id: number;
  head_id: number;
  sub_head_id: number;
  head_code: number;
  sub_head_code: number;
  branch_id: number;
  is_fixed: boolean;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

export interface VoucherMasterTable {
  id: Generated<number>;
  date: ColumnType<string, string, string>;
  /** Groups the voucher's legs — mirrors transactions.trans_id. */
  tran_id: number;
  branch_id: number;
  inv_id: number;
  account_id: number;
  amount: Numeric;
  amount1: Numeric;
  type: string | null;
  detail: string | null;
  vno: string | null;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

export interface VoucherDetailTable {
  id: Generated<number>;
  trans_id: number;
  inv_id: number;
  account_id: number;
  detail: string | null;
  vtype: string | null;
  cheque_status: string | null;
  acc_name: string | null;
  cheque_date: ColumnType<string, string, string> | null;
  cheque_no: string | null;
  dr: Numeric;
  cr: Numeric;
}

export interface AccountOpeningTable {
  id: Generated<number>;
  account_id: number;
  branch_id: number;
  user_id: number;
  date: ColumnType<string, string, string>;
  dr: Numeric;
  cr: Numeric;
  detail: string | null;
}

/**
 * The general ledger.
 *
 * Legacy column order, recovered from positional INSERTs and confirmed by the
 * explicit column list in PurchaseController.cs:117 — the ETL must map by this
 * order, NOT by the C# model property order, which differs:
 *   date, datetime, inv_id, vtype, dr, cr, account_id, detail, voucher_no,
 *   trans_id, branch_id
 *
 * `trans_id` groups the legs of one voucher and MUST net to zero.
 */
export interface TransactionsTable {
  id: Generated<string>;
  date: ColumnType<string, string, string>;
  datetime: CreatedAt;
  inv_id: number;
  vtype: string;
  dr: Numeric;
  cr: Numeric;
  account_id: number;
  detail: string | null;
  voucher_no: number;
  trans_id: number;
  branch_id: number;
}

// ---------------------------------------------------------------------------
// Catalog & parties (phase 4/5)
// ---------------------------------------------------------------------------

export interface BrandTable {
  id: Generated<number>;
  name: string | null;
  other_name: string | null;
  company_id: Defaulted<number>;
  branch_id: Defaulted<number>;
  /** Marks a brand as belonging to the raw-materials catalog. */
  is_raw: Defaulted<boolean>;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: Defaulted<number>;
  updated_by: Defaulted<number>;
}

/** Legacy table name was misspelled "Catagory"; renamed in the rewrite. */
export interface CategoryTable {
  id: Generated<number>;
  name: string | null;
  other_name: string | null;
  image_path: string | null;
  company_id: Defaulted<number>;
  branch_id: Defaulted<number>;
  is_raw: Defaulted<boolean>;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: Defaulted<number>;
  updated_by: Defaulted<number>;
}

export type ProductType = 'NEW' | 'BRANDED' | 'CHARGER' | 'STORAGE' | 'OTHER';
export type ProductPlacement = 'INT' | 'EXT';

/**
 * The master catalog row — one per model, company-wide. Branch-specific
 * price, location and threshold live on `branch_product` instead (Phase 1,
 * the catalog split). Identity is model + brand + type + placement, matched
 * case-insensitively by `idx_product_identity`.
 */
export interface ProductTable {
  id: Generated<number>;
  name: string | null;
  other_name: string | null;
  /**
   * Company cost. Production cost for what the warehouse makes, purchase
   * cost for what it buys in. Never shown to a branch.
   */
  price: Numeric;
  open_qty: Numeric;
  company_id: number;
  brand_id: number | null;
  category_id: number | null;
  unit_of_measure: string | null;
  company_barcode: string | null;
  brand_discount: Numeric;
  /** A path under UPLOAD_DIR, not the file itself. No upload endpoint yet. */
  image_path: string | null;
  type: Defaulted<ProductType>;
  placement: Defaulted<ProductPlacement>;
  /** The suggested recipe. Pre-fills the production cart; never enforced. */
  cell_type_id: number | null;
  cell_count: number | null;
  is_active: boolean;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

/** One row per product per branch — price, location and threshold. */
export interface BranchProductTable {
  id: Generated<number>;
  branch_id: number;
  product_id: number;
  selling_price: Numeric;
  minimum_price: Numeric;
  /** Weighted average of what this branch has been charged. Written only by confirmed receipt (Phase 5) — never typed at the till. */
  wholesale_cost: Numeric;
  location: string | null;
  low_stock_threshold: Numeric;
  is_active: Defaulted<boolean>;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: Defaulted<number>;
  updated_by: Defaulted<number>;
}

export interface CustomerTable {
  id: Generated<number>;
  name: string | null;
  code: string | null;
  phone: string | null;
  mobile: string | null;
  address: string | null;
  email: string | null;
  cnic: string | null;
  province: string | null;
  city: string | null;
  is_active: boolean;
  branch_id: number;
  /** Receivable account code in the chart of accounts. */
  account_id: number;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

/** Walk-in customer details captured inline on a sale. */
export interface SaleCustomerTable {
  id: Generated<number>;
  name: string | null;
  phone: string | null;
  address: string | null;
  branch_id: number;
}

/** Single-row company profile. Supplies the header on every printed document. */
export interface SettingTable {
  id: Generated<number>;
  name: string | null;
  phone: string | null;
  address: string | null;
  email: string | null;
  image: string | null;
  delivery_charges: Numeric;
}

/** Raw materials. Purchases and production consume these, not `product`. */
export interface RawProductTable {
  id: Generated<number>;
  name: string | null;
  price: Numeric;
  reorder: Numeric;
  brand_id: number | null;
  cat_id: number | null;
  is_active: boolean;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

export interface SupplierTable {
  id: Generated<number>;
  name: string | null;
  code: string | null;
  branch_id: number;
  /** Payable account code. Legacy column name kept: `account_no`, not account_id. */
  account_no: number;
  contact_person: string | null;
  cnic: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  ntn: string | null;
  strn: string | null;
  city: string | null;
  company: string | null;
  is_active: boolean;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

// ---------------------------------------------------------------------------
// Purchases (phase 5)
// ---------------------------------------------------------------------------

export interface PurchaseTable {
  id: Generated<number>;
  date: ColumnType<string, string, string>;
  /** Branch-prefixed document number, e.g. `MUL-PI-1`. */
  doc_number: string;
  sup_id: number;
  branch_id: number;
  gross_total: Numeric;
  sub_total: Numeric;
  discount: Numeric;
  net_total: Numeric;
  paid: Numeric;
  /** Inward freight, capitalised into stock value. */
  rent: Numeric;
  remaining: Numeric;
  notes: string | null;
  inv_type: string;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

export interface PurchaseDetailTable {
  id: Generated<number>;
  purchase_id: number;
  pid: number;
  pname: string | null;
  price: Numeric;
  qty: Numeric;
  total: Numeric;
  discount: Numeric;
  net_total: Numeric;
}

// ---------------------------------------------------------------------------
// Sales (phase 5)
// ---------------------------------------------------------------------------

export interface SaleTable {
  id: Generated<number>;
  date: ColumnType<string, string, string>;
  /** Branch-prefixed document number, e.g. `MUL-1` (walk-in) or `MUL-C-1`. */
  doc_number: string;
  cust_id: number;
  sale_cust_id: number | null;
  branch_id: number;
  gross_total: Numeric;
  sub_total: Numeric;
  discount: Numeric;
  service: Numeric;
  net_total: Numeric;
  received: Numeric;
  remaining: Numeric;
  notes: string | null;
  inv_type: string;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

export interface SaleDetailTable {
  id: Generated<number>;
  sale_id: number;
  pid: number;
  pname: string | null;
  price: Numeric;
  qty: Numeric;
  total: Numeric;
  discount: Numeric;
  net_total: Numeric;
}

// ---------------------------------------------------------------------------
// Returns and held sales (phase 5)
// ---------------------------------------------------------------------------

export interface SaleReturnTable {
  id: Generated<number>;
  date: ColumnType<string, string, string>;
  /** Branch-prefixed document number, e.g. `MUL-SR-1`. */
  doc_number: string;
  /** Original invoice, when the return references one. */
  sale_id: number | null;
  cust_id: number;
  sale_cust_id: number | null;
  branch_id: number;
  gross_total: Numeric;
  sub_total: Numeric;
  discount: Numeric;
  service: Numeric;
  net_total: Numeric;
  /** Cash refunded to the customer. */
  paid: Numeric;
  remaining: Numeric;
  notes: string | null;
  inv_type: string;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

export interface SaleReturnDetailTable {
  id: Generated<number>;
  /** Legacy column name: `sale_id`, referencing sale_return(id). */
  sale_id: number;
  pid: number;
  pname: string | null;
  price: Numeric;
  qty: Numeric;
  total: Numeric;
  discount: Numeric;
  net_total: Numeric;
}

export interface PurchaseReturnTable {
  id: Generated<number>;
  date: ColumnType<string, string, string>;
  /** Branch-prefixed document number, e.g. `MUL-PR-1`. */
  doc_number: string;
  sup_id: number;
  branch_id: number;
  gross_total: Numeric;
  sub_total: Numeric;
  discount: Numeric;
  net_total: Numeric;
  /** Cash refunded by the supplier. */
  received: Numeric;
  rent: Numeric;
  remaining: Numeric;
  notes: string | null;
  inv_type: string;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

export interface PurchaseReturnDetailTable {
  id: Generated<number>;
  /** Legacy column name: `purchase_id`, referencing purchase_return(id). */
  purchase_id: number;
  pid: number;
  pname: string | null;
  price: Numeric;
  qty: Numeric;
  total: Numeric;
  discount: Numeric;
  net_total: Numeric;
}

/**
 * Hold Sale — a parked basket. No ledger impact: nothing is sold until it is
 * converted into a real sale.
 */
export interface HoldSaleTable {
  id: Generated<number>;
  date: ColumnType<string, string, string>;
  /** Branch-prefixed document number, e.g. `MUL-H-1`. */
  doc_number: string;
  branch_id: number;
  cust_id: number;
  status: string | null;
  note: string | null;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: number;
  updated_by: number;
}

export interface HoldSaleDetailTable {
  id: Generated<number>;
  sale_id: number;
  pid: number;
  pname: string | null;
  status: string | null;
  qty: Numeric;
}

// ---------------------------------------------------------------------------
// Demand order / inter-branch transfer (phase 7)
//
// One set of tables serves both the raw and finished chains; `type` holds the
// stock kind. The legacy system had ten controllers over these same six tables.
// ---------------------------------------------------------------------------

export interface DemandOrderTable {
  id: Generated<number>;
  date: ColumnType<string, string, string>;
  /** Branch-prefixed document number against the requesting branch, e.g. `MUL-DO-1`. */
  doc_number: string;
  from_branch: number;
  to_branch: number;
  /** 'RAW' | 'FINISH' */
  type: string | null;
  status: string | null;
  note: string | null;
  gross: Numeric;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: Defaulted<number>;
  updated_by: Defaulted<number>;
}

export interface DemandOrderDetailTable {
  id: Generated<number>;
  inv_id: number;
  pid: number;
  pname: string | null;
  qty: Numeric;
  /** Quantity actually fulfilled against this line. */
  inv_qty: Numeric;
  price: Numeric;
  total: Numeric;
  status: string | null;
}

export interface DoRequestTable {
  id: Generated<number>;
  /** The demand order being fulfilled, when there is one. */
  do_id: number | null;
  from_branch: number;
  to_branch: number;
  date: ColumnType<string, string, string>;
  note: string | null;
  type: string | null;
  status: string | null;
  is_req: Defaulted<boolean>;
  gross: Numeric;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: Defaulted<number>;
  updated_by: Defaulted<number>;
}

export interface DoRequestDetailTable {
  id: Generated<number>;
  inv_id: number;
  pid: number;
  pname: string | null;
  qty: Numeric;
  inv_qty: Numeric;
  price: Numeric;
  total: Numeric;
  status: string | null;
}

export interface DoReceivedTable {
  id: Generated<number>;
  do_req_id: number | null;
  from_branch: number;
  to_branch: number;
  date: ColumnType<string, string, string>;
  note: string | null;
  type: string | null;
  received_by: string | null;
  /** Freight paid on arrival. Expensed, not capitalised — see rules/transfer.ts. */
  cargo_expense: Numeric;
  gross: Numeric;
  net: Numeric;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: Defaulted<number>;
  updated_by: Defaulted<number>;
}

export interface DoReceivedDetailTable {
  id: Generated<number>;
  inv_id: number;
  pid: number;
  pname: string | null;
  qty: Numeric;
  price: Numeric;
  total: Numeric;
}

// ---------------------------------------------------------------------------
// Production (phase 8)
// ---------------------------------------------------------------------------

export interface ProductionTable {
  id: Generated<number>;
  date: ColumnType<string, string, string>;
  /** Branch-prefixed document number, e.g. `MUL-PRD-1`. */
  doc_number: string;
  branch_id: number;
  /** The finished product being made. */
  pid: number;
  qty: number;
  note: string | null;
  labor_cost: Numeric;
  electric_cost: Numeric;
  other_cost: Numeric;
  /** Derived from the consumed raw materials at catalog cost. */
  material_cost: Numeric;
  extra: Numeric;
  extra1: Numeric;
  /** total_cost / qty — becomes the finished product's carrying value. */
  per_unit: Numeric;
  total_cost: Numeric;
  gross_total: Numeric;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: Defaulted<number>;
  updated_by: Defaulted<number>;
}

export interface ProductionDetailTable {
  id: Generated<number>;
  inv_id: number;
  /** Raw material consumed. */
  pid: number;
  pname: string | null;
  price: Numeric;
  qty: Numeric;
  total: Numeric;
}

// ---------------------------------------------------------------------------
// Lab — battery repair and servicing (phase 8)
// ---------------------------------------------------------------------------

/** Items accepted for repair. The goods belong to the customer, not the business. */
export interface LabReceivedTable {
  id: Generated<number>;
  date: ColumnType<string, string, string>;
  /** Branch-prefixed intake ticket number, e.g. `MUL-LR-1`. */
  doc_number: string;
  cust_id: number;
  branch_id: number;
  note: string | null;
  status: string | null;
  gross: Numeric;
  other: Numeric;
  net: Numeric;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: Defaulted<number>;
  updated_by: Defaulted<number>;
}

export interface LabReceivedDetailTable {
  id: Generated<number>;
  inv_id: number;
  /** 0 — a customer's own battery is not a catalog item. */
  pid: number;
  pname: string | null;
  status: string | null;
  qty: Numeric;
  price: Numeric;
  ready: ColumnType<string, string | null, string | null> | null;
  total: Numeric;
  detail: string | null;
}

/** The invoice for completed lab work. */
export interface LabTable {
  id: Generated<number>;
  date: ColumnType<string, string, string>;
  /** Branch-prefixed document number, e.g. `MUL-LB-1`. */
  doc_number: string;
  /** The intake this bills. */
  lab_id: number | null;
  branch_id: number;
  cust_id: number;
  gross: Numeric;
  received: Numeric;
  remaining: Numeric;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  created_by: Defaulted<number>;
  updated_by: Defaulted<number>;
}

export interface LabDetailTable {
  id: Generated<number>;
  inv_id: number;
  pid: number;
  pname: string | null;
  price: Numeric;
  qty: Numeric;
  total: Numeric;
}

/** Raw materials consumed on a lab job. */
export interface LabUsedTable {
  id: Generated<number>;
  inv_id: number;
  bid: number;
  pid: number;
  pname: string | null;
  date: ColumnType<string, string, string>;
  price: Numeric;
  qty: Numeric;
  total: Numeric;
}

// ---------------------------------------------------------------------------
// Document numbering (phase 2)
// ---------------------------------------------------------------------------

/** One row per real branch × doc type; the sequence a document number draws from. */
export interface DocumentCounterTable {
  branch_id: number;
  doc_type: string;
  next_number: number;
  updated_at: CreatedAt;
}

/** A successful sign-in. Successes only — see migration 1700000000016. */
export interface LoginHistoryTable {
  /** bigint identity — read as a string like user_log.id. */
  id: Generated<string>;
  user_id: number;
  username: string;
  branch_id: number;
  ip: string | null;
  user_agent: string | null;
  at: CreatedAt;
}

// ---------------------------------------------------------------------------

export interface Database {
  branch: BranchTable;
  employee: EmployeeTable;
  document_counter: DocumentCounterTable;
  brand: BrandTable;
  category: CategoryTable;
  product: ProductTable;
  branch_product: BranchProductTable;
  customer: CustomerTable;
  sale_customer: SaleCustomerTable;
  sale: SaleTable;
  sale_detail: SaleDetailTable;
  raw_product: RawProductTable;
  supplier: SupplierTable;
  purchase: PurchaseTable;
  purchase_detail: PurchaseDetailTable;
  sale_return: SaleReturnTable;
  sale_return_detail: SaleReturnDetailTable;
  purchase_return: PurchaseReturnTable;
  purchase_return_detail: PurchaseReturnDetailTable;
  hold_sale: HoldSaleTable;
  hold_sale_detail: HoldSaleDetailTable;
  demand_order: DemandOrderTable;
  demand_order_detail: DemandOrderDetailTable;
  do_request: DoRequestTable;
  do_request_detail: DoRequestDetailTable;
  do_received: DoReceivedTable;
  do_received_detail: DoReceivedDetailTable;
  production: ProductionTable;
  production_detail: ProductionDetailTable;
  lab_received: LabReceivedTable;
  lab_received_detail: LabReceivedDetailTable;
  lab: LabTable;
  lab_detail: LabDetailTable;
  lab_used: LabUsedTable;
  setting: SettingTable;
  user_logins: UserLoginsTable;
  login_history: LoginHistoryTable;
  role: RoleTable;
  form_head: FormHeadTable;
  form: FormTable;
  forms_action: FormsActionTable;
  role_assign: RoleAssignTable;
  refresh_token: RefreshTokenTable;
  user_log: UserLogTable;
  account_head: AccountHeadTable;
  account_sub_head: AccountSubHeadTable;
  account_third: AccountThirdTable;
  account: AccountTable;
  account_opening: AccountOpeningTable;
  voucher_master: VoucherMasterTable;
  voucher_detail: VoucherDetailTable;
  transactions: TransactionsTable;
}

export type Branch = Selectable<BranchTable>;
export type UserLogin = Selectable<UserLoginsTable>;
export type NewUserLogin = Insertable<UserLoginsTable>;
export type UserLoginUpdate = Updateable<UserLoginsTable>;
export type RoleAssignment = Selectable<RoleAssignTable>;
export type Transaction = Selectable<TransactionsTable>;
export type NewTransaction = Insertable<TransactionsTable>;
export type Account = Selectable<AccountTable>;
export type Product = Selectable<ProductTable>;
export type BranchProduct = Selectable<BranchProductTable>;
export type Customer = Selectable<CustomerTable>;
export type Sale = Selectable<SaleTable>;
export type SaleDetail = Selectable<SaleDetailTable>;
export type NewSaleDetail = Insertable<SaleDetailTable>;
export type Purchase = Selectable<PurchaseTable>;
export type PurchaseDetail = Selectable<PurchaseDetailTable>;
export type Supplier = Selectable<SupplierTable>;
export type RawProduct = Selectable<RawProductTable>;
export type Setting = Selectable<SettingTable>;
