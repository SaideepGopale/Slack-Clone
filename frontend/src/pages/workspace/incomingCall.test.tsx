import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IncomingCallBanner } from '../../components/chat/CallOverlay';
import { MAX_CALLER_NAME_LENGTH, parseIncomingCall } from '../../lib/callSignalling';
import { useWorkspace } from './WorkspaceContext';
import { WorkspaceLayout } from './WorkspaceLayout';

/**
 * P1-B — FA-RT-02, client side: a `call:incoming` payload is untrusted input.
 * Malformed rings are ignored, the ringing banner never crashes on what it is
 * given, a caller never sends its own name, and accepting a valid ring starts
 * exactly the validated call type.
 */

/** Socket stand-in: records emits; `receive` delivers a server event to the registered listeners. */
class FakeSocket {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();
  sent: { event: string; payload: unknown }[] = [];
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
    this.sent.push({ event, payload });
    return this;
  }
  receive(event: string, payload: unknown) {
    this.handlers.get(event)?.forEach((fn) => fn(payload));
  }
  emitted(event: string) {
    return this.sent.filter((s) => s.event === event).map((s) => s.payload);
  }
}

// Stable identities, like the real providers (effects depend on them).
const harness = vi.hoisted(() => ({
  auth: { user: { id: 'me', username: 'mia' }, token: 'token' },
  socket: null as unknown,
  workspaces: { getWorkspace: () => ({ id: 'ws1', name: 'Apollo' }), loading: false, refresh: async () => [] },
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => harness.auth }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => harness.socket, useConnectionStatus: () => 'connected' }));
vi.mock('./WorkspacesProvider', () => ({ useWorkspaces: () => harness.workspaces, useWorkspaceLiveUpdates: () => undefined }));
vi.mock('axios', () => ({
  default: {
    get: async (url: string) => ({
      data: url.endsWith('/unread') ? { channels: [] } : url.endsWith('/channels') ? [{ id: 'chan-1', name: 'general' }] : [],
    }),
    post: async () => ({ data: {} }),
    patch: async () => ({ data: {} }),
    defaults: { headers: { common: {} } },
  },
}));
vi.mock('../../components/layout/Header', () => ({ Header: () => null }));
vi.mock('../../components/sidebar/Sidebar', () => ({ Sidebar: () => null }));
vi.mock('../../components/sidebar/WorkspaceSwitcher', () => ({ WorkspaceSwitcher: () => null }));
// The real ringing banner, but a stand-in for the in-call overlay (which would open the microphone).
vi.mock('../../components/chat/CallOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/chat/CallOverlay')>()),
  CallOverlay: ({ channelId, callType }: { channelId: string; callType: string }) => (
    <div data-testid="call-overlay">{`${callType} call in ${channelId}`}</div>
  ),
}));

const noop = () => undefined;

describe('parseIncomingCall', () => {
  it('accepts a valid ring and keeps only the fields the UI uses', () => {
    expect(parseIncomingCall({ channelId: 'c1', callerName: 'bob', callType: 'video', from: 'u2', extra: 1 })).toEqual({
      channelId: 'c1',
      callerName: 'bob',
      callType: 'video',
    });
  });

  it('a missing, blank or non-text caller name falls back to "Someone" (the ring is kept)', () => {
    for (const callerName of [undefined, null, '', '   ', 42, {}, ['bob'], { toString: () => 'bob' }]) {
      expect(parseIncomingCall({ channelId: 'c1', callType: 'audio', callerName })).toEqual({ channelId: 'c1', callType: 'audio', callerName: 'Someone' });
    }
  });

  it('an oversized caller name is trimmed and bounded', () => {
    const ring = parseIncomingCall({ channelId: 'c1', callType: 'audio', callerName: `  ${'B'.repeat(10_000)}  ` });
    expect(ring?.callerName).toBe('B'.repeat(MAX_CALLER_NAME_LENGTH));
  });

  it('malformed or missing call types are rejected', () => {
    for (const callType of [undefined, null, 42, true, {}, ['audio']]) {
      expect(parseIncomingCall({ channelId: 'c1', callerName: 'bob', callType })).toBeNull();
    }
  });

  it('unsupported call types are rejected (only "audio" and "video" exist)', () => {
    for (const callType of ['screen', 'conference', 'AUDIO', 'Video', 'audio ', '']) {
      expect(parseIncomingCall({ channelId: 'c1', callerName: 'bob', callType })).toBeNull();
    }
  });

  it('malformed payloads and channel ids are rejected', () => {
    for (const payload of [null, undefined, 'ring', 42, [], ['c1', 'audio']]) expect(parseIncomingCall(payload)).toBeNull();
    for (const channelId of [undefined, '', 'x'.repeat(129), 42, { id: 'c1' }]) {
      expect(parseIncomingCall({ channelId, callerName: 'bob', callType: 'audio' })).toBeNull();
    }
  });
});

describe('IncomingCallBanner', () => {
  it('renders a valid ring and wires Accept and Decline', () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    render(<IncomingCallBanner callerName="bob" callType="video" onAccept={onAccept} onDecline={onDecline} />);
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText(/Incoming video call/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Accept/ }));
    fireEvent.click(screen.getByRole('button', { name: /Decline/ }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('does not crash on a malformed caller name', () => {
    for (const callerName of [null, undefined, 42, {}, { name: 'x' }, ['bob'], '', '   ']) {
      const { unmount } = render(<IncomingCallBanner callerName={callerName as unknown as string} callType="audio" onAccept={noop} onDecline={noop} />);
      expect(screen.getByText('Someone')).toBeInTheDocument();
      expect(screen.getByText('S')).toBeInTheDocument(); // avatar initial
      unmount();
    }
  });

  it('shows an unknown call type as audio (the type that never uses the camera)', () => {
    for (const callType of ['screen', undefined, null, 42, {}]) {
      const { unmount } = render(<IncomingCallBanner callerName="bob" callType={callType as unknown as 'audio'} onAccept={noop} onDecline={noop} />);
      expect(screen.getByText(/Incoming audio call/)).toBeInTheDocument();
      unmount();
    }
  });

  it('bounds a very long caller name', () => {
    render(<IncomingCallBanner callerName={'A'.repeat(5_000)} callType="audio" onAccept={noop} onDecline={noop} />);
    expect(screen.getByText('A'.repeat(MAX_CALLER_NAME_LENGTH))).toHaveAttribute('title', 'A'.repeat(MAX_CALLER_NAME_LENGTH));
  });
});

describe('WorkspaceLayout incoming calls', () => {
  // A page inside the layout that starts a call the way the real headers do.
  const StartCallProbe = () => {
    const { startCall } = useWorkspace();
    return (
      <button type="button" onClick={() => startCall('chan-1', 'audio')}>
        probe: start audio call
      </button>
    );
  };

  const renderLayout = async () => {
    render(
      <MemoryRouter initialEntries={['/ws1/c/chan-1']}>
        <Routes>
          <Route path="/:workspaceId" element={<WorkspaceLayout />}>
            <Route path="c/:channelId" element={<StartCallProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    await screen.findByRole('button', { name: 'probe: start audio call' });
    return harness.socket as FakeSocket;
  };

  beforeEach(() => {
    harness.socket = new FakeSocket();
  });

  it('ignores malformed rings without crashing the layout', async () => {
    const socket = await renderLayout();
    const malformed = [
      null,
      undefined,
      'ring',
      42,
      [],
      { channelId: 'chan-1' },
      { channelId: 'chan-1', callType: 'screen', callerName: 'bob' },
      { channelId: 'chan-1', callType: { kind: 'video' }, callerName: 'bob' },
      { callType: 'audio', callerName: 'bob' },
      { channelId: { id: 'chan-1' }, callType: 'audio', callerName: 'bob' },
      { channelId: 'x'.repeat(129), callType: 'audio', callerName: 'bob' },
    ];
    for (const payload of malformed) act(() => socket.receive('call:incoming', payload));
    expect(screen.queryByText(/Incoming/)).toBeNull();
    expect(screen.getByRole('button', { name: 'probe: start audio call' })).toBeInTheDocument();
  });

  it('still rings for a valid call whose caller name is malformed', async () => {
    const socket = await renderLayout();
    act(() => socket.receive('call:incoming', { channelId: 'chan-1', callType: 'video', callerName: { evil: true }, from: 'u2' }));
    expect(screen.getByText('Someone')).toBeInTheDocument();
    expect(screen.getByText(/Incoming video call/)).toBeInTheDocument();
  });

  it('accepting a valid ring starts exactly the validated call; declining dismisses it', async () => {
    const socket = await renderLayout();
    act(() => socket.receive('call:incoming', { channelId: 'chan-1', callType: 'audio', callerName: 'bob', from: 'u2' }));
    fireEvent.click(screen.getByRole('button', { name: /Decline/ }));
    expect(screen.queryByText(/Incoming/)).toBeNull();
    expect(screen.queryByTestId('call-overlay')).toBeNull();

    act(() => socket.receive('call:incoming', { channelId: 'chan-1', callType: 'video', callerName: 'bob', from: 'u2' }));
    expect(screen.getByText('bob')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Accept/ }));
    expect(screen.getByTestId('call-overlay')).toHaveTextContent('video call in chan-1');
    expect(screen.queryByText(/Incoming/)).toBeNull();

    // While in a call, further rings are not shown (unchanged behaviour).
    act(() => socket.receive('call:incoming', { channelId: 'chan-1', callType: 'audio', callerName: 'carol', from: 'u3' }));
    expect(screen.queryByText(/Incoming/)).toBeNull();
  });

  it('starting a call sends only the channel and call type, never a caller name', async () => {
    const socket = await renderLayout();
    fireEvent.click(screen.getByRole('button', { name: 'probe: start audio call' }));
    expect(socket.emitted('call:initiate')).toEqual([{ channelId: 'chan-1', callType: 'audio' }]);
    expect(screen.getByTestId('call-overlay')).toHaveTextContent('audio call in chan-1');
  });

  // ── P2 Phase H: ringing lifecycle ──
  it('declining tells the server (so the caller hears) and dismisses the banner', async () => {
    const socket = await renderLayout();
    act(() => socket.receive('call:incoming', { channelId: 'chan-1', callType: 'audio', callerName: 'bob', from: 'u2' }));
    fireEvent.click(screen.getByRole('button', { name: /Decline/ }));
    expect(socket.emitted('call:decline')).toEqual([{ channelId: 'chan-1' }]);
    expect(screen.queryByText(/Incoming/)).toBeNull();
    expect(screen.queryByTestId('call-overlay')).toBeNull();
  });

  it('dismisses the banner when the ring ends elsewhere, but not for another conversation', async () => {
    const socket = await renderLayout();
    act(() => socket.receive('call:incoming', { channelId: 'chan-1', callType: 'audio', callerName: 'bob', from: 'u2' }));
    act(() => socket.receive('call:ring_ended', { channelId: 'chan-other', reason: 'cancelled' }));
    expect(screen.getByText(/Incoming/)).toBeInTheDocument();
    act(() => socket.receive('call:ring_ended', { channelId: 'chan-1', reason: 'cancelled' }));
    expect(screen.queryByText(/Incoming/)).toBeNull();
    expect(screen.queryByTestId('call-overlay')).toBeNull();
  });

  it("ends the caller's call when nobody answers, and cancels the ring when the caller hangs up", async () => {
    const socket = await renderLayout();
    fireEvent.click(screen.getByRole('button', { name: 'probe: start audio call' }));
    expect(screen.getByTestId('call-overlay')).toBeInTheDocument();
    act(() => socket.receive('call:ring_ended', { channelId: 'chan-1', reason: 'timeout' }));
    expect(screen.queryByTestId('call-overlay')).toBeNull();
    expect(socket.emitted('webrtc:leave')).toEqual([{ channelId: 'chan-1' }]);
    expect(socket.emitted('call:cancel')).toEqual([{ channelId: 'chan-1' }]);
  });

  it('an answered ring keeps the call going; an accepted call never sends a cancel', async () => {
    const socket = await renderLayout();
    fireEvent.click(screen.getByRole('button', { name: 'probe: start audio call' }));
    act(() => socket.receive('call:ring_ended', { channelId: 'chan-1', reason: 'answered' }));
    expect(screen.getByTestId('call-overlay')).toBeInTheDocument();
    expect(socket.emitted('call:cancel')).toEqual([]);
  });
});
