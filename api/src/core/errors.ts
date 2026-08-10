/**
 * Application error taxonomy.
 *
 * The legacy app swallowed exceptions into `TempData["ErrorMessage"]` and
 * redirected, so failures looked like successes. Here every failure is typed,
 * carries a stable machine-readable code, and is logged.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'UNBALANCED_VOUCHER'
  | 'INTERNAL';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly expose: boolean;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
    expose = true,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = expose;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (resource: string) =>
  new AppError(404, 'NOT_FOUND', `${resource} not found`);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);

export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'UNPROCESSABLE', message, details);

/**
 * Raised when a voucher's legs do not net to zero. This is the check the legacy
 * sale posting lacked — see db/accounts.md §4.1.
 */
export const unbalancedVoucher = (transId: number, imbalance: string) =>
  new AppError(
    422,
    'UNBALANCED_VOUCHER',
    `Voucher ${transId} does not balance: Dr − Cr = ${imbalance}`,
    { transId, imbalance },
  );

/** Internal failures are never exposed to the client verbatim. */
export const internal = (message: string, cause?: unknown) =>
  new AppError(500, 'INTERNAL', message, cause, false);

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
