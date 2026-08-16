/**
 * Parties — Customer, Vendor and Employee.
 *
 * These differ from the catalog screens in one important way: creating a party
 * mints a chart-of-accounts code for it, because every sale, purchase and
 * payroll entry posts against that code. "You never create these by hand — add
 * the customer, and the account appears" (PRINCIPLES §13).
 *
 * Allocation goes through `allocateAccountCode`, which takes a
 * transaction-scoped advisory lock. The legacy `MAX(AccountId)+1` raced, and two
 * parties created at the same moment could end up sharing a ledger.
 *
 * `routes.ts` owns the Zod schemas; the work is here. Every write takes an
 * optional trailing `tx` (PLAN ground rule 4a).
 */
import { db, inTransaction, type Tx } from '../../core/db/index.js';
import { notFound, unprocessable } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { resolveBranchId, type Principal } from '../../core/rbac.js';
import { likeTerm, offset, paged, type ListQuery } from '../../core/crud.js';
import { allocateAccountCode, type AccountBucket } from '../accounts/service.js';

export type PartyKind = 'customer' | 'supplier' | 'employee';

/**
 * Where each party type's account codes live.
 *
 * Verified against the legacy allocation bases in CustomerController.cs:31,
 * SupplierController.cs:36 and EmployeeController.cs:33.
 */
const BUCKET: Record<PartyKind, AccountBucket & { headCodeId: number }> = {
  customer: { headCode: 1, subCode: 1, thirdCode: 2, headCodeId: 1 }, // 1010200+
  supplier: { headCode: 2, subCode: 1, thirdCode: 1, headCodeId: 2 }, // 2010100+
  employee: { headCode: 5, subCode: 2, thirdCode: 1, headCodeId: 5 }, // 5020100+
};

/**
 * Create the `account` row for a new party.
 *
 * The sub-head is resolved from whatever chart is actually loaded rather than
 * hard-coded, so extending or reorganising the chart does not break party
 * creation.
 */
export async function mintPartyAccount(
  tx: Tx,
  kind: PartyKind,
  name: string,
  branchId: number,
  createdBy: number,
): Promise<number> {
  const bucket = BUCKET[kind];

  const head = await tx
    .selectFrom('account_head')
    .select('id')
    .where('code', '=', bucket.headCodeId)
    .executeTakeFirst();

  if (!head) {
    throw unprocessable(
      `Account head ${bucket.headCodeId} is missing from the chart of accounts, ` +
        `so a ${kind} account cannot be created. Load the chart first.`,
    );
  }

  const subHead = await tx
    .selectFrom('account_sub_head')
    .select('id')
    .where('head_id', '=', head.id)
    .orderBy('code')
    .executeTakeFirst();

  if (!subHead) {
    throw unprocessable(
      `Account head ${bucket.headCodeId} has no sub-heads, so a ${kind} account cannot be created.`,
    );
  }

  const accountId = await allocateAccountCode(tx, bucket);

  await tx
    .insertInto('account')
    .values({
      name,
      account_id: accountId,
      head_id: head.id,
      sub_head_id: subHead.id,
      head_code: bucket.headCode,
      sub_code: bucket.subCode,
      third_code: bucket.thirdCode,
      branch_id: branchId,
      is_fixed: false,
      created_by: createdBy,
      updated_by: createdBy,
    })
    .execute();

  return accountId;
}

/**
 * Keep the ledger account's label in step with the party's name.
 *
 * The account CODE never changes — historical entries point at it — but the
 * label should not go stale, or a statement names someone who was renamed years
 * ago (PRINCIPLES §13, system accounts: renameable, never renumberable).
 */
async function syncAccountName(
  tx: Tx,
  accountId: number | null,
  before: string | null,
  after: string | null,
): Promise<void> {
  if (accountId && before !== after && after) {
    await tx.updateTable('account').set({ name: after }).where('account_id', '=', accountId).execute();
  }
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

export interface CustomerInput {
  name: string;
  code?: string | null | undefined;
  phone?: string | null | undefined;
  mobile?: string | null | undefined;
  address?: string | null | undefined;
  email?: string | null | undefined;
  cnic?: string | null | undefined;
  city?: string | null | undefined;
  province?: string | null | undefined;
  /** Drives the aging buckets on the receivables report (SPECS §3.5). */
  settlementCycle?: 'WEEKLY' | 'MONTHLY' | null | undefined;
  creditLimit: string;
  isActive: boolean;
  branchId?: number | undefined;
}

export async function listCustomers(principal: Principal, q: ListQuery) {
  let base = db.selectFrom('customer');

  if (!principal.isSuperAdmin) base = base.where('branch_id', '=', principal.branchId);

  const term = likeTerm(q.search);
  if (term) {
    base = base.where((eb) =>
      eb.or([eb('name', 'ilike', term), eb('phone', 'ilike', term), eb('code', 'ilike', term)]),
    );
  }

  const [rows, count] = await Promise.all([
    base
      .select(['id', 'name', 'code', 'phone', 'mobile', 'address', 'city', 'account_id', 'is_active'])
      .orderBy('name')
      .limit(q.pageSize)
      .offset(offset(q))
      .execute(),
    base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
  ]);

  return paged(rows, Number(count.n), q);
}

function customerValues(input: CustomerInput) {
  return {
    name: input.name,
    code: input.code ?? null,
    phone: input.phone ?? null,
    mobile: input.mobile ?? null,
    address: input.address ?? null,
    email: input.email ?? null,
    cnic: input.cnic ?? null,
    city: input.city ?? null,
    province: input.province ?? null,
    settlement_cycle: input.settlementCycle ?? null,
    credit_limit: input.creditLimit,
    is_active: input.isActive,
  };
}

export async function createCustomer(principal: Principal, input: CustomerInput, outerTx?: Tx) {
  const branchId = resolveBranchId(principal, input.branchId);

  return inTransaction(outerTx, async (tx) => {
    const accountId = await mintPartyAccount(tx, 'customer', input.name, branchId, principal.empId);

    const created = await tx
      .insertInto('customer')
      .values({
        ...customerValues(input),
        branch_id: branchId,
        account_id: accountId,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAudit(
      principal,
      {
        form: 'Customer',
        action: 'New',
        detail: `Created customer: ${created.name}, account ${accountId}`,
        invId: created.id,
      },
      tx,
    );

    return created;
  });
}

export async function updateCustomer(
  principal: Principal,
  id: number,
  input: Omit<CustomerInput, 'branchId'>,
  outerTx?: Tx,
) {
  const existing = await (outerTx ?? db)
    .selectFrom('customer')
    .select(['id', 'name', 'account_id'])
    .where('id', '=', id)
    .executeTakeFirst();

  if (!existing) throw notFound('Customer');

  return inTransaction(outerTx, async (tx) => {
    const row = await tx
      .updateTable('customer')
      .set({
        ...customerValues(input as CustomerInput),
        updated_at: new Date(),
        updated_by: principal.empId,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await syncAccountName(tx, existing.account_id, existing.name, row.name);

    await writeAudit(
      principal,
      { form: 'Customer', action: 'Edit', detail: `Updated customer: ${row.name}`, invId: id },
      tx,
    );

    return row;
  });
}

// ---------------------------------------------------------------------------
// Vendor (supplier)
// ---------------------------------------------------------------------------

export interface SupplierInput {
  name: string;
  code?: string | null | undefined;
  company?: string | null | undefined;
  contactPerson?: string | null | undefined;
  phone?: string | null | undefined;
  email?: string | null | undefined;
  address?: string | null | undefined;
  cnic?: string | null | undefined;
  ntn?: string | null | undefined;
  strn?: string | null | undefined;
  city?: string | null | undefined;
  isActive: boolean;
  branchId?: number | undefined;
}

export async function listSuppliers(principal: Principal, q: ListQuery) {
  let base = db.selectFrom('supplier');

  if (!principal.isSuperAdmin) base = base.where('branch_id', '=', principal.branchId);

  const term = likeTerm(q.search);
  if (term) {
    base = base.where((eb) =>
      eb.or([eb('name', 'ilike', term), eb('phone', 'ilike', term), eb('company', 'ilike', term)]),
    );
  }

  const [rows, count] = await Promise.all([
    base
      .select([
        'id',
        'name',
        'code',
        'company',
        'contact_person',
        'phone',
        'city',
        'ntn',
        'account_no',
        'is_active',
      ])
      .orderBy('name')
      .limit(q.pageSize)
      .offset(offset(q))
      .execute(),
    base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
  ]);

  return paged(rows, Number(count.n), q);
}

function supplierValues(input: SupplierInput) {
  return {
    name: input.name,
    code: input.code ?? null,
    company: input.company ?? null,
    contact_person: input.contactPerson ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
    cnic: input.cnic ?? null,
    ntn: input.ntn ?? null,
    strn: input.strn ?? null,
    city: input.city ?? null,
    is_active: input.isActive,
  };
}

export async function createSupplier(principal: Principal, input: SupplierInput, outerTx?: Tx) {
  const branchId = resolveBranchId(principal, input.branchId);

  return inTransaction(outerTx, async (tx) => {
    const accountId = await mintPartyAccount(tx, 'supplier', input.name, branchId, principal.empId);

    const created = await tx
      .insertInto('supplier')
      .values({
        ...supplierValues(input),
        branch_id: branchId,
        account_no: accountId,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAudit(
      principal,
      {
        form: 'Vendor',
        action: 'New',
        detail: `Created vendor: ${created.name}, account ${accountId}`,
        invId: created.id,
      },
      tx,
    );

    return created;
  });
}

export async function updateSupplier(
  principal: Principal,
  id: number,
  input: Omit<SupplierInput, 'branchId'>,
  outerTx?: Tx,
) {
  const existing = await (outerTx ?? db)
    .selectFrom('supplier')
    .select(['id', 'name', 'account_no'])
    .where('id', '=', id)
    .executeTakeFirst();

  if (!existing) throw notFound('Vendor');

  return inTransaction(outerTx, async (tx) => {
    const row = await tx
      .updateTable('supplier')
      .set({
        ...supplierValues(input as SupplierInput),
        updated_at: new Date(),
        updated_by: principal.empId,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await syncAccountName(tx, existing.account_no, existing.name, row.name);

    await writeAudit(
      principal,
      { form: 'Vendor', action: 'Edit', detail: `Updated vendor: ${row.name}`, invId: id },
      tx,
    );

    return row;
  });
}

// ---------------------------------------------------------------------------
// Employee
// ---------------------------------------------------------------------------

export interface EmployeeInput {
  firstName: string;
  lastName?: string | null | undefined;
  code?: string | null | undefined;
  phone?: string | null | undefined;
  mobile?: string | null | undefined;
  cnic?: string | null | undefined;
  gender?: string | null | undefined;
  city?: string | null | undefined;
  province?: string | null | undefined;
  basicSalary: string;
  dob?: string | null | undefined;
  joinDate?: string | null | undefined;
  branchId?: number | undefined;
}

export async function listEmployees(principal: Principal, q: ListQuery) {
  let base = db.selectFrom('employee').leftJoin('branch', 'branch.id', 'employee.branch_id');

  if (!principal.isSuperAdmin) base = base.where('employee.branch_id', '=', principal.branchId);

  const term = likeTerm(q.search);
  if (term) {
    base = base.where((eb) =>
      eb.or([eb('employee.first_name', 'ilike', term), eb('employee.last_name', 'ilike', term)]),
    );
  }

  const [rows, count] = await Promise.all([
    base
      .select([
        'employee.id',
        'employee.first_name',
        'employee.last_name',
        'employee.code',
        'employee.phone',
        'employee.cnic',
        'employee.basic_salary',
        'employee.account_no',
        'employee.join_date',
        'branch.name as branch_name',
      ])
      .orderBy('employee.first_name')
      .limit(q.pageSize)
      .offset(offset(q))
      .execute(),
    base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
  ]);

  return paged(rows, Number(count.n), q);
}

export async function createEmployee(principal: Principal, input: EmployeeInput, outerTx?: Tx) {
  const branchId = resolveBranchId(principal, input.branchId);
  const fullName = [input.firstName, input.lastName].filter(Boolean).join(' ');

  return inTransaction(outerTx, async (tx) => {
    // Employees get a salary-expense account so payroll can be posted.
    const accountId = await mintPartyAccount(tx, 'employee', fullName, branchId, principal.empId);

    const created = await tx
      .insertInto('employee')
      .values({
        first_name: input.firstName,
        last_name: input.lastName ?? null,
        code: input.code ?? null,
        phone: input.phone ?? null,
        mobile: input.mobile ?? null,
        cnic: input.cnic ?? null,
        gender: input.gender ?? null,
        city: input.city ?? null,
        province: input.province ?? null,
        basic_salary: input.basicSalary,
        branch_id: branchId,
        account_no: accountId,
        dob: input.dob ?? null,
        join_date: input.joinDate ?? null,
        img: null,
        created_by: principal.empId,
        updated_by: principal.empId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAudit(
      principal,
      {
        form: 'Employee',
        action: 'New',
        detail: `Created employee: ${fullName}, account ${accountId}`,
        invId: created.id,
      },
      tx,
    );

    return created;
  });
}

/** Branches for the employee form. */
export async function employeeOptions(principal: Principal) {
  let branches = db.selectFrom('branch').select(['id', 'name']).where('id', '>', 0);
  if (!principal.isSuperAdmin) branches = branches.where('id', '=', principal.branchId);

  return { branches: await branches.orderBy('name').execute() };
}
