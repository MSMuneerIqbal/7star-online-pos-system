import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth';

interface NotificationRow {
  id: number;
  branch_id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  is_read: boolean;
  created_at: string;
}

interface NotificationsResponse {
  rows: NotificationRow[];
  unread: number;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function NotificationBell() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const feed = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<NotificationsResponse>('/notifications'),
    refetchInterval: 30_000,
    enabled: user !== null,
  });

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const markOne = useMutation({
    mutationFn: (id: number) => api.post(`/notifications/${id}/read`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const unread = feed.data?.unread ?? 0;

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-md p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
        aria-label="Notifications"
      >
        <Bell className="size-4.5" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-4 text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <span className="text-sm font-semibold text-slate-900">Notifications</span>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => markAll.mutate()}
                className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
              >
                <CheckCheck className="size-3.5" />
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {(feed.data?.rows ?? []).length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-slate-500">Nothing here yet.</p>
            ) : (
              (feed.data?.rows ?? []).map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    if (!n.is_read) markOne.mutate(n.id);
                    setOpen(false);
                    if (n.link) navigate(n.link);
                  }}
                  className={cn(
                    'block w-full border-b border-slate-50 px-3 py-2 text-left transition hover:bg-slate-50',
                    !n.is_read && 'bg-brand-50/40',
                  )}
                >
                  <div className="flex items-start gap-2">
                    {!n.is_read && (
                      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-600" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900">{n.title}</p>
                      {n.body && <p className="mt-0.5 text-xs text-slate-600">{n.body}</p>}
                      <p className="mt-0.5 text-[11px] text-slate-400">{timeAgo(n.created_at)}</p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
