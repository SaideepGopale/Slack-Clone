import axios, { AxiosRequestConfig } from 'axios';
import './config';

/**
 * Typed API layer (F1). Every helper goes through the DEFAULT axios instance,
 * so it inherits — without touching — the existing configuration:
 *  - `axios.defaults.baseURL` (lib/api/config.ts, from VITE_API_URL),
 *  - the Authorization header and response interceptor installed by
 *    contexts/AuthContext.tsx (session behaviour is unchanged).
 * Errors are normalized into ApiError so callers handle them one way.
 */

export class ApiError extends Error {
  readonly status: number | null;
  readonly data: unknown;

  constructor(message: string, status: number | null, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }

  get isNotFound() {
    return this.status === 404;
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isUnauthorized() {
    return this.status === 401;
  }
  /** No response at all (offline, CORS, server down). */
  get isNetwork() {
    return this.status === null;
  }
}

/** Best human-readable message for any thrown value (server `{ error }` first). */
export const errorMessage = (err: unknown, fallback = 'Something went wrong. Please try again.') => {
  if (err instanceof ApiError) return err.message || fallback;
  const response = (err as { response?: { data?: { error?: unknown } } })?.response;
  const serverMessage = response?.data?.error;
  return typeof serverMessage === 'string' && serverMessage ? serverMessage : fallback;
};

export const toApiError = (err: unknown): ApiError => {
  if (err instanceof ApiError) return err;
  const response = (err as { response?: { status?: number; data?: unknown } })?.response;
  if (response) return new ApiError(errorMessage(err, `Request failed (${response.status})`), response.status ?? null, response.data);
  return new ApiError('Network error — check your connection and try again.', null);
};

const call = async <T>(run: () => Promise<{ data: T }>): Promise<T> => {
  try {
    return (await run()).data;
  } catch (err) {
    throw toApiError(err);
  }
};

export const http = {
  get: <T>(url: string, params?: AxiosRequestConfig['params']) => call<T>(() => (params ? axios.get<T>(url, { params }) : axios.get<T>(url))),
  post: <T>(url: string, body?: unknown) => call<T>(() => axios.post<T>(url, body)),
  put: <T>(url: string, body?: unknown) => call<T>(() => axios.put<T>(url, body)),
  patch: <T>(url: string, body?: unknown) => call<T>(() => axios.patch<T>(url, body)),
  delete: <T>(url: string) => call<T>(() => axios.delete<T>(url)),
};

/** Encodes one path segment (ids are UUIDs, but never trust a caller). */
export const seg = (value: string) => encodeURIComponent(value);
