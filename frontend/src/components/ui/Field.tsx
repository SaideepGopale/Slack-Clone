import { cloneElement, forwardRef, InputHTMLAttributes, ReactElement, ReactNode, TextareaHTMLAttributes, useId } from 'react';

const controlClass =
  'w-full bg-surface border border-line rounded-xl px-3 py-2.5 text-sm text-fg placeholder:text-fg-subtle outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand-muted disabled:bg-surface-secondary disabled:text-fg-subtle aria-[invalid=true]:border-danger';

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className = '', ...rest }, ref) => (
  <input ref={ref} className={`${controlClass} ${className}`} {...rest} />
));
TextInput.displayName = 'TextInput';

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className = '', ...rest }, ref) => (
  <textarea ref={ref} className={`${controlClass} resize-none ${className}`} {...rest} />
));
TextArea.displayName = 'TextArea';

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** A single TextInput/TextArea/select — it receives id, aria-describedby and aria-invalid. */
  children: ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>;
  className?: string;
}

/** Label + control + hint/error, wired for assistive technology. */
export const Field = ({ label, hint, error, children, className = '' }: FieldProps) => {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`space-y-1.5 ${className}`}>
      <label htmlFor={id} className="block text-xs font-bold text-fg-muted">
        {label}
      </label>
      {cloneElement(children, { id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && !error && (
        <p id={hintId} className="text-xs text-fg-subtle">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  );
};
