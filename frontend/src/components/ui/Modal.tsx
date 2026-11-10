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

/**
 * Accessible dialog shell: role="dialog" + aria-modal, labelled by its title,
 * closes on Escape and on backdrop click, moves focus into the dialog on open
 * and restores it to the previously focused element on close.
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
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
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
        className={`bg-surface text-fg rounded-2xl w-full ${size === 'lg' ? 'max-w-2xl' : 'max-w-md'} max-h-[85vh] flex flex-col shadow-2xl outline-none`}
      >
        <div className="flex items-start gap-3 p-6 pb-4 shrink-0">
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="text-lg font-black text-gray-900 tracking-tight truncate">
              {title}
            </h2>
            {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          <button
            type="button"
            data-modal-close
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="px-6 pb-4 overflow-y-auto flex-1 min-h-0">{children}</div>
        {footer && <div className="px-6 py-4 border-t border-gray-100 shrink-0 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
};
