/**
 * Notification routes — the top-bar bell feed.
 *
 * No permission gating beyond authentication: every signed-in user may read
 * their own branch's feed and mark it read. The super admin reads everything.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as service from './service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

export default async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', {
    preHandler: app.authenticate,
    handler: async (req) => {
      const [rows, unread] = await Promise.all([
        service.listNotifications(req.principal),
        service.unreadCount(req.principal),
      ]);
      return { rows, unread };
    },
  });

  app.post('/read-all', {
    preHandler: app.authenticate,
    handler: async (req) => {
      await service.markAllRead(req.principal);
      return { ok: true };
    },
  });

  app.post('/:id/read', {
    preHandler: app.authenticate,
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      await service.markRead(req.principal, id);
      return { ok: true };
    },
  });
}
