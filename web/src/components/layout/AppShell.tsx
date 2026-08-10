import { Outlet } from 'react-router-dom';
import { Building2, LogOut, User } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { useAuth } from '@/lib/auth';

export function AppShell() {
  const { user, logout } = useAuth();

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex h-12 shrink-0 items-center gap-4 border-b border-slate-200 bg-white px-4">
          <div className="ml-auto flex items-center gap-4 text-sm">
            <span className="flex items-center gap-1.5 text-slate-600">
              <User className="size-3.5" />
              <strong className="font-medium text-slate-900">{user?.username}</strong>
            </span>

            <span className="flex items-center gap-1.5 text-slate-600">
              <Building2 className="size-3.5" />
              {user?.branchName}
            </span>

            <button
              type="button"
              onClick={() => void logout()}
              className="btn-secondary"
            >
              <LogOut className="size-3.5" />
              Logout
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-auto p-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
