import { X } from 'lucide-react';
import { ReactNode, useEffect, useId, useRef } from 'react';

interface ModalProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible dialog shell: role="dialog" + aria-modal, labelled by its title,
 * closes on Escape and on backdrop click, moves focus into the dialog on open,
 * keeps Tab / Shift+Tab inside it (T.32), and restores focus to the previously
 * focused element on close. Enters with a short scale/fade (reduced-motion
 * aware via index.css).
 */
export const Modal = ({ title, subtitle, onClose, children, footer, size = 'md' }: ModalProps) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const first = dialogRef.current?.querySelector<HTMLElement>(
      'input, textarea, select, button:not([data-modal-close]), [tabindex]:not([tabindex="-1"])'
    );
    (first ?? dialogRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A nested dialog (e.g. a confirmation) handles its own Escape first.
        if (dialogRef.current && !dialogRef.current.contains(document.activeElement) && document.activeElement !== document.body) return;
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const nodes = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (nodes.length === 0) return;
      const firstNode = nodes[0];
      const lastNode = nodes[nodes.length - 1];
      if (e.shiftKey && (document.activeElement === firstNode || !dialogRef.current.contains(document.activeElement))) {
        e.preventDefault();
        lastNode.focus();
      } else if (!e.shiftKey && (document.activeElement === lastNode || !dialogRef.current.contains(document.activeElement))) {
        e.preventDefault();
        firstNode.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div
      // T.39: on phones (< 640px) dialogs rise from the bottom edge as sheets; unchanged from 640px up.
      className="fixed inset-0 z-[100] flex items-end justify-center bg-overlay animate-fade-in sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-line bg-surface pb-[env(safe-area-inset-bottom)] text-fg shadow-2xl outline-none animate-sheet-in sm:max-h-[85vh] sm:rounded-2xl sm:pb-0 sm:animate-scale-in ${size === 'lg' ? 'max-w-2xl' : 'max-w-md'}`}
      >
        <div className="flex shrink-0 items-start gap-3 px-5 pb-3 pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-base font-semibold tracking-[-0.01em] text-fg">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-xs text-fg-subtle">{subtitle}</p>}
          </div>
          <button
            type="button"
            data-modal-close
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-md p-1.5 text-fg-subtle transition-colors hover:bg-surface-tertiary hover:text-fg"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>
        {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
      </div>
    </div>
  );
};
