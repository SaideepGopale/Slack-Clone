import { useSyncExternalStore } from 'react';

/**
 * P2 Phase J — light/dark theme. The preference ("light", "dark" or follow
 * the "system") is a per-browser convenience in localStorage; the resolved
 * theme is applied as `html.dark` + `data-theme`, which index.css uses to
 * swap the design tokens.
 */
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'smartconnect:theme';
const PREFERENCES = new Set<ThemePreference>(['light', 'dark', 'system']);

// This page's choice when storage can't hold it (private mode, blocked data).
let memoryPreference: ThemePreference | null = null;

export const getThemePreference = (): ThemePreference => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY) as ThemePreference | null;
    return stored && PREFERENCES.has(stored) ? stored : 'system';
  } catch {
    return memoryPreference ?? 'system';
  }
};

const systemPrefersDark = () => {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
};

export const resolveTheme = (preference: ThemePreference, systemDark: boolean): ResolvedTheme =>
  preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

const listeners = new Set<(theme: ResolvedTheme) => void>();
let current: ResolvedTheme = 'light';

/** Applies the stored preference to the document (and keeps following the OS on "system"). */
export const applyTheme = (): ResolvedTheme => {
  const theme = resolveTheme(getThemePreference(), systemPrefersDark());
  const root = document.documentElement;
  // T.32: when the theme actually changes (not on first paint), colours ease
  // over 200ms instead of snapping (index.css `html.theme-transition`;
  // collapsed by prefers-reduced-motion).
  if (theme !== current && root.classList.contains('dark') !== (theme === 'dark') && root.dataset.theme) {
    root.classList.add('theme-transition');
    window.setTimeout(() => root.classList.remove('theme-transition'), 260);
  }
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  if (theme !== current) {
    current = theme;
    listeners.forEach((fn) => fn(theme));
  }
  return theme;
};

/** Re-applies the theme when the OS setting changes while on "system". Returns a cleanup. */
export const watchSystemTheme = (): (() => void) => {
  try {
    if (typeof matchMedia !== 'function') return () => undefined;
    const mql = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (getThemePreference() === 'system') applyTheme();
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  } catch {
    // No media-query support: explicit choices still work.
    return () => undefined;
  }
};

export const setThemePreference = (preference: ThemePreference) => {
  if (!PREFERENCES.has(preference)) return applyTheme();
  memoryPreference = preference;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Not persisted (private mode) — still applied for this page.
  }
  return applyTheme();
};

/** Returns an unsubscribe function. */
export const subscribeTheme = (fn: (theme: ResolvedTheme) => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** The theme currently on screen, re-rendering when it changes. */
export const useResolvedTheme = (): ResolvedTheme =>
  useSyncExternalStore(
    (onChange) => subscribeTheme(() => onChange()),
    () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
    () => 'light'
  );
