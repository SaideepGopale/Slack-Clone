/**
 * SmartConnect brand mark (T.32 identity): an abstract "S" drawn as two
 * connected nodes — one conversation reaching another. Solid accent tile,
 * no gradient, legible from 16px up.
 */
export const BrandMark = ({ size = 32, className = '' }: { size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="SmartConnect" className={`shrink-0 text-brand ${className}`}>
    <rect width="32" height="32" rx="9" fill="currentColor" />
    <path
      d="M21.5 9.2H14.4a3.6 3.6 0 0 0 0 7.2h3.2a3.6 3.6 0 0 1 0 7.2H10.5"
      fill="none"
      stroke="var(--color-on-brand)"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="22.2" cy="9.2" r="2.3" fill="var(--color-on-brand)" />
    <circle cx="9.8" cy="23.6" r="2.3" fill="var(--color-on-brand)" />
  </svg>
);

/** Mark + wordmark, for headers and auth screens. */
export const BrandLockup = ({ size = 28, className = '' }: { size?: number; className?: string }) => (
  <span className={`inline-flex items-center gap-2.5 ${className}`}>
    <BrandMark size={size} />
    <span className="text-[15px] font-semibold tracking-[-0.01em] text-fg">
      Smart<span className="text-brand">Connect</span>
    </span>
  </span>
);
