/**
 * Party registration — Customer, Vendor, Employee.
 *
 * Legacy forms: 7 Customer (206), 8 Vendor (207), 9 Employee (208).
 *
 * This file is the edge: Zod schemas, permission gates and status codes. The
 * work — including the chart-of-accounts code every party is minted with — lives
 * in `service.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formPermissions, listQuery } from '../../core/crud.js';
import * as service from './service.js';

const CUSTOMER = formPermissions(7, 206);
const SUPPLIER = formPermissions(8, 207);
const EMPLOYEE = formPermissions(9, 208);

const idParam = z.object({ id: z.coerce.number().int().positive() });
const decimal = z.union([z.string(), z.number()]).transform(String);
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const customerBody = z.object({
  name: z.string().trim().min(1, 'Name is required').max(150),
  code: z.string().trim().max(50).nullish(),
  phone: z.string().trim().max(50).nullish(),
  mobile: z.string().trim().max(50).nullish(),
  address: z.string().trim().max(300).nullish(),
  email: z.string().trim().max(150).nullish(),
  cnic: z.string().trim().max(50).nullish(),
  city: z.string().trim().max(100).nullish(),
  province: z.string().trim().max(100).nullish(),
  settlementCycle: z.enum(['WEEKLY', 'MONTHLY']).nullish(),
  creditLimit: decimal.default('0'),
  isActive: z.boolean().default(true),
  branchId: z.coerce.number().int().optional(),
});

const supplierBody = z.object({
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
});

const employeeBody = z.object({
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
  dob: dateString.nullish(),
  joinDate: dateString.nullish(),
  branchId: z.coerce.number().int().optional(),
});

export default async function partyRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Customer
  // -------------------------------------------------------------------------

  app.get('/customers', {
    preHandler: app.requireAction(CUSTOMER.formId, CUSTOMER.view),
    handler: (req) => service.listCustomers(req.principal, listQuery.parse(req.query)),
  });

  app.post('/customers', {
    preHandler: app.requireAction(CUSTOMER.formId, CUSTOMER.create),
    handler: async (req, reply) => {
      const row = await service.createCustomer(req.principal, customerBody.parse(req.body));
      return reply.status(201).send(row);
    },
  });

  app.put('/customers/:id', {
    preHandler: app.requireAction(CUSTOMER.formId, CUSTOMER.edit),
    handler: (req) => {
      const { id } = idParam.parse(req.params);
      return service.updateCustomer(
        req.principal,
        id,
        customerBody.omit({ branchId: true }).parse(req.body),
      );
    },
  });

  // -------------------------------------------------------------------------
  // Vendor (supplier)
  // -------------------------------------------------------------------------

  app.get('/suppliers', {
    preHandler: app.requireAction(SUPPLIER.formId, SUPPLIER.view),
    handler: (req) => service.listSuppliers(req.principal, listQuery.parse(req.query)),
  });

  app.post('/suppliers', {
    preHandler: app.requireAction(SUPPLIER.formId, SUPPLIER.create),
    handler: async (req, reply) => {
      const row = await service.createSupplier(req.principal, supplierBody.parse(req.body));
      return reply.status(201).send(row);
    },
  });

  app.put('/suppliers/:id', {
    preHandler: app.requireAction(SUPPLIER.formId, SUPPLIER.edit),
    handler: (req) => {
      const { id } = idParam.parse(req.params);
      return service.updateSupplier(
        req.principal,
        id,
        supplierBody.omit({ branchId: true }).parse(req.body),
      );
    },
  });

  // -------------------------------------------------------------------------
  // Employee
  // -------------------------------------------------------------------------

  app.get('/employees', {
    preHandler: app.requireAction(EMPLOYEE.formId, EMPLOYEE.view),
    handler: (req) => service.listEmployees(req.principal, listQuery.parse(req.query)),
  });

  app.post('/employees', {
    preHandler: app.requireAction(EMPLOYEE.formId, EMPLOYEE.create),
    handler: async (req, reply) => {
      const row = await service.createEmployee(req.principal, employeeBody.parse(req.body));
      return reply.status(201).send(row);
    },
  });

  app.get('/employee-options', {
    preHandler: app.requireAction(EMPLOYEE.formId, EMPLOYEE.view),
    handler: (req) => service.employeeOptions(req.principal),
  });
}
