import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, Construction } from 'lucide-react';
import { NAV, type NavItem, type NavSection } from '@/lib/nav';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';

/** Mirrors the server's rbac check for a single item. */
function useIsVisible() {
  const { hasForm, hasAction } = useAuth();

  return (item: NavItem): boolean => {
    if (item.children) return item.children.some((c) => (c.action ? hasAction(...c.action) : true));
    if (item.action) return hasAction(...item.action);
    if (item.formId !== undefined) return hasForm(item.formId);
    return true;
  };
}

function StatusBadge({ item }: { item: NavItem }) {
  if (item.status === 'ported') return null;

  const label = item.status === 'new' ? 'Not built' : 'Incomplete';

  return (
    <span
      title={
        item.status === 'new'
          ? 'Linked in the legacy menu but never implemented'
          : 'Partially implemented in the legacy system'
      }
      className="ml-auto inline-flex items-center gap-1 rounded-sm bg-amber-100 px-1.5
                 py-0.5 text-[10px] font-medium text-amber-800"
    >
      <Construction className="size-2.5" />
      {label}
    </span>
  );
}

function Leaf({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition',
          isActive
            ? 'bg-brand-600 font-medium text-white'
            : 'text-slate-300 hover:bg-slate-700/60 hover:text-white',
        )
      }
    >
      <span className="truncate">{item.label}</span>
      <StatusBadge item={item} />
    </NavLink>
  );
}

function Branch({ item }: { item: NavItem }) {
  const { pathname } = useLocation();
  const isVisible = useIsVisible();

  const children = (item.children ?? []).filter(isVisible);
  const containsActive = children.some((c) => pathname.startsWith(c.path));
  const [open, setOpen] = useState(containsActive);

  if (children.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm transition',
          containsActive ? 'text-white' : 'text-slate-300 hover:bg-slate-700/60 hover:text-white',
        )}
      >
        <span className="truncate">{item.label}</span>
        <ChevronDown
          className={cn('ml-auto size-3.5 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="mt-0.5 ml-3 space-y-0.5 border-l border-slate-700 pl-2">
          {children.map((child) => (
            <Leaf key={child.path} item={child} />
          ))}
        </div>
      )}
    </div>
  );
}

function Section({ section }: { section: NavSection }) {
  const { hasHead } = useAuth();
  const isVisible = useIsVisible();

  if (section.headId !== undefined && !hasHead(section.headId)) return null;

  const items = section.items.filter(isVisible);
  if (items.length === 0) return null;

  return (
    <div className="mb-4">
      {section.title && (
        <p className="mb-1 px-3 text-[10px] font-semibold tracking-wider text-slate-500 uppercase">
          {section.title}
        </p>
      )}

      <div className="space-y-0.5">
        {items.map((item) =>
          item.children ? (
            <Branch key={item.path} item={item} />
          ) : (
            <Leaf key={item.path} item={item} />
          ),
        )}
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <nav
      aria-label="Main"
      className="no-print flex h-full w-60 shrink-0 flex-col overflow-y-auto bg-slate-800 py-3"
    >
      <div className="mb-4 flex items-center gap-2 px-4">
        <div className="grid size-7 place-items-center rounded-md bg-brand-500 text-xs font-bold text-white">
          7S
        </div>
        <span className="text-sm font-semibold text-white">7 Star POS</span>
      </div>

      <div className="flex-1 px-2">
        {NAV.map((section, i) => (
          <Section key={section.title ?? i} section={section} />
        ))}
      </div>
    </nav>
  );
}
