'use client';

import { cn } from '@repo/ui';
import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * Minimal dialog shell. Closes on Escape and on backdrop click; the panel
 * itself stops propagation so a click inside never dismisses it.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: ModalProps) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => {
          event.stopPropagation();
        }}
        className={cn(
          'my-8 flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0a0a0b] shadow-[0_32px_120px_-20px_rgba(0,0,0,0.95)]',
          className,
        )}
      >
        <header className="flex items-start gap-4 border-b border-white/[0.08] px-6 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-base font-semibold text-white">{title}</h2>
            {description !== undefined ? (
              <p className="text-xs leading-relaxed text-zinc-500">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto grid size-8 shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <div className="max-h-[60vh] overflow-y-auto px-6 py-5">{children}</div>

        {footer !== undefined ? (
          <footer className="flex items-center justify-end gap-2 border-t border-white/[0.08] bg-white/[0.02] px-6 py-4">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
