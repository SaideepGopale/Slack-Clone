import axios from 'axios';
import { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import { WorkspacesProvider } from '../pages/workspace/WorkspacesProvider';

/**
 * Shared harness for the F2 administration tests: a fake REST backend keyed by
 * "METHOD /path" (the real typed API layer and the real WorkspacesProvider run
 * on top of the mocked axios), a fake Socket.IO client, and a router.
 * The test file itself must `vi.mock('axios', ...)` (hoisting).
 */

export type Handler = (body: unknown, params?: Record<string, unknown>) => unknown;
export interface Route_ {
  status?: number;
  data?: unknown;
  handler?: Handler;
}

export const httpError = (status: number, error: string) => ({ response: { status, data: { error } } });

export class FakeBackend {
  routes = new Map<string, Route_ | Handler | unknown>();
  calls: { method: string; url: string; body?: unknown; params?: Record<string, unknown> }[] = [];

  on(key: string, value: Route_ | Handler | unknown) {
    this.routes.set(key, value);
    return this;
  }

  install() {
    const api = vi.mocked(axios, true);
    const respond = (method: string) => (url: string, a?: unknown, b?: unknown) => {
      const body = method === 'GET' || method === 'DELETE' ? undefined : a;
      const params = method === 'GET' ? (a as { params?: Record<string, unknown> } | undefined)?.params : (b as { params?: Record<string, unknown> } | undefined)?.params;
      this.calls.push({ method, url, body, params });
      const route = this.routes.get(`${method} ${url}`);
      if (route === undefined) return Promise.reject(httpError(404, `No fake route for ${method} ${url}`));
      try {
        const value = typeof route === 'function' ? (route as Handler)(body, params) : route;
        if (value && typeof value === 'object' && 'response' in (value as object)) return Promise.reject(value);
        return Promise.resolve({ data: value });
      } catch (err) {
        return Promise.reject(err);
      }
    };
    api.get.mockImplementation(respond('GET') as never);
    api.post.mockImplementation(respond('POST') as never);
    api.put.mockImplementation(respond('PUT') as never);
    api.patch.mockImplementation(respond('PATCH') as never);
    api.delete.mockImplementation(respond('DELETE') as never);
    return this;
  }

  called(method: string, url: string) {
    return this.calls.filter((c) => c.method === method && c.url === url);
  }
}

/** Minimal Socket.IO stand-in: on/off/emit. */
export class FakeSocket {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();
  on(event: string, fn: (payload: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
    return this;
  }
  off(event: string, fn: (payload: unknown) => void) {
    this.handlers.get(event)?.delete(fn);
    return this;
  }
  emit(event: string, payload: unknown) {
    this.handlers.get(event)?.forEach((fn) => fn(payload));
  }
}

export const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
};

/** Renders `element` at `path` under the given route pattern, inside the real WorkspacesProvider. */
export const renderAt = (path: string, pattern: string, element: ReactNode, extraRoutes: { path: string; element: ReactNode }[] = []) => (
  <MemoryRouter initialEntries={[path]}>
    <WorkspacesProvider>
      <Routes>
        <Route path={pattern} element={element} />
        {extraRoutes.map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
        <Route path="*" element={<p>elsewhere</p>} />
      </Routes>
      <LocationProbe />
    </WorkspacesProvider>
  </MemoryRouter>
);
