import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, toApiError } from '../lib/api';
import type { Page } from '../lib/api';

export interface PagedSearch<T> {
  items: T[];
  setItems: Dispatch<SetStateAction<T[]>>;
  query: string;
  setQuery: (q: string) => void;
  loading: boolean;
  loadingMore: boolean;
  error: ApiError | null;
  hasMore: boolean;
  loadMore: () => void;
  /** Silent refresh of the first page (keeps the list on screen). */
  refresh: () => void;
}

/**
 * Debounced server-side search over a cursor-paginated endpoint (the
 * organization and workspace member directories). Only the newest request may
 * write state, so fast typing can't show an older query's results.
 */
export const usePagedSearch = <T>(fetchPage: (q: string, cursor: string | null) => Promise<Page<T>>, key: string, debounceMs = 250): PagedSearch<T> => {
  const [items, setItems] = useState<T[]>([]);
  const [query, setQueryState] = useState('');
  const [debounced, setDebounced] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const latest = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), debounceMs);
    return () => clearTimeout(timer);
  }, [query, debounceMs]);

  const loadFirst = useCallback(async (q: string, silent: boolean) => {
    const id = ++latest.current;
    if (!silent) setLoading(true);
    try {
      const page = await fetchRef.current(q, null);
      if (id !== latest.current) return;
      setItems(page.items);
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      if (id === latest.current) setError(toApiError(err));
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFirst(debounced, false).catch(() => undefined);
  }, [debounced, key, loadFirst]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    const id = latest.current;
    setLoadingMore(true);
    fetchRef
      .current(debounced, cursor)
      .then((page) => {
        if (id !== latest.current) return;
        setItems((prev) => [...prev, ...page.items]);
        setCursor(page.nextCursor);
      })
      .catch((err) => {
        if (id === latest.current) setError(toApiError(err));
      })
      .finally(() => setLoadingMore(false));
  }, [cursor, debounced, loadingMore]);

  const refresh = useCallback(() => {
    loadFirst(debounced, true).catch(() => undefined);
  }, [debounced, loadFirst]);

  return {
    items,
    setItems,
    query,
    setQuery: setQueryState,
    loading,
    loadingMore,
    error,
    hasMore: !!cursor,
    loadMore,
    refresh,
  };
};
