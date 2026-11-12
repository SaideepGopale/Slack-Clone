import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T.33 — command palette: opens with Ctrl/⌘+K, searches both endpoints,
 * groups results, is fully keyboard-driven and navigates to the right place.
 */
const axiosMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), defaults: { headers: { common: {} } } }));
vi.mock('axios', () => ({ default: axiosMock }));

import { CommandPalette } from './CommandPalette';

const WS = 'ws-1';
const Where = () => {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
};

const renderPalette = (onMessagePerson = vi.fn()) =>
  render(
    <MemoryRouter initialEntries={[`/${WS}/home`]}>
      <Routes>
        <Route path="*" element={<><CommandPalette workspaceId={WS} onMessagePerson={onMessagePerson} /><Where /></>} />
      </Routes>
    </MemoryRouter>
  );

const everything = {
  tasks: [{ id: 't1', identifier: 'WEB-7', title: 'Fix login', status: 'IN_PROGRESS', projectId: 'p1', project: { name: 'Website' } }],
  projects: [{ id: 'p1', name: 'Website', key: 'WEB', status: 'ACTIVE', archived: false }],
  channels: [{ id: 'c1', name: 'web-team', visibility: 'PUBLIC', archived: false, isMember: true }],
  people: [{ id: 'u1', username: 'webby', displayName: 'Web Lead', title: null }],
  files: [{ id: 'f1', name: 'web-spec.pdf', channelId: 'c1', messageId: 'm9', channelName: 'web-team' }],
};
const messages = { results: [{ id: 'm1', parentId: null, createdAt: '2026-11-01T00:00:00Z', preview: '<p>web launch notes</p>', sender: { id: 'u2', username: 'ann' }, channel: { id: 'c1', name: 'web-team' } }] };

beforeEach(() => {
  axiosMock.get.mockImplementation((url: string) =>
    Promise.resolve({ data: url.endsWith('/search/all') ? everything : messages })
  );
});
afterEach(() => vi.clearAllMocks());

const open = () => fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

describe('CommandPalette (T.33)', () => {
  it('opens with Ctrl+K, shows quick navigation, and closes with Escape', async () => {
    renderPalette();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    open();
    const input = await screen.findByRole('combobox', { name: /Search tasks, projects/ });
    expect(screen.getByRole('option', { name: /My tasks/ })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('searches tasks, projects, channels, people, messages and files, grouped', async () => {
    renderPalette();
    open();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'web' } });
    expect(await screen.findByRole('option', { name: /WEB-7 Fix login/ })).toBeInTheDocument();
    for (const name of [/^Website/, /web-team/, /Web Lead/, /web launch notes/, /web-spec\.pdf/]) {
      expect(screen.getAllByRole('option', { name }).length).toBeGreaterThan(0);
    }
    const urls = axiosMock.get.mock.calls.map(([url, config]) => [url, config?.params?.q]);
    expect(urls).toEqual(expect.arrayContaining([[`/api/workspaces/${WS}/search/all`, 'web'], [`/api/workspaces/${WS}/search`, 'web']]));
  });

  it('is keyboard driven: arrows move, Enter opens the task on its project board', async () => {
    renderPalette();
    open();
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: 'web' } });
    await screen.findByRole('option', { name: /WEB-7/ });
    expect(screen.getByRole('option', { name: /WEB-7/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /^Website/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('where')).toHaveTextContent(`/${WS}/projects/p1?task=t1`);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('choosing a person starts a conversation with them', async () => {
    const onMessagePerson = vi.fn();
    renderPalette(onMessagePerson);
    open();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'web' } });
    fireEvent.click(await screen.findByRole('option', { name: /Web Lead/ }));
    expect(onMessagePerson).toHaveBeenCalledWith('u1');
  });

  it('explains when search is unavailable', async () => {
    axiosMock.get.mockRejectedValue({ response: { status: 500, data: {} } });
    renderPalette();
    open();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'web' } });
    expect(await screen.findByText(/Search is unavailable/)).toBeInTheDocument();
  });

  it('opens from the header button event too', async () => {
    renderPalette();
    act(() => {
      window.dispatchEvent(new Event('smartconnect:open-palette'));
    });
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Search and jump' })).toBeInTheDocument());
  });
});
