/**
 * Party registration — Customer, Vendor, Employee.
 *
 * Legacy forms: 7 Customer (206), 8 Vendor (207), 9 Employee (208).
 *
 * These three differ from the catalog screens in one important way: creating a
 * party mints a chart-of-accounts code for it, because every sale, purchase and
 * payroll entry posts against that code. Allocation goes through
 * `allocateAccountCode`, which takes a transaction-scoped advisory lock —
 * the legacy `MAX(AccountId)+1` raced and could merge two parties' ledgers.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, withTransaction, type Tx } from '../../core/db/index.js';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { resolveBranchId } from '../../core/rbac.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';
import { allocateAccountCode, type AccountBucket } from '../accounts/service.js';

const CUSTOMER = formPermissions(7, 206);
const SUPPLIER = formPermissions(8, 207);
const EMPLOYEE = formPermissions(9, 208);

const idParam = z.object({ id: z.coerce.number().int().positive() });
const decimal = z.union([z.string(), z.number()]).transform(String);

/**
 * Where each party type's account codes live.
 *
 * Verified against the legacy allocation bases in CustomerController.cs:31,
 * SupplierController.cs:36 and EmployeeController.cs:33.
 */
const BUCKET: Record<'customer' | 'supplier' | 'employee', AccountBucket & { headCodeId: number }> = {
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
async function mintPartyAccount(
  tx: Tx,
  kind: 'customer' | 'supplier' | 'employee',
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

export default async function partyRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Customer
  // -------------------------------------------------------------------------

  app.get('/customers', {
    preHandler: app.requireAction(CUSTOMER.formId, CUSTOMER.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);
      let base = db.selectFrom('customer');

      if (!req.principal.isSuperAdmin) base = base.where('branch_id', '=', req.principal.branchId);

      const term = likeTerm(q.search);
      if (term) {
        base = base.where((eb) =>
          eb.or([eb('name', 'ilike', term), eb('phone', 'ilike', term), eb('code', 'ilike', term)]),
        );
      }

      const [rows, count] = await Promise.all([
        base
          .select([
            'id',
            'name',
            'code',
            'phone',
            'mobile',
            'address',
            'city',
            'account_id',
            'is_active',
          ])
          .orderBy('name')
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.post('/customers', {
    preHandler: app.requireAction(CUSTOMER.formId, CUSTOMER.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1, 'Name is required').max(150),
          code: z.string().trim().max(50).nullish(),
          phone: z.string().trim().max(50).nullish(),
          mobile: z.string().trim().max(50).nullish(),
          address: z.string().trim().max(300).nullish(),
          email: z.string().trim().max(150).nullish(),
          cnic: z.string().trim().max(50).nullish(),
          city: z.string().trim().max(100).nullish(),
          province: z.string().trim().max(100).nullish(),
          isActive: z.boolean().default(true),
          branchId: z.coerce.number().int().optional(),
        })
        .parse(req.body);

      const branchId = resolveBranchId(req.principal, body.branchId);

      const row = await withTransaction(async (tx) => {
        const accountId = await mintPartyAccount(
          tx,
          'customer',
          body.name,
          branchId,
          req.principal.empId,
        );

        const created = await tx
          .insertInto('customer')
          .values({
            name: body.name,
            code: body.code ?? null,
            phone: body.phone ?? null,
            mobile: body.mobile ?? null,
            address: body.address ?? null,
            email: body.email ?? null,
            cnic: body.cnic ?? null,
            city: body.city ?? null,
            province: body.province ?? null,
            is_active: body.isActive,
            branch_id: branchId,
            account_id: accountId,
            created_by: req.principal.empId,
            updated_by: req.principal.empId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          req.principal,
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

      return reply.status(201).send(row);
    },
  });

  app.put('/customers/:id', {
    preHandler: app.requireAction(CUSTOMER.formId, CUSTOMER.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          name: z.string().trim().min(1).max(150),
          code: z.string().trim().max(50).nullish(),
          phone: z.string().trim().max(50).nullish(),
          mobile: z.string().trim().max(50).nullish(),
          address: z.string().trim().max(300).nullish(),
          email: z.string().trim().max(150).nullish(),
          cnic: z.string().trim().max(50).nullish(),
          city: z.string().trim().max(100).nullish(),
          province: z.string().trim().max(100).nullish(),
          isActive: z.boolean().default(true),
        })
        .parse(req.body);

      const existing = await db
        .selectFrom('customer')
        .select(['id', 'name', 'account_id'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!existing) throw notFound('Customer');

      return withTransaction(async (tx) => {
        const row = await tx
          .updateTable('customer')
          .set({
            name: body.name,
            code: body.code ?? null,
            phone: body.phone ?? null,
            mobile: body.mobile ?? null,
            address: body.address ?? null,
            email: body.email ?? null,
            cnic: body.cnic ?? null,
            city: body.city ?? null,
            province: body.province ?? null,
            is_active: body.isActive,
            updated_at: new Date(),
            updated_by: req.principal.empId,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        // Keep the ledger account label in step with the customer name.
        if (existing.name !== row.name && existing.account_id) {
          await tx
            .updateTable('account')
            .set({ name: row.name })
            .where('account_id', '=', existing.account_id)
            .execute();
        }

        await writeAudit(
          req.principal,
          { form: 'Customer', action: 'Edit', detail: `Updated customer: ${row.name}`, invId: id },
          tx,
        );

        return row;
      });
    },
  });

  // -------------------------------------------------------------------------
  // Vendor (supplier)
  // -------------------------------------------------------------------------

  app.get('/suppliers', {
    preHandler: app.requireAction(SUPPLIER.formId, SUPPLIER.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);
      let base = db.selectFrom('supplier');

      if (!req.principal.isSuperAdmin) base = base.where('branch_id', '=', req.principal.branchId);

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
    },
  });

  app.post('/suppliers', {
    preHandler: app.requireAction(SUPPLIER.formId, SUPPLIER.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1, 'Name is required').max(150),
          code: z.string().trim().max(50).nullish(),
          company: z.string().trim().max(150).nullish(),
          contactPerson: z.string().trim().max(150).nullish(),
          phone: z.string().trim().max(50).nullish(),
          email: z.string().trim().max(150).nullish(),
          address: z.string().trim().max(300).nullish(),
          cnic: z.string().trim().max(50).nullish(),
          ntn: z.string().trim().max(50).nullish(),
          strn: z.string().trim().max(50).nullish(),
          city: z.string().trim().max(100).nullish(),
          isActive: z.boolean().default(true),
          branchId: z.coerce.number().int().optional(),
        })
        .parse(req.body);

      const branchId = resolveBranchId(req.principal, body.branchId);

      const row = await withTransaction(async (tx) => {
        const accountId = await mintPartyAccount(
          tx,
          'supplier',
          body.name,
          branchId,
          req.principal.empId,
        );

        const created = await tx
          .insertInto('supplier')
          .values({
            name: body.name,
            code: body.code ?? null,
            company: body.company ?? null,
            contact_person: body.contactPerson ?? null,
            phone: body.phone ?? null,
            email: body.email ?? null,
            address: body.address ?? null,
            cnic: body.cnic ?? null,
            ntn: body.ntn ?? null,
            strn: body.strn ?? null,
            city: body.city ?? null,
            is_active: body.isActive,
            branch_id: branchId,
            account_no: accountId,
            created_by: req.principal.empId,
            updated_by: req.principal.empId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          req.principal,
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

      return reply.status(201).send(row);
    },
  });

  app.put('/suppliers/:id', {
    preHandler: app.requireAction(SUPPLIER.formId, SUPPLIER.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          name: z.string().trim().min(1).max(150),
          code: z.string().trim().max(50).nullish(),
          company: z.string().trim().max(150).nullish(),
          contactPerson: z.string().trim().max(150).nullish(),
          phone: z.string().trim().max(50).nullish(),
          email: z.string().trim().max(150).nullish(),
          address: z.string().trim().max(300).nullish(),
          cnic: z.string().trim().max(50).nullish(),
          ntn: z.string().trim().max(50).nullish(),
          strn: z.string().trim().max(50).nullish(),
          city: z.string().trim().max(100).nullish(),
          isActive: z.boolean().default(true),
        })
        .parse(req.body);

      const existing = await db
        .selectFrom('supplier')
        .select(['id', 'name', 'account_no'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!existing) throw notFound('Vendor');

      return withTransaction(async (tx) => {
        const row = await tx
          .updateTable('supplier')
          .set({
            name: body.name,
            code: body.code ?? null,
            company: body.company ?? null,
            contact_person: body.contactPerson ?? null,
            phone: body.phone ?? null,
            email: body.email ?? null,
            address: body.address ?? null,
            cnic: body.cnic ?? null,
            ntn: body.ntn ?? null,
            strn: body.strn ?? null,
            city: body.city ?? null,
            is_active: body.isActive,
            updated_at: new Date(),
            updated_by: req.principal.empId,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        if (existing.name !== row.name && existing.account_no) {
          await tx
            .updateTable('account')
            .set({ name: row.name })
            .where('account_id', '=', existing.account_no)
            .execute();
        }

        await writeAudit(
          req.principal,
          { form: 'Vendor', action: 'Edit', detail: `Updated vendor: ${row.name}`, invId: id },
          tx,
        );

        return row;
      });
    },
  });

  // -------------------------------------------------------------------------
  // Employee
  // -------------------------------------------------------------------------

  app.get('/employees', {
    preHandler: app.requireAction(EMPLOYEE.formId, EMPLOYEE.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);

      let base = db.selectFrom('employee').leftJoin('branch', 'branch.id', 'employee.branch_id');

      if (!req.principal.isSuperAdmin) {
        base = base.where('employee.branch_id', '=', req.principal.branchId);
      }

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
    },
  });

  app.post('/employees', {
    preHandler: app.requireAction(EMPLOYEE.formId, EMPLOYEE.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          firstName: z.string().trim().min(1, 'First name is required').max(100),
          lastName: z.string().trim().max(100).nullish(),
          code: z.string().trim().max(50).nullish(),
          phone: z.string().trim().max(50).nullish(),
          mobile: z.string().trim().max(50).nullish(),
          cnic: z.string().trim().max(50).nullish(),
          gender: z.string().trim().max(20).nullish(),
          city: z.string().trim().max(100).nullish(),
          province: z.string().trim().max(100).nullish(),
          basicSalary: decimal.default('0'),
          dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
          joinDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
          branchId: z.coerce.number().int().optional(),
        })
        .parse(req.body);

      const branchId = resolveBranchId(req.principal, body.branchId);
      const fullName = [body.firstName, body.lastName].filter(Boolean).join(' ');

      const row = await withTransaction(async (tx) => {
        // Employees get a salary-expense account so payroll can be posted.
        const accountId = await mintPartyAccount(
          tx,
          'employee',
          fullName,
          branchId,
          req.principal.empId,
        );

        const created = await tx
          .insertInto('employee')
          .values({
            first_name: body.firstName,
            last_name: body.lastName ?? null,
            code: body.code ?? null,
            phone: body.phone ?? null,
            mobile: body.mobile ?? null,
            cnic: body.cnic ?? null,
            gender: body.gender ?? null,
            city: body.city ?? null,
            province: body.province ?? null,
            basic_salary: body.basicSalary,
            branch_id: branchId,
            account_no: accountId,
            dob: body.dob ?? null,
            join_date: body.joinDate ?? null,
            img: null,
            created_by: req.principal.empId,
            updated_by: req.principal.empId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          req.principal,
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

      return reply.status(201).send(row);
    },
  });

  /** Branches for the employee form. */
  app.get('/employee-options', {
    preHandler: app.requireAction(EMPLOYEE.formId, EMPLOYEE.view),
    handler: async (req) => {
      let branches = db.selectFrom('branch').select(['id', 'name']).where('id', '>', 0);
      if (!req.principal.isSuperAdmin) branches = branches.where('id', '=', req.principal.branchId);

      const branchRows = await branches.orderBy('name').execute();

      return { branches: branchRows };
    },
  });
}
