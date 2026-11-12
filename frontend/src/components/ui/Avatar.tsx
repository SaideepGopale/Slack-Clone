/**
 * Initial-based avatar (T.32 design system). Each person gets a stable,
 * muted colour derived from their name, so a conversation is scannable at a
 * glance without the same gradient on everyone. White text on every swatch
 * meets 4.5:1. Optional presence dot with a ring in the surface colour; the
 * presence is also given as text for assistive technology.
 */
const SWATCHES = ['#0b7c86', '#3a6ea5', '#7a5195', '#a8456b', '#b25a2b', '#5f7d2e', '#2e7d5b', '#5a6270', '#8a6a1f', '#4b5fbf'];

const hash = (value: string) => {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h);
};

export const avatarColor = (name: string | null | undefined) => SWATCHES[hash(name || '?') % SWATCHES.length];

const SIZES = {
  xs: 'h-5 w-5 text-[10px] rounded-md',
  sm: 'h-7 w-7 text-xs rounded-md',
  md: 'h-9 w-9 text-sm rounded-lg',
  lg: 'h-11 w-11 text-base rounded-xl',
} as const;

export type Presence = 'online' | 'away' | 'offline';

export const Avatar = ({
  name,
  size = 'md',
  presence,
  initials = 1,
  className = '',
}: {
  name: string | null | undefined;
  size?: keyof typeof SIZES;
  presence?: Presence;
  /** How many leading characters to show (1, or 2 for the account button). */
  initials?: 1 | 2;
  className?: string;
}) => (
  <span className={`relative inline-flex shrink-0 ${className}`}>
    <span
      aria-hidden="true"
      className={`flex select-none items-center justify-center font-semibold uppercase text-white ${SIZES[size]}`}
      style={{ backgroundColor: avatarColor(name) }}
    >
      {((name || '?').trim().slice(0, initials) || '?').toUpperCase()}
    </span>
    {presence && presence !== 'offline' && (
      <span
        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${presence === 'online' ? 'bg-presence-online' : 'bg-presence-away'}`}
        aria-hidden="true"
      />
    )}
    {presence && <span className="sr-only">{presence === 'online' ? 'online' : presence === 'away' ? 'away' : 'offline'}</span>}
  </span>
);
