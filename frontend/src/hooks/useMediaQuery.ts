import { useEffect, useState } from 'react';

/**
 * T.39 — responsive tiers (Tailwind's default breakpoints):
 *   phone   < 768px   (below `md`)
 *   tablet  768–1023px (`md` to below `lg`)
 *   desktop ≥ 1024px  (`lg` and up — the approved desktop design)
 */
export const PHONE_QUERY = '(max-width: 767.98px)';
export const TABLET_QUERY = '(min-width: 768px) and (max-width: 1023.98px)';
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

const matches = (query: string) => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;

/** Live result of a CSS media query (false where matchMedia is unavailable, e.g. jsdom). */
export const useMediaQuery = (query: string) => {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const update = () => setValue(mql.matches);
    update();
    mql.addEventListener?.('change', update);
    return () => mql.removeEventListener?.('change', update);
  }, [query]);
  return value;
};

/** For event handlers (no re-render needed). */
export const isPhoneWidth = () => matches(PHONE_QUERY);
export const isTabletWidth = () => matches(TABLET_QUERY);
