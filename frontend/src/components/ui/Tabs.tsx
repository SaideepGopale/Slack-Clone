import { KeyboardEvent, ReactNode, useRef } from 'react';
import { focusRing } from './Button';

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Optional count shown after the label (hidden when 0/undefined). */
  count?: number;
}

interface TabsProps {
  /** Accessible name of the tab list. */
  label: string;
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Prefix for tab/panel ids so TabPanel can reference its tab. */
  idPrefix: string;
  className?: string;
}

export const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
export const panelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

/**
 * WAI-ARIA tabs (manual activation is unnecessary here — selection follows
 * focus): roving tabindex, ArrowLeft/ArrowRight/Home/End.
 */
export const Tabs = ({ label, tabs, value, onChange, idPrefix, className = '' }: TabsProps) => {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const select = (index: number) => {
    const next = tabs[(index + tabs.length) % tabs.length];
    onChange(next.id);
    refs.current[(index + tabs.length) % tabs.length]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent, index: number) => {
    if (e.key === 'ArrowRight') select(index + 1);
    else if (e.key === 'ArrowLeft') select(index - 1);
    else if (e.key === 'Home') select(0);
    else if (e.key === 'End') select(tabs.length - 1);
    else return;
    e.preventDefault();
  };
  return (
    <div role="tablist" aria-label={label} className={`flex gap-1 border-b border-line ${className}`}>
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            id={tabId(idPrefix, tab.id)}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={panelId(idPrefix, tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={`px-3 py-2 -mb-px text-sm font-semibold border-b-2 transition-colors ${focusRing} ${
              selected ? 'border-brand text-brand' : 'border-transparent text-fg-muted hover:text-fg'
            }`}
          >
            {tab.label}
            {tab.count ? <span className="ml-1.5 text-xs text-fg-subtle">{tab.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
};

export const TabPanel = ({ idPrefix, id, children, className = '' }: { idPrefix: string; id: string; children: ReactNode; className?: string }) => (
  <div role="tabpanel" id={panelId(idPrefix, id)} aria-labelledby={tabId(idPrefix, id)} tabIndex={0} className={className}>
    {children}
  </div>
);
