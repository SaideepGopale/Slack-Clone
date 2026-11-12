import { ComponentType, ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * T.39 — a native-feeling bottom sheet for touch layouts (message actions,
 * attachments). Slides up from the bottom edge, respects the home-indicator
 * safe area, closes on backdrop tap, Escape, or a downward swipe on its
 * handle, moves focus in and restores it on close, and keeps Tab inside
 * (same contract as Modal).
 */
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const SWIPE_CLOSE_PX = 80;

export const BottomSheet = ({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) => {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<number | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, []);

  // Swipe down on the handle area to dismiss.
  const onPointerDown = (e: React.PointerEvent) => {
    dragStart.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragStart.current === null) return;
    setDrag(Math.max(0, e.clientY - dragStart.current));
  };
  const onPointerUp = () => {
    if (dragStart.current === null) return;
    dragStart.current = null;
    if (drag > SWIPE_CLOSE_PX) onCloseRef.current();
    else setDrag(0);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-end justify-center bg-overlay animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={drag ? { transform: `translateY(${drag}px)`, transition: 'none' } : undefined}
        className="w-full max-w-lg rounded-t-2xl border border-b-0 border-line bg-surface pb-[max(env(safe-area-inset-bottom),0.5rem)] text-fg shadow-2xl transition-transform duration-200 animate-sheet-in"
      >
        <div className="cursor-grab touch-none select-none px-4 pb-1 pt-2" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <div className="mx-auto h-1 w-10 rounded-full bg-fg-subtle/40" aria-hidden="true" />
          <h2 id={titleId} className="mt-2 truncate text-[13px] font-semibold text-fg-muted">
            {title}
          </h2>
        </div>
        <div className="max-h-[70dvh] overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>,
    document.body
  );
};

/** One full-width, 48px-tall row in a bottom sheet. */
export const SheetAction = ({
  icon: Icon,
  label,
  onSelect,
  tone = 'default',
  disabled,
}: {
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' }>;
  label: string;
  onSelect: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
}) => (
  <button
    type="button"
    onClick={onSelect}
    disabled={disabled}
    className={`flex min-h-12 w-full select-none items-center gap-3 px-4 text-left text-[15px] transition-colors active:bg-surface-tertiary disabled:opacity-50 ${
      tone === 'danger' ? 'text-danger' : 'text-fg'
    }`}
  >
    <Icon size={20} aria-hidden="true" />
    <span className="truncate">{label}</span>
  </button>
);
