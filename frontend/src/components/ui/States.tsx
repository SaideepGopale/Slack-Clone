import { AlertTriangle, Loader2 } from 'lucide-react';
import { ReactNode } from 'react';
import { Button } from './Button';

/** Inline spinner with an accessible name (role="status"). */
export const Spinner = ({ label = 'Loading', size = 20, className = '' }: { label?: string; size?: number; className?: string }) => (
  <span role="status" aria-label={label} className={`inline-flex ${className}`}>
    <Loader2 size={size} className="animate-spin text-brand" aria-hidden="true" />
  </span>
);

/** Centered loading block for a whole panel or page. */
export const LoadingState = ({ label = 'Loading' }: { label?: string }) => (
  <div className="flex-1 flex items-center justify-center py-16">
    <Spinner label={label} size={24} />
  </div>
);

interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}

export const EmptyState = ({ title, description, icon, action }: EmptyStateProps) => (
  <div className="flex flex-col items-center justify-center text-center py-16 px-6 gap-3">
    {icon && (
      <div className="w-14 h-14 rounded-2xl bg-surface-tertiary text-fg-subtle flex items-center justify-center" aria-hidden="true">
        {icon}
      </div>
    )}
    <h2 className="text-base font-bold text-fg">{title}</h2>
    {description && <p className="text-sm text-fg-muted max-w-sm">{description}</p>}
    {action}
  </div>
);

interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
}

/** Error block; role="alert" so it is announced. */
export const ErrorState = ({ title = 'Something went wrong', message, onRetry }: ErrorStateProps) => (
  <div role="alert" className="flex flex-col items-center justify-center text-center py-12 px-6 gap-3">
    <div className="w-12 h-12 rounded-2xl bg-danger-soft text-danger flex items-center justify-center" aria-hidden="true">
      <AlertTriangle size={22} />
    </div>
    <h2 className="text-base font-bold text-fg">{title}</h2>
    <p className="text-sm text-fg-muted max-w-sm">{message}</p>
    {onRetry && (
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    )}
  </div>
);
