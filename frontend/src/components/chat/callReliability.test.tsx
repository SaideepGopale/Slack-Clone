import { act, render, screen, waitFor } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T.32 — call reliability (audit H5, RT-8, RT-11), client side.
 */
const auth = vi.hoisted(() => ({ user: { id: 'me', username: 'mia' } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../../lib/iceConfig', () => ({
  loadIceConfig: vi.fn(async () => ({ iceServers: [{ urls: ['stun:stun.example.test'] }], relay: false })),
  currentIceServers: () => [{ urls: ['stun:stun.example.test'] }],
}));

import { CallOverlay } from './CallOverlay';

class FakeSocket {
  private handlers = new Map<string, Set<(payload?: unknown) => void>>();
  sent: { event: string; payload: Record<string, unknown> }[] = [];
  on(event: string, fn: (payload?: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
    return this;
  }
  off(event: string, fn: (payload?: unknown) => void) {
    this.handlers.get(event)?.delete(fn);
    return this;
  }
  emit(event: string, payload: Record<string, unknown>) {
    this.sent.push({ event, payload });
    return this;
  }
  receive(event: string, payload?: unknown) {
    this.handlers.get(event)?.forEach((fn) => fn(payload));
  }
  emitted(event: string) {
    return this.sent.filter((s) => s.event === event).map((s) => s.payload);
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  remoteDescription: unknown = null;
  connectionState = 'new';
  signalingState = 'stable';
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: (() => void) | null = null;
  addTrack = vi.fn();
  setRemoteDescription = vi.fn(async (d: unknown) => {
    this.remoteDescription = d;
  });
  setLocalDescription = vi.fn(async () => undefined);
  createOffer = vi.fn(async (_opts?: unknown) => ({ type: 'offer', sdp: 'local-offer' }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'local-answer' }));
  addIceCandidate = vi.fn(async () => undefined);
  restartIce = vi.fn();
  close = vi.fn();
  getSenders = () => [];
  constructor() {
    FakePeerConnection.instances.push(this);
  }
  setState(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

const CHANNEL = 'chan-1';
const audioTrack = { kind: 'audio', enabled: true, stop: vi.fn() };
const audioStream = { getTracks: () => [audioTrack], getAudioTracks: () => [audioTrack], getVideoTracks: () => [] };
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakePeerConnection.instances = [];
  getUserMedia = vi.fn(async () => audioStream);
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('RTCSessionDescription', class { constructor(init: object) { Object.assign(this, init); } });
  vi.stubGlobal('RTCIceCandidate', class { constructor(init: object) { Object.assign(this, init); } });
  vi.stubGlobal('AudioContext', class {
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0, getByteFrequencyData() {} }; }
    close() { return Promise.resolve(); }
  });
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// T.33: the join announces the microphone/camera state; `video` is what the
// overlay actually has (false when a video call fell back to audio only).
const startCall = async (callType: 'audio' | 'video' = 'audio', video = callType === 'video') => {
  const socket = new FakeSocket();
  render(<CallOverlay channelId={CHANNEL} callType={callType} socket={socket as unknown as Socket} onEndCall={vi.fn()} workspaceId="ws-1" />);
  await waitFor(() => expect(socket.emitted('webrtc:join')).toEqual([{ channelId: CHANNEL, media: { audio: true, video } }]));
  return socket;
};

const deliver = async (socket: FakeSocket, event: string, payload?: unknown) => {
  await act(async () => {
    socket.receive(event, payload);
    await new Promise((r) => setTimeout(r, 0));
  });
};

describe('CallOverlay reliability (T.32)', () => {
  it('says "Waiting for others" when the caller is alone — never "connected"', async () => {
    const socket = await startCall();
    await deliver(socket, 'webrtc:existing-participants', { participants: [] });
    expect(screen.getAllByText('Waiting for others to join…').length).toBeGreaterThan(0);
    // Its own microphone/camera state is announced to the call.
    expect(socket.emitted('webrtc:media-state')).toContainEqual({ channelId: CHANNEL, audio: true, video: false });
  });

  it('shows "Reconnecting" when the socket drops and rejoins the call when it is back', async () => {
    const socket = await startCall();
    await deliver(socket, 'webrtc:existing-participants', { participants: [{ socketId: 'peer-b', userId: 'u-b', username: 'bob' }] });
    expect(FakePeerConnection.instances).toHaveLength(1);

    await deliver(socket, 'disconnect');
    expect(screen.getByText(/Reconnecting to the call/)).toBeInTheDocument();
    expect(FakePeerConnection.instances[0].close).toHaveBeenCalled();

    await deliver(socket, 'connect');
    expect(socket.emitted('webrtc:join')).toHaveLength(2);
    await deliver(socket, 'webrtc:existing-participants', { participants: [{ socketId: 'peer-b2', userId: 'u-b', username: 'bob' }] });
    expect(screen.queryByText(/Reconnecting to the call/)).not.toBeInTheDocument();
    expect(socket.emitted('webrtc:offer').map((o) => o.to)).toEqual(['peer-b', 'peer-b2']);
  });

  it('a first connect does not cause a second join', async () => {
    const socket = await startCall();
    await deliver(socket, 'connect');
    expect(socket.emitted('webrtc:join')).toHaveLength(1);
  });

  it('the side that offered restarts ICE when a connection fails, then gives up honestly', async () => {
    const socket = await startCall();
    await deliver(socket, 'webrtc:existing-participants', { participants: [{ socketId: 'peer-c', userId: 'u-c', username: 'carl' }] });
    const [pc] = FakePeerConnection.instances;
    pc.setState('connected');

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        pc.setState('failed');
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    expect(pc.restartIce).toHaveBeenCalledTimes(3);
    expect(pc.createOffer).toHaveBeenCalledWith({ iceRestart: true });
    expect(socket.emitted('webrtc:offer')).toHaveLength(4); // the first offer + three restarts

    await act(async () => {
      pc.setState('failed');
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(pc.restartIce).toHaveBeenCalledTimes(3); // no endless retry loop
  });

  it('a video call without a usable camera joins with audio only and says so', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('no camera', 'NotFoundError')).mockResolvedValueOnce(audioStream);
    const socket = await startCall('video', false); // joins announcing no video
    expect(getUserMedia).toHaveBeenNthCalledWith(1, { video: true, audio: true });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { video: false, audio: true });
    expect(await screen.findByText(/joined with audio only/)).toBeInTheDocument();
    await deliver(socket, 'webrtc:existing-participants', { participants: [] });
    expect(socket.emitted('webrtc:media-state')).toContainEqual({ channelId: CHANNEL, audio: true, video: false });
  });

  it('a server refusal (e.g. the call is full) is shown and nothing pretends to connect', async () => {
    const socket = await startCall();
    await deliver(socket, 'webrtc:error', { code: 'call_full', message: 'This call is full (8 people). Try again when someone leaves.' });
    expect(screen.getByText(/This call is full/)).toBeInTheDocument();
    expect(screen.getByText('Couldn’t start the call')).toBeInTheDocument();
  });
});
