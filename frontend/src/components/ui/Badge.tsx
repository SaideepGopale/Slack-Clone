import { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-tertiary text-fg-muted',
  brand: 'bg-brand-soft text-brand',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

/** Small status/role label. Purely presentational — put meaning in the text. */
export const Badge = ({ tone = 'neutral', children, className = '' }: { tone?: BadgeTone; children: ReactNode; className?: string }) => (
  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${TONES[tone]} ${className}`}>
    {children}
  </span>
);
