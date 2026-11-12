import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DevTabSessionPanel from './DevTabSessionPanel';

/** T.37 — the development-only per-tab sign-in control. */
const auth = vi.hoisted(() => ({ user: null as { username: string } | null, logout: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

beforeEach(() => {
  auth.user = null;
  document.title = 'SmartConnect';
});
afterEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe('DevTabSessionPanel (T.37)', () => {
  it('in a shared tab offers a separate sign-in for this tab, without signing anyone out', () => {
    auth.user = { username: 'lead' };
    const reload = vi.fn();
    render(<DevTabSessionPanel reload={reload} />);
    const region = screen.getByRole('region', { name: 'Development tab sign-in' });
    expect(region).toHaveTextContent('Shared sign-in');
    fireEvent.click(screen.getByRole('button', { name: 'Use a separate sign-in in this tab' }));
    expect(sessionStorage.getItem('smartconnect:dev:tab-session')).toBe('1');
    expect(auth.logout).not.toHaveBeenCalled(); // the shared session other tabs use stays alive
    expect(reload).toHaveBeenCalledTimes(1);
    expect(document.title).toBe('SmartConnect');
  });

  it('in an isolated tab shows whose tab it is, in the panel and the tab title', async () => {
    sessionStorage.setItem('smartconnect:dev:tab-session', '1');
    auth.user = { username: 'dev1' };
    render(<DevTabSessionPanel reload={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Development tab sign-in' })).toHaveTextContent('This tab: dev1');
    await waitFor(() => expect(document.title).toBe('[dev1] SmartConnect'));
    // Pages that set their own title keep the prefix.
    document.title = '#general · SmartConnect';
    await waitFor(() => expect(document.title).toBe('[dev1] #general · SmartConnect'));
  });

  it('leaving an isolated tab signs out only this tab, then returns it to the shared sign-in', () => {
    sessionStorage.setItem('smartconnect:dev:tab-session', '1');
    sessionStorage.setItem('smartconnect:dev:tab-token', 'tab-tok');
    auth.user = { username: 'dev1' };
    const reload = vi.fn();
    render(<DevTabSessionPanel reload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Leave this tab’s separate sign-in' }));
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('smartconnect:dev:tab-session')).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('an isolated tab that is signed out says so', () => {
    sessionStorage.setItem('smartconnect:dev:tab-session', '1');
    render(<DevTabSessionPanel reload={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Development tab sign-in' })).toHaveTextContent('This tab: signed out');
  });
});
