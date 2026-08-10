import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { unauthorized } from '../errors.js';
import { Permissions, type Principal } from '../rbac.js';
import { verifyAccessToken } from '../auth/tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
    permissions: Permissions;
  }

  interface FastifyInstance {
    /** Route-level preHandler: requires a valid access token. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Route-level preHandler factory: requires a specific form/action grant. */
    requireAction: (
      formId: number,
      actionId: number,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function extractBearer(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw unauthorized('Missing bearer token');
  }
  return header.slice('Bearer '.length);
}

export default fp(
  async (app) => {
    // Declared up front so Fastify keeps a stable request shape. The value is
    // genuinely absent until `authenticate` runs, hence the cast.
    app.decorateRequest('principal', null as unknown as Principal);
    app.decorateRequest('permissions', null as unknown as Permissions);

    app.decorate('authenticate', async (req: FastifyRequest) => {
      const claims = await verifyAccessToken(extractBearer(req));

      const principal: Principal = {
        userId: Number(claims.sub),
        username: claims.username,
        empId: claims.empId,
        branchId: claims.branchId,
        roleId: claims.roleId,
        isSuperAdmin: claims.isSuperAdmin,
      };

      req.principal = principal;
      req.permissions = await Permissions.forPrincipal(principal);
    });

    app.decorate(
      'requireAction',
      (formId: number, actionId: number) => async (req: FastifyRequest, reply: FastifyReply) => {
        // Allow this to be used standalone as well as after `authenticate`.
        if (!req.principal) await app.authenticate(req, reply);
        req.permissions.assertAction(formId, actionId);
      },
    );
  },
  { name: 'authenticate' },
);
