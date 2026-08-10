import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, setAccessToken } from './api';

export interface User {
  id: number;
  username: string;
  empId: number;
  branchId: number;
  branchName: string;
  roleId: number | null;
  isSuperAdmin: boolean;
  mustResetPassword?: boolean;
}

export interface Assignment {
  head_id: number;
  form_id: number;
  action_id: number;
}

export interface PermissionSet {
  isSuperAdmin: boolean;
  assignments: Assignment[];
}

interface SessionResponse {
  accessToken?: string;
  user: User;
  permissions: PermissionSet;
}

interface AuthState {
  user: User | null;
  permissions: PermissionSet;
  /** True until the initial refresh attempt settles. */
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Mirrors the server-side rbac checks exactly — see api/src/core/rbac.ts. */
  hasHead: (headId: number) => boolean;
  hasForm: (formId: number) => boolean;
  hasAction: (formId: number, actionId: number) => boolean;
}

const EMPTY: PermissionSet = { isSuperAdmin: false, assignments: [] };

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<PermissionSet>(EMPTY);
  const [loading, setLoading] = useState(true);

  // Restore the session on load: the httpOnly refresh cookie survives reloads.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const token = await api.refresh();

      if (cancelled) return;

      if (token) {
        try {
          const me = await api.get<SessionResponse>('/auth/me');
          if (!cancelled) {
            setUser(me.user);
            setPermissions(me.permissions);
          }
        } catch {
          setAccessToken(null);
        }
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.post<SessionResponse>('/auth/login', { username, password });
    if (res.accessToken) setAccessToken(res.accessToken);
    setUser(res.user);
    setPermissions(res.permissions);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setAccessToken(null);
      setUser(null);
      setPermissions(EMPTY);
    }
  }, []);

  const value = useMemo<AuthState>(() => {
    const { isSuperAdmin, assignments } = permissions;

    return {
      user,
      permissions,
      loading,
      login,
      logout,
      hasHead: (headId) => isSuperAdmin || assignments.some((a) => a.head_id === headId),
      hasForm: (formId) => isSuperAdmin || assignments.some((a) => a.form_id === formId),
      hasAction: (formId, actionId) =>
        isSuperAdmin ||
        assignments.some((a) => a.form_id === formId && a.action_id === actionId),
    };
  }, [user, permissions, loading, login, logout]);

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
