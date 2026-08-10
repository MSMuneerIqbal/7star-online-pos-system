import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, unauthorized } from '../../core/errors.js';
import * as service from './service.js';

const REFRESH_COOKIE = 'refresh_token';

const loginBody = z.object({
  username: z.string().min(1, 'Username is required').max(100),
  password: z.string().min(1, 'Password is required').max(200),
});

const changePasswordBody = z.object({
  currentPassword: z.string().max(200).default(''),
  newPassword: z
    .string()
    .min(10, 'Password must be at least 10 characters')
    .max(200),
});

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The refresh token lives in an httpOnly cookie so page JS cannot read it;
   * the short-lived access token is returned in the body for the SPA to hold
   * in memory.
   */
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: app.config.NODE_ENV === 'production',
    path: '/api/v1/auth',
    maxAge: 7 * 24 * 60 * 60,
  };

  app.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    handler: async (req, reply) => {
      const { username, password } = loginBody.parse(req.body);

      const result = await service.login(username, password, {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });

      reply.setCookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);

      return {
        accessToken: result.accessToken,
        user: result.user,
        permissions: result.permissions,
      };
    },
  });

  app.post('/refresh', {
    config: { rateLimit: { max: 60, timeWindow: '5 minutes' } },
    handler: async (req, reply) => {
      const token = req.cookies[REFRESH_COOKIE];
      if (!token) throw unauthorized('No refresh token');

      const result = await service.refresh(token, {
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });

      reply.setCookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);

      return {
        accessToken: result.accessToken,
        user: result.user,
        permissions: result.permissions,
      };
    },
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) await service.logout(token);

    reply.clearCookie(REFRESH_COOKIE, { path: cookieOptions.path });
    return { ok: true };
  });

  app.get('/me', {
    preHandler: app.authenticate,
    handler: async (req) => service.me(req.principal),
  });

  app.post('/change-password', {
    preHandler: app.authenticate,
    handler: async (req) => {
      const { currentPassword, newPassword } = changePasswordBody.parse(req.body);

      if (currentPassword === newPassword) {
        throw badRequest('New password must differ from the current one');
      }

      await service.changePassword(req.principal, currentPassword, newPassword);
      return { ok: true };
    },
  });
}
