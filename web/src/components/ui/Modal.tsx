import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Rendered in the footer, right-aligned. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const WIDTH = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' } as const;

/**
 * Modal dialog built on <dialog>, which gives focus trapping, Escape handling
 * and the top layer for free — all things the Bootstrap modal shipped its own
 * JavaScript for.
 */
export function Modal({ open, title, onClose, children, footer, size = 'md' }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        // Escape fires `cancel`; route it through our own handler so parent
        // state stays in sync with the dialog's open attribute.
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Clicking the backdrop closes. The backdrop is the dialog element
        // itself, so only a direct hit counts.
        if (e.target === ref.current) onClose();
      }}
      className={`${WIDTH[size]} w-full rounded-lg border border-slate-200 p-0 shadow-xl backdrop:bg-slate-900/40`}
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-sm p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="px-4 py-4">{children}</div>

      {footer && (
        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-4 py-2.5">
          {footer}
        </div>
      )}
    </dialog>
  );
}
