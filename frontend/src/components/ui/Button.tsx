import { Loader2 } from 'lucide-react';
import { ButtonHTMLAttributes, forwardRef, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-on-brand hover:bg-brand-hover shadow-sm',
  secondary: 'bg-surface text-fg border border-line hover:bg-surface-tertiary',
  ghost: 'bg-transparent text-fg-muted hover:bg-surface-tertiary hover:text-fg',
  danger: 'bg-danger text-on-brand hover:bg-danger-hover shadow-sm',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
};

/** Shared focus ring (keyboard only). */
export const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and blocks further clicks. */
  loading?: boolean;
  icon?: ReactNode;
}

/** Accessible button: native <button>, type="button" by default, busy state. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading = false, icon, disabled, className = '', children, type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${focusRing} ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {loading ? <Loader2 size={size === 'sm' ? 14 : 16} className="animate-spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  )
);
Button.displayName = 'Button';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Required: becomes aria-label and the tooltip (icon-only buttons need a name). */
  label: string;
  icon: ReactNode;
  variant?: 'ghost' | 'secondary' | 'danger';
  size?: ButtonSize;
}

const ICON_VARIANTS = {
  ghost: 'text-fg-muted hover:text-fg hover:bg-surface-tertiary',
  secondary: 'text-fg-muted bg-surface border border-line hover:bg-surface-tertiary',
  danger: 'text-fg-muted hover:text-danger hover:bg-danger-soft',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, icon, variant = 'ghost', size = 'md', className = '', type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center rounded-lg transition-colors disabled:opacity-50 ${focusRing} ${ICON_VARIANTS[variant]} ${size === 'sm' ? 'w-8 h-8' : 'w-10 h-10'} ${className}`}
      {...rest}
    >
      {icon}
    </button>
  )
);
IconButton.displayName = 'IconButton';
