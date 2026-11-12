/**
 * T.37 — where this tab keeps its sign-in token.
 *
 * Production (and by default everywhere): localStorage "token", shared by
 * every tab of the origin — unchanged behaviour.
 *
 * LOCAL DEVELOPMENT ONLY: a tab may opt in to its own sign-in ("isolated tab
 * session") to test several users side by side in one browser profile. Its
 * token then lives in sessionStorage, which the browser keeps per tab, so
 * signing in or out there never touches another tab's identity. Nothing on
 * the server changes: every tab still holds an ordinary token for its own
 * server-side session (validated on every request, revoked on logout).
 *
 * Available only when this is a Vite development build (import.meta.env.DEV
 * is replaced by `false` in production builds, so the minifier drops every
 * isolated-session branch) AND the page is served from localhost.
 * Opt in with ?tabSession=1 (or the development panel); ?tabSession=0 leaves.
 */

const DEV_BUILD = import.meta.env.DEV;
const SHARED_TOKEN_KEY = 'token';
const MODE_KEY = 'smartconnect:dev:tab-session';
const TAB_TOKEN_KEY = 'smartconnect:dev:tab-token';
const URL_PARAM = 'tabSession';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const isLocalDevHost = (hostname: string) => LOCAL_HOSTS.has(hostname);

const session = (): Storage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
};

/** Whether this build and host may offer isolated tab sessions at all. */
export const tabSessionsAvailable = (): boolean => DEV_BUILD && typeof window !== 'undefined' && isLocalDevHost(window.location.hostname);

/** Whether this tab currently keeps its own sign-in. */
export const isTabSessionActive = (): boolean => DEV_BUILD && tabSessionsAvailable() && session()?.getItem(MODE_KEY) === '1';

export const enableTabSession = () => {
  if (!tabSessionsAvailable()) return;
  session()?.setItem(MODE_KEY, '1');
};

/** Back to the shared sign-in; this tab's own token is dropped (sign it out first). */
export const disableTabSession = () => {
  if (!DEV_BUILD) return;
  session()?.removeItem(TAB_TOKEN_KEY);
  session()?.removeItem(MODE_KEY);
};

/** Applies ?tabSession=1|0 and removes it from the address bar. Call before reading the token. */
export const applyTabSessionUrl = () => {
  if (!tabSessionsAvailable()) return;
  const url = new URL(window.location.href);
  const value = url.searchParams.get(URL_PARAM);
  if (value === null) return;
  if (value === '1') enableTabSession();
  else if (value === '0') disableTabSession();
  url.searchParams.delete(URL_PARAM);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
};

const clean = (token: string | null) => (token && token !== 'null' && token !== 'undefined' ? token : null);

export const readStoredToken = (): string | null => {
  if (isTabSessionActive()) return clean(session()?.getItem(TAB_TOKEN_KEY) ?? null);
  return clean(localStorage.getItem(SHARED_TOKEN_KEY));
};

export const writeStoredToken = (token: string) => {
  if (isTabSessionActive()) session()?.setItem(TAB_TOKEN_KEY, token);
  else localStorage.setItem(SHARED_TOKEN_KEY, token);
};

export const clearStoredToken = () => {
  if (isTabSessionActive()) session()?.removeItem(TAB_TOKEN_KEY);
  else localStorage.removeItem(SHARED_TOKEN_KEY);
};
