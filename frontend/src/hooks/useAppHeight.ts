import { useEffect } from 'react';

/**
 * T.39 — keeps `--app-height` equal to the visible viewport's height, so the
 * app shell (and the message composer at its bottom) shrinks above an
 * on-screen keyboard. Chrome on Android also resizes the layout viewport
 * (viewport meta `interactive-widget=resizes-content`); Safari on iOS only
 * shrinks the visual viewport, which this follows. The shell uses the
 * variable below the desktop breakpoint only (`max-lg:`), so desktop layout
 * is unaffected.
 */
export const useAppHeight = () => {
  useEffect(() => {
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!viewport) return;
    const root = document.documentElement;
    let frame = 0;
    const apply = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        root.style.setProperty('--app-height', `${Math.round(viewport.height)}px`);
        // iOS may scroll the (non-scrolling) page when the keyboard opens; keep the shell in place.
        if (window.scrollY !== 0 && viewport.height < window.innerHeight) window.scrollTo(0, 0);
      });
    };
    apply();
    viewport.addEventListener('resize', apply);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', apply);
      root.style.removeProperty('--app-height');
    };
  }, []);
};
