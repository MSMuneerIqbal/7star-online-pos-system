/**
 * User management and settings.
 *
 * Legacy forms: 14 Roles (801), 15 Role Assignment (802), 16 User Logins (803),
 * 38 User Logs (804), 54 Login History (805), 37 Settings (901).
 *
 * This file is the edge: Zod schemas, permission gates and status codes. The
 * work — including the subset rules that stop a branch admin handing out powers
 * it does not hold — lives in `service.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formPermissions, listQuery } from '../../core/crud.js';
import * as service from './service.js';

const ROLES = formPermissions(14, 801);
const ROLE_ASSIGN = formPermissions(15, 802);
const LOGINS = formPermissions(16, 803);
const LOGS = formPermissions(38, 804);
const LOGIN_HISTORY = formPermissions(54, 805);
const SETTINGS = formPermissions(37, 901);

const idParam = z.object({ id: z.coerce.number().int().positive() });

const grantsBody = z.object({
  grants: z.array(
    z.object({
      headId: z.coerce.number().int().positive(),
      formId: z.coerce.number().int().positive(),
      actionId: z.coerce.number().int().positive(),
    }),
  ),
});

const logFilters = z.object({
  form: z.string().max(100).optional(),
  action: z.string().max(50).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------

  app.get('/roles', {
    preHandler: app.requireAction(ROLES.formId, ROLES.view),
    handler: (req) => service.listRoles(req.principal),
  });

  app.post('/roles', {
    preHandler: app.requireAction(ROLES.formId, ROLES.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1, 'Name is required').max(150),
          branchId: z.coerce.number().int().optional(),
        })
        .parse(req.body);

      const row = await service.createRole(req.principal, body);
      return reply.status(201).send(row);
    },
  });

  app.delete('/roles/:id', {
    preHandler: app.requireAction(ROLES.formId, ROLES.remove),
    handler: async (req, reply) => {
      const { id } = idParam.parse(req.params);
      await service.deleteRole(req.principal, id);
      return reply.status(204).send();
    },
  });

  // -------------------------------------------------------------------------
  // Role assignment — the permission matrix
  // -------------------------------------------------------------------------

  app.get('/permission-tree', {
    preHandler: app.requireAction(ROLE_ASSIGN.formId, ROLE_ASSIGN.view),
    handler: () => service.permissionTree(),
  });

  app.get('/roles/:id/permissions', {
    preHandler: app.requireAction(ROLE_ASSIGN.formId, ROLE_ASSIGN.view),
    handler: (req) => service.roleGrants(idParam.parse(req.params).id),
  });

  app.put('/roles/:id/permissions', {
    preHandler: app.requireAction(ROLE_ASSIGN.formId, ROLE_ASSIGN.edit),
    handler: (req) => {
      const { id } = idParam.parse(req.params);
      const { grants } = grantsBody.parse(req.body);
      return service.setRoleGrants(req.principal, id, grants);
    },
  });

  // -------------------------------------------------------------------------
  // User logins
  // -------------------------------------------------------------------------

  app.get('/logins', {
    preHandler: app.requireAction(LOGINS.formId, LOGINS.view),
    handler: (req) => service.listLogins(req.principal, listQuery.parse(req.query)),
  });

  app.post('/logins', {
    preHandler: app.requireAction(LOGINS.formId, LOGINS.create),
    handler: async (req, reply) => {
      const body = z
        .object({
          username: z.string().trim().min(3, 'Username must be at least 3 characters').max(100),
          password: z.string().min(10, 'Password must be at least 10 characters').max(200),
          roleId: z.coerce.number().int().positive(),
          empId: z.coerce.number().int().positive(),
          branchId: z.coerce.number().int().optional(),
        })
        .parse(req.body);

      const row = await service.createLogin(req.principal, body);
      return reply.status(201).send(row);
    },
  });

  app.put('/logins/:id', {
    preHandler: app.requireAction(LOGINS.formId, LOGINS.edit),
    handler: (req) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          roleId: z.coerce.number().int().positive().optional(),
          isActive: z.boolean().optional(),
          password: z.string().min(10).max(200).optional(),
          branchId: z.coerce.number().int().positive().optional(),
        })
        .parse(req.body);

      return service.updateLogin(req.principal, id, body);
    },
  });

  // -------------------------------------------------------------------------
  // User logs — read-only audit trail
  // -------------------------------------------------------------------------

  app.get('/logs', {
    preHandler: app.requireAction(LOGS.formId, LOGS.view),
    handler: (req) =>
      service.listLogs(req.principal, listQuery.parse(req.query), logFilters.parse(req.query)),
  });

  app.get('/logs/forms', {
    preHandler: app.requireAction(LOGS.formId, LOGS.view),
    handler: () => service.logFormNames(),
  });

  // -------------------------------------------------------------------------
  // Login history
  // -------------------------------------------------------------------------

  app.get('/login-history', {
    preHandler: app.requireAction(LOGIN_HISTORY.formId, LOGIN_HISTORY.view),
    handler: (req) => service.listLoginHistory(req.principal, listQuery.parse(req.query)),
  });

  // -------------------------------------------------------------------------
  // Company settings
  // -------------------------------------------------------------------------

  app.get('/settings', {
    preHandler: app.requireAction(SETTINGS.formId, SETTINGS.view),
    handler: () => service.getSettings(),
  });

  app.put('/settings', {
    preHandler: app.requireAction(SETTINGS.formId, SETTINGS.edit),
    handler: (req) => {
      const body = z
        .object({
          name: z.string().trim().max(150).nullish(),
          phone: z.string().trim().max(50).nullish(),
          address: z.string().trim().max(500).nullish(),
          email: z.string().trim().max(150).nullish(),
          deliveryCharges: z.union([z.string(), z.number()]).transform(String).default('0'),
        })
        .parse(req.body);

      return service.updateSettings(req.principal, body);
    },
  });
}
