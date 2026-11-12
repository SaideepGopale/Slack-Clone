/**
 * Deployment settings derived from environment variables — pure functions with
 * no side effects, so they can be unit-tested without starting the app.
 * config/env.ts applies them to the real environment.
 */

/** The local frontend dev server (frontend/vite.config.ts: port 5174, strictPort). */
export const DEV_APP_URL = 'http://localhost:5174';

/** Local frontend origins: Vite dev (5174, plus Vite's default 5173) and `vite preview` (4173). */
export const LOCAL_DEV_ORIGINS = [5174, 5173, 4173].flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]);

/**
 * The frontend's public origin (APP_URL): trimmed, trailing slashes removed so
 * it matches a browser's Origin header exactly and links never get "//".
 * Returns null when it is not an absolute http(s) URL.
 */
export const normalizeAppUrl = (raw: string | undefined): string | null => {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  return value;
};

/** Origins allowed to call the API with credentials: APP_URL, plus local dev origins outside production. */
export const corsOrigins = (nodeEnv: string, appUrl: string): string[] =>
  nodeEnv === 'production' ? [appUrl] : [...new Set([appUrl, ...LOCAL_DEV_ORIGINS])];

/**
 * Express "trust proxy". On Render every request arrives through one load
 * balancer that appends the client address to X-Forwarded-For, so production
 * trusts exactly 1 hop (req.ip = the real client, per-client rate limits).
 * Elsewhere nothing is trusted (a client could spoof the header). TRUST_PROXY
 * overrides it: a hop count, "true"/"false", or an Express trust value such
 * as "loopback".
 */
export const trustProxySetting = (nodeEnv: string, raw: string | undefined): boolean | number | string => {
  const value = (raw ?? '').trim();
  if (!value) return nodeEnv === 'production' ? 1 : false;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};
