import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config, isProd } from './core/config.js';
import { healthCheck } from './core/db/index.js';
import authenticate from './core/plugins/authenticate.js';
import errorHandler from './core/plugins/error-handler.js';
import authRoutes from './modules/auth/routes.js';
import branchRoutes from './modules/branch/routes.js';
import saleRoutes from './modules/sale/routes.js';
import purchaseRoutes from './modules/purchase/routes.js';
import saleReturnRoutes from './modules/sale-return/routes.js';
import purchaseReturnRoutes from './modules/purchase-return/routes.js';
import holdSaleRoutes from './modules/hold-sale/routes.js';
import accountRoutes from './modules/accounts/routes.js';
import voucherRoutes from './modules/voucher/routes.js';
import ledgerRoutes from './modules/ledger/routes.js';
import demandOrderRoutes from './modules/demand-order/routes.js';
import reportRoutes from './modules/reports/routes.js';
import productionRoutes from './modules/production/routes.js';
import adminRoutes from './modules/admin/routes.js';
import labRoutes from './modules/lab/routes.js';
import catalogRoutes from './modules/catalog/routes.js';
import branchProductRoutes from './modules/branch-product/routes.js';
import partyRoutes from './modules/parties/routes.js';
import importRoutes from './modules/import/routes.js';
import remittanceRoutes from './modules/remittance/routes.js';
import customerRoutes from './modules/customer/routes.js';
import expenseRoutes from './modules/expense/routes.js';
import warrantyRoutes from './modules/warranty/routes.js';
import estoreRoutes from './modules/estore/routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: typeof config;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(isProd
        ? {}
        : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }),
      // Never log credentials or tokens.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
        ],
        censor: '[redacted]',
      },
    },
    trustProxy: isProd,
    bodyLimit: 10 * 1024 * 1024,
  });

  app.decorate('config', config);

  await app.register(helmet, { contentSecurityPolicy: false });

  await app.register(cors, {
    origin: config.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
  });

  await app.register(cookie);

  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
  });

  await app.register(errorHandler);
  await app.register(authenticate);

  app.get('/health', async (_req, reply) => {
    const dbOk = await healthCheck();
    return reply.status(dbOk ? 200 : 503).send({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk,
      uptime: Math.round(process.uptime()),
    });
  });

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(branchRoutes, { prefix: '/api/v1/branches' });
  await app.register(saleRoutes, { prefix: '/api/v1/sales' });
  await app.register(purchaseRoutes, { prefix: '/api/v1/purchases' });
  await app.register(saleReturnRoutes, { prefix: '/api/v1/sale-returns' });
  await app.register(purchaseReturnRoutes, { prefix: '/api/v1/purchase-returns' });
  await app.register(holdSaleRoutes, { prefix: '/api/v1/hold-sales' });
  await app.register(accountRoutes, { prefix: '/api/v1/accounts' });
  await app.register(voucherRoutes, { prefix: '/api/v1/vouchers' });
  await app.register(ledgerRoutes, { prefix: '/api/v1/ledger' });
  await app.register(demandOrderRoutes, { prefix: '/api/v1/demand-orders' });
  await app.register(reportRoutes, { prefix: '/api/v1/reports' });
  await app.register(productionRoutes, { prefix: '/api/v1/production' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(labRoutes, { prefix: '/api/v1/lab' });
  // Registration screens share the /api/v1 root, one path segment each.
  await app.register(catalogRoutes, { prefix: '/api/v1' });
  await app.register(branchProductRoutes, { prefix: '/api/v1/branch-products' });
  await app.register(partyRoutes, { prefix: '/api/v1' });
  await app.register(importRoutes, { prefix: '/api/v1/import' });
  await app.register(remittanceRoutes, { prefix: '/api/v1/remittances' });
  await app.register(customerRoutes, { prefix: '/api/v1/customers' });
  await app.register(expenseRoutes, { prefix: '/api/v1/expenses' });
  await app.register(warrantyRoutes, { prefix: '/api/v1/warranty' });
  await app.register(estoreRoutes, { prefix: '/api/v1/estore' });

  // Remaining feature modules land here as phases 4-10 land:
  //   await app.register(brandRoutes, { prefix: '/api/v1/brands' });
  //   await app.register(saleRoutes,  { prefix: '/api/v1/sales' });
  //   ...

  return app;
}
