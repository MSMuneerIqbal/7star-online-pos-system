import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError, isAppError } from '../errors.js';
import { isProd } from '../config.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

/** Postgres error codes we translate into meaningful HTTP responses. */
const PG_UNIQUE_VIOLATION = '23505';
const PG_FK_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';

function translatePgError(err: FastifyError & { code?: string; constraint?: string }): AppError | null {
  switch (err.code) {
    case PG_UNIQUE_VIOLATION:
      return new AppError(409, 'CONFLICT', 'That record already exists', {
        constraint: err.constraint,
      });

    case PG_FK_VIOLATION:
      return new AppError(409, 'CONFLICT', 'That record is referenced by other data', {
        constraint: err.constraint,
      });

    case PG_CHECK_VIOLATION:
      // chk_transactions_one_sided fires when a ledger leg is neither a pure
      // debit nor a pure credit — exactly what the legacy system allowed.
      return new AppError(422, 'UNPROCESSABLE', 'That value violates a database rule', {
        constraint: err.constraint,
      });

    default:
      return null;
  }
}

export default fp(
  async (app) => {
    app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
      const requestId = req.id;

      // Zod validation failures -> 400 with field-level detail
      if (err instanceof ZodError) {
        const body: ErrorBody = {
          error: {
            code: 'BAD_REQUEST',
            message: 'Validation failed',
            details: err.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
            requestId,
          },
        };
        req.log.info({ err, requestId }, 'validation failed');
        return reply.status(400).send(body);
      }

      const appErr = isAppError(err) ? err : translatePgError(err);

      if (appErr) {
        const body: ErrorBody = {
          error: {
            code: appErr.code,
            message: appErr.expose ? appErr.message : 'Internal server error',
            requestId,
          },
        };
        if (appErr.expose && appErr.details !== undefined) {
          body.error.details = appErr.details;
        }

        if (appErr.statusCode >= 500) req.log.error({ err, requestId }, appErr.message);
        else req.log.info({ err: appErr.message, requestId }, 'request rejected');

        return reply.status(appErr.statusCode).send(body);
      }

      // Fastify's own errors (bad JSON, payload too large, rate limit, ...)
      if (typeof err.statusCode === 'number' && err.statusCode < 500) {
        return reply.status(err.statusCode).send({
          error: { code: err.code ?? 'BAD_REQUEST', message: err.message, requestId },
        } satisfies ErrorBody);
      }

      // Anything else is a bug. Log it fully, tell the client nothing.
      req.log.error({ err, requestId }, 'unhandled error');

      return reply.status(500).send({
        error: {
          code: 'INTERNAL',
          message: 'Internal server error',
          ...(isProd ? {} : { details: err.message }),
          requestId,
        },
      } satisfies ErrorBody);
    });

    app.setNotFoundHandler((req, reply) =>
      reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: `Route ${req.method} ${req.url} not found`,
          requestId: req.id,
        },
      } satisfies ErrorBody),
    );
  },
  { name: 'error-handler' },
);
