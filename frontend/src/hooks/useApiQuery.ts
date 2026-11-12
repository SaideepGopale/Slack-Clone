import { DependencyList, Dispatch, SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, toApiError } from '../lib/api';

interface Options {
  /** Skip loading (e.g. no permission) — data stays undefined. */
  enabled?: boolean;
  /**
   * Refetch silently when the tab regains focus/visibility. Used for data the
   * backend has no live events for (invitations, join requests, joins).
   */
  refetchOnFocus?: boolean;
}

export interface ApiQuery<T> {
  data: T | undefined;
  error: ApiError | null;
  /** True during the first load for the current dependencies. */
  loading: boolean;
  /** Re-runs the request; `silent` keeps the current data on screen. */
  reload: (options?: { silent?: boolean }) => Promise<void>;
  setData: Dispatch<SetStateAction<T | undefined>>;
}

/**
 * Minimal data hook for the F2 admin screens: one request per dependency
 * change, stale responses ignored (only the latest request may write state),
 * errors normalized to ApiError so 403/404 can be told apart.
 */
export const useApiQuery = <T>(fetcher: () => Promise<T>, deps: DependencyList, { enabled = true, refetchOnFocus = false }: Options = {}): ApiQuery<T> => {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(enabled);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const latest = useRef(0);

  const reload = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    const id = ++latest.current;
    if (!silent) setLoading(true);
    try {
      const result = await fetcherRef.current();
      if (id !== latest.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (id !== latest.current) return;
      setError(toApiError(err));
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      latest.current++;
      setData(undefined);
      setError(null);
      setLoading(false);
      return;
    }
    setData(undefined);
    reload().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, reload, ...deps]);

  useEffect(() => {
    if (!enabled || !refetchOnFocus) return;
    let last = 0;
    const onFocus = () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - last < 1000) return; // focus + visibilitychange fire together
      last = now;
      reload({ silent: true }).catch(() => undefined);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [enabled, refetchOnFocus, reload]);

  return { data, error, loading, reload, setData };
};
