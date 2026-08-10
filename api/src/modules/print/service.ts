/**
 * Print document loader.
 *
 * The legacy system had 13 separate Print actions, each assembling its own view
 * model from four or five queries. They all rendered the same shape: a company
 * header, a party block, line items and a totals block. This returns that one
 * shape for every document type, so the frontend needs a single print template
 * instead of thirteen.
 */
import { db } from '../../core/db/index.js';
import { notFound } from '../../core/errors.js';
import type { Principal } from '../../core/rbac.js';

export type PrintableKind = 'sale' | 'purchase' | 'sale-return' | 'purchase-return';

export interface PrintParty {
  name: string;
  phone: string | null;
  address: string | null;
}

export interface PrintLine {
  pname: string;
  qty: string;
  price: string;
  total: string;
  discount: string;
  netTotal: string;
}

export interface PrintTotal {
  label: string;
  value: string;
  /** Rendered prominently — the figure the reader is looking for. */
  emphasis?: boolean;
}

export interface PrintDocument {
  kind: PrintableKind;
  /** Shown as the document heading, e.g. "Sale Invoice". */
  title: string;
  number: number;
  date: string;
  company: {
    name: string;
    phone: string | null;
    address: string | null;
    email: string | null;
  };
  branch: { name: string; address: string | null };
  partyLabel: string;
  party: PrintParty;
  lines: PrintLine[];
  totals: PrintTotal[];
  notes: string | null;
}

const DEFAULT_COMPANY = {
  name: '7 Star Battery',
  phone: null,
  address: null,
  email: null,
};

async function loadCompany(): Promise<PrintDocument['company']> {
  const setting = await db
    .selectFrom('setting')
    .select(['name', 'phone', 'address', 'email'])
    .orderBy('id')
    .executeTakeFirst();

  if (!setting) return DEFAULT_COMPANY;

  return {
    name: setting.name ?? DEFAULT_COMPANY.name,
    phone: setting.phone,
    address: setting.address,
    email: setting.email,
  };
}

async function loadBranch(branchId: number): Promise<PrintDocument['branch']> {
  const branch = await db
    .selectFrom('branch')
    .select(['name', 'address'])
    .where('id', '=', branchId)
    .executeTakeFirst();

  return { name: branch?.name ?? '', address: branch?.address ?? null };
}

/**
 * Load a document for printing.
 *
 * Branch scoping applies exactly as it does to reading the record: another
 * branch's invoice is not printable, and reports as missing rather than
 * forbidden so the URL reveals nothing.
 */
export async function loadPrintDocument(
  principal: Principal,
  kind: PrintableKind,
  id: number,
): Promise<PrintDocument> {
  switch (kind) {
    case 'sale':
      return loadSale(principal, id);
    case 'purchase':
      return loadPurchase(principal, id);
    case 'sale-return':
      return loadSaleReturn(principal, id);
    case 'purchase-return':
      return loadPurchaseReturn(principal, id);
  }
}

async function loadSaleReturn(principal: Principal, id: number): Promise<PrintDocument> {
  const doc = await db
    .selectFrom('sale_return')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  if (!doc) throw notFound('Sale Return');
  if (!principal.isSuperAdmin && doc.branch_id !== principal.branchId) {
    throw notFound('Sale Return');
  }

  const [company, branch, lines, customer] = await Promise.all([
    loadCompany(),
    loadBranch(doc.branch_id),
    db
      .selectFrom('sale_return_detail')
      .selectAll()
      .where('sale_id', '=', id)
      .orderBy('id')
      .execute(),
    db
      .selectFrom('customer')
      .select(['name', 'phone', 'address'])
      .where('id', '=', doc.cust_id)
      .executeTakeFirst(),
  ]);

  return {
    kind: 'sale-return',
    // Reference the original invoice when the return was raised against one.
    title: doc.sale_id ? `Sale Return — against Invoice ${doc.sale_id}` : 'Sale Return',
    number: doc.id,
    date: doc.date,
    company,
    branch,
    partyLabel: 'Customer',
    party: {
      name: customer?.name ?? '',
      phone: customer?.phone ?? null,
      address: customer?.address ?? null,
    },
    lines: lines.map((l) => ({
      pname: l.pname ?? '',
      qty: l.qty,
      price: l.price,
      total: l.total,
      discount: l.discount,
      netTotal: l.net_total,
    })),
    totals: [
      { label: 'Gross Total', value: doc.gross_total },
      { label: 'Discount', value: doc.discount },
      { label: 'Credit Total', value: doc.net_total, emphasis: true },
      { label: 'Refunded', value: doc.paid },
      { label: 'Balance', value: doc.remaining, emphasis: true },
    ],
    notes: doc.notes,
  };
}

async function loadPurchaseReturn(principal: Principal, id: number): Promise<PrintDocument> {
  const doc = await db
    .selectFrom('purchase_return')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  if (!doc) throw notFound('Purchase Return');
  if (!principal.isSuperAdmin && doc.branch_id !== principal.branchId) {
    throw notFound('Purchase Return');
  }

  const [company, branch, lines, supplier] = await Promise.all([
    loadCompany(),
    loadBranch(doc.branch_id),
    db
      .selectFrom('purchase_return_detail')
      .selectAll()
      .where('purchase_id', '=', id)
      .orderBy('id')
      .execute(),
    db
      .selectFrom('supplier')
      .select(['name', 'phone', 'address'])
      .where('id', '=', doc.sup_id)
      .executeTakeFirst(),
  ]);

  const totals: PrintTotal[] = [
    { label: 'Sub Total', value: doc.sub_total },
    { label: 'Discount', value: doc.discount },
  ];

  if (Number(doc.rent) > 0) totals.push({ label: 'Freight', value: doc.rent });

  totals.push(
    { label: 'Credit Total', value: doc.net_total, emphasis: true },
    { label: 'Refunded', value: doc.received },
    { label: 'Balance', value: doc.remaining, emphasis: true },
  );

  return {
    kind: 'purchase-return',
    title: 'Purchase Return',
    number: doc.id,
    date: doc.date,
    company,
    branch,
    partyLabel: 'Supplier',
    party: {
      name: supplier?.name ?? '',
      phone: supplier?.phone ?? null,
      address: supplier?.address ?? null,
    },
    lines: lines.map((l) => ({
      pname: l.pname ?? '',
      qty: l.qty,
      price: l.price,
      total: l.total,
      discount: l.discount,
      netTotal: l.net_total,
    })),
    totals,
    notes: doc.notes,
  };
}

async function loadSale(principal: Principal, id: number): Promise<PrintDocument> {
  const sale = await db.selectFrom('sale').selectAll().where('id', '=', id).executeTakeFirst();

  if (!sale) throw notFound('Sale');
  if (!principal.isSuperAdmin && sale.branch_id !== principal.branchId) throw notFound('Sale');

  const [company, branch, lines, customer, walkIn] = await Promise.all([
    loadCompany(),
    loadBranch(sale.branch_id),
    db.selectFrom('sale_detail').selectAll().where('sale_id', '=', id).orderBy('id').execute(),
    db
      .selectFrom('customer')
      .select(['name', 'phone', 'address'])
      .where('id', '=', sale.cust_id)
      .executeTakeFirst(),
    sale.sale_cust_id
      ? db
          .selectFrom('sale_customer')
          .select(['name', 'phone', 'address'])
          .where('id', '=', sale.sale_cust_id)
          .executeTakeFirst()
      : Promise.resolve(undefined),
  ]);

  // A walk-in sale prints the captured details, not the generic "Walk-in
  // Customer" account record.
  const party: PrintParty = walkIn
    ? {
        name: walkIn.name ?? 'Cash Customer',
        phone: walkIn.phone,
        address: walkIn.address,
      }
    : {
        name: customer?.name ?? '',
        phone: customer?.phone ?? null,
        address: customer?.address ?? null,
      };

  const totals: PrintTotal[] = [
    { label: 'Gross Total', value: sale.gross_total },
    { label: 'Discount', value: sale.discount },
  ];

  if (Number(sale.service) > 0) totals.push({ label: 'Service Charges', value: sale.service });

  totals.push(
    { label: 'Net Total', value: sale.net_total, emphasis: true },
    { label: 'Received', value: sale.received },
    { label: 'Remaining', value: sale.remaining, emphasis: true },
  );

  return {
    kind: 'sale',
    title: 'Sale Invoice',
    number: sale.id,
    date: sale.date,
    company,
    branch,
    partyLabel: 'Customer',
    party,
    lines: lines.map((l) => ({
      pname: l.pname ?? '',
      qty: l.qty,
      price: l.price,
      total: l.total,
      discount: l.discount,
      netTotal: l.net_total,
    })),
    totals,
    notes: sale.notes,
  };
}

async function loadPurchase(principal: Principal, id: number): Promise<PrintDocument> {
  const purchase = await db
    .selectFrom('purchase')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  if (!purchase) throw notFound('Purchase');
  if (!principal.isSuperAdmin && purchase.branch_id !== principal.branchId) {
    throw notFound('Purchase');
  }

  const [company, branch, lines, supplier] = await Promise.all([
    loadCompany(),
    loadBranch(purchase.branch_id),
    db
      .selectFrom('purchase_detail')
      .selectAll()
      .where('purchase_id', '=', id)
      .orderBy('id')
      .execute(),
    db
      .selectFrom('supplier')
      .select(['name', 'phone', 'address'])
      .where('id', '=', purchase.sup_id)
      .executeTakeFirst(),
  ]);

  const totals: PrintTotal[] = [
    { label: 'Sub Total', value: purchase.sub_total },
    { label: 'Discount', value: purchase.discount },
  ];

  if (Number(purchase.rent) > 0) totals.push({ label: 'Freight', value: purchase.rent });

  totals.push(
    { label: 'Net Total', value: purchase.net_total, emphasis: true },
    { label: 'Paid', value: purchase.paid },
    { label: 'Remaining', value: purchase.remaining, emphasis: true },
  );

  return {
    kind: 'purchase',
    title: 'Purchase Invoice',
    number: purchase.id,
    date: purchase.date,
    company,
    branch,
    partyLabel: 'Supplier',
    party: {
      name: supplier?.name ?? '',
      phone: supplier?.phone ?? null,
      address: supplier?.address ?? null,
    },
    lines: lines.map((l) => ({
      pname: l.pname ?? '',
      qty: l.qty,
      price: l.price,
      total: l.total,
      discount: l.discount,
      netTotal: l.net_total,
    })),
    totals,
    notes: purchase.notes,
  };
}
