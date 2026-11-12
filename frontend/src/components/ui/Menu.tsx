import { KeyboardEvent, ReactNode, useEffect, useId, useRef, useState } from 'react';
import { focusRing } from './Button';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface MenuProps {
  /** Accessible name of the trigger button. */
  label: string;
  /** Visible trigger content (icon and/or text). */
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'left' | 'right';
  triggerClassName?: string;
}

/**
 * WAI-ARIA menu button: Enter/Space/ArrowDown open and focus the first item,
 * arrows move, Escape closes and returns focus, outside click closes.
 * Renders nothing when there are no items (no empty menus).
 */
export const Menu = ({ label, trigger, items, align = 'left', triggerClassName = '' }: MenuProps) => {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const enabled = items.filter((i) => !i.disabled);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current.find((el) => el && !el.disabled)?.focus();
  }, [open]);

  if (items.length === 0) return null;

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const move = (from: number, delta: number) => {
    const focusable = itemRefs.current.filter((el): el is HTMLButtonElement => !!el && !el.disabled);
    const index = focusable.indexOf(itemRefs.current[from]!);
    focusable[(index + delta + focusable.length) % focusable.length]?.focus();
  };
  const onItemKey = (e: KeyboardEvent, index: number) => {
    if (e.key === 'ArrowDown') move(index, 1);
    else if (e.key === 'ArrowUp') move(index, -1);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') setOpen(false);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`${focusRing} ${triggerClassName}`}
      >
        {trigger}
      </button>
      {open && enabled.length > 0 && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={`absolute top-full mt-1 z-50 min-w-[200px] bg-surface border border-line rounded-xl shadow-xl p-1.5 ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              role="menuitem"
              type="button"
              disabled={item.disabled}
              tabIndex={-1}
              onKeyDown={(e) => onItemKey(e, index)}
              onClick={() => {
                close(false);
                item.onSelect();
              }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-lg text-left transition-colors disabled:opacity-50 ${focusRing} ${
                item.danger ? 'text-danger hover:bg-danger-soft' : 'text-fg hover:bg-surface-tertiary'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
