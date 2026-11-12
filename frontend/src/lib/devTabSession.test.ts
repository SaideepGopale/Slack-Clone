import { afterEach, describe, expect, it } from 'vitest';
import {
  applyTabSessionUrl,
  clearStoredToken,
  disableTabSession,
  enableTabSession,
  isLocalDevHost,
  isTabSessionActive,
  readStoredToken,
  writeStoredToken,
} from './devTabSession';

/**
 * T.37 — development-only per-tab sign-in. By default the token lives where
 * it always has (localStorage "token", shared by every tab). A tab that opts
 * in keeps its own token in sessionStorage, which the browser keeps per tab.
 */
afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('token storage (T.37)', () => {
  it('by default uses the shared localStorage token, exactly as before', () => {
    expect(isTabSessionActive()).toBe(false);
    writeStoredToken('shared-tok');
    expect(localStorage.getItem('token')).toBe('shared-tok');
    expect(readStoredToken()).toBe('shared-tok');
    clearStoredToken();
    expect(localStorage.getItem('token')).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('treats the legacy "null"/"undefined" strings as no token', () => {
    localStorage.setItem('token', 'null');
    expect(readStoredToken()).toBeNull();
    localStorage.setItem('token', 'undefined');
    expect(readStoredToken()).toBeNull();
  });

  it('?tabSession=1 gives this tab its own sign-in: starts signed out, never reads or writes the shared token, and leaves the address clean', () => {
    localStorage.setItem('token', 'shared-tok');
    window.history.replaceState(null, '', '/login?tabSession=1&next=x#h');
    applyTabSessionUrl();
    expect(isTabSessionActive()).toBe(true);
    expect(window.location.search).toBe('?next=x');
    expect(window.location.hash).toBe('#h');

    expect(readStoredToken()).toBeNull(); // not the shared one
    writeStoredToken('tab-tok');
    expect(readStoredToken()).toBe('tab-tok');
    expect(localStorage.getItem('token')).toBe('shared-tok'); // untouched
    clearStoredToken();
    expect(readStoredToken()).toBeNull();
    expect(localStorage.getItem('token')).toBe('shared-tok'); // still untouched
  });

  it('?tabSession=0 and disableTabSession() return the tab to the shared sign-in and drop its own token', () => {
    localStorage.setItem('token', 'shared-tok');
    enableTabSession();
    writeStoredToken('tab-tok');
    window.history.replaceState(null, '', '/?tabSession=0');
    applyTabSessionUrl();
    expect(isTabSessionActive()).toBe(false);
    expect(readStoredToken()).toBe('shared-tok');
    expect(Object.keys(sessionStorage)).toEqual([]);

    enableTabSession();
    writeStoredToken('tab-tok-2');
    disableTabSession();
    expect(isTabSessionActive()).toBe(false);
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  it('is offered only on a local development host', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', '::1']) expect(isLocalDevHost(host)).toBe(true);
    for (const host of ['smartconnect-frontend.onrender.com', 'example.com', '192.168.1.20', 'localhost.evil.com', '']) expect(isLocalDevHost(host)).toBe(false);
  });
});
