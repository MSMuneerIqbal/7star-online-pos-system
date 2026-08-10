/**
 * API client.
 *
 * The access token is held in memory only — never localStorage, which is
 * readable by any injected script. The refresh token lives in an httpOnly
 * cookie the browser sends automatically, so a page refresh restores the
 * session via /auth/refresh without JS ever touching it.
 */

const BASE = '/api/v1';

let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level validation messages, keyed by path. */
  get fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};

    const out: Record<string, string> = {};
    for (const d of this.details) {
      if (d && typeof d === 'object' && 'path' in d && 'message' in d) {
        out[String(d.path)] = String(d.message);
      }
    }
    return out;
  }
}

/** Refresh the access token, coalescing concurrent callers into one request. */
async function refreshAccessToken(): Promise<string | null> {
  refreshPromise ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!res.ok) return null;

      const data = (await res.json()) as { accessToken: string };
      accessToken = data.accessToken;
      return data.accessToken;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Internal: prevents infinite retry loops. */
  _retried?: boolean;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, _retried, ...rest } = options;

  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  // One transparent retry after a token refresh.
  if (res.status === 401 && !_retried && !path.startsWith('/auth/')) {
    const fresh = await refreshAccessToken();
    if (fresh) return request<T>(path, { ...options, _retried: true });
  }

  if (res.status === 204) return undefined as T;

  const payload: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const err =
      payload && typeof payload === 'object' && 'error' in payload
        ? (payload.error as { code: string; message: string; details?: unknown })
        : { code: 'INTERNAL', message: res.statusText };

    throw new ApiError(res.status, err.code, err.message, err.details);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  refresh: refreshAccessToken,
};
