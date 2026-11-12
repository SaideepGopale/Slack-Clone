import { act, render, waitFor } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSignalFromCallPeer, MAX_PENDING_CANDIDATES } from '../../lib/callSignalling';
import { CallOverlay } from './CallOverlay';

/**
 * P1-A — FA-RT-01, client side: an in-call client must never open a peer
 * connection (and so never send its microphone/camera) to anyone who is not a
 * participant of the call it joined, and media is only requested when the
 * user starts/accepts a call — never because a signal arrives.
 */
// Stable identity, like the real AuthContext (`user` is React state): the
// call effect depends on `user`, so a new object per render would restart it.
const auth = vi.hoisted(() => ({ user: { id: 'me', username: 'mia' } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

/** Socket stand-in: records what the component emits; `receive` delivers server events to its listeners. */
class FakeSocket {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();
  sent: { event: string; payload: Record<string, unknown> }[] = [];
  on(event: string, fn: (payload: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
    return this;
  }
  off(event: string, fn: (payload: unknown) => void) {
    this.handlers.get(event)?.delete(fn);
    return this;
  }
  emit(event: string, payload: Record<string, unknown>) {
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

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  remoteDescription: unknown = null;
  connectionState = 'new';
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  addTrack = vi.fn();
  setRemoteDescription = vi.fn(async (description: unknown) => {
    this.remoteDescription = description;
  });
  setLocalDescription = vi.fn(async () => undefined);
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'local-offer' }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'local-answer' }));
  addIceCandidate = vi.fn(async () => undefined);
  close = vi.fn();
  getSenders = () => [];
  constructor() {
    FakePeerConnection.instances.push(this);
  }
}

const CHANNEL = 'chan-1';
const OFFER = { type: 'offer', sdp: 'remote-offer' };
const ANSWER = { type: 'answer', sdp: 'remote-answer' };
const CANDIDATE = { candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 };
const localTrack = { kind: 'audio', enabled: true, stop: vi.fn() };
const localStream = { getTracks: () => [localTrack], getAudioTracks: () => [localTrack], getVideoTracks: () => [] };
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakePeerConnection.instances = [];
  getUserMedia = vi.fn(async () => localStream);
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('RTCSessionDescription', class { constructor(init: object) { Object.assign(this, init); } });
  vi.stubGlobal('RTCIceCandidate', class { constructor(init: object) { Object.assign(this, init); } });
  vi.stubGlobal(
    'AudioContext',
    class {
      createMediaStreamSource() { return { connect() {} }; }
      createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0, getByteFrequencyData() {} }; }
      close() { return Promise.resolve(); }
    }
  );
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Renders an overlay as if the user just started/accepted an audio call in CHANNEL, and waits until it joined. */
const startCall = async () => {
  const socket = new FakeSocket();
  render(<CallOverlay channelId={CHANNEL} callType="audio" socket={socket as unknown as Socket} onEndCall={vi.fn()} workspaceId="ws-1" />);
  // T.33: the join announces the microphone/camera state (audio call: mic on, no video).
  await waitFor(() => expect(socket.emitted('webrtc:join')).toEqual([{ channelId: CHANNEL, media: { audio: true, video: false } }]));
  return socket;
};

const deliver = async (socket: FakeSocket, event: string, payload: unknown) => {
  await act(async () => {
    socket.receive(event, payload);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('isSignalFromCallPeer', () => {
  it('accepts only signals for this call from announced participants', () => {
    const peers = new Map([['peer-b', {}]]);
    expect(isSignalFromCallPeer({ from: 'peer-b', channelId: CHANNEL }, CHANNEL, peers)).toBe(true);
    expect(isSignalFromCallPeer({ from: 'intruder', channelId: CHANNEL }, CHANNEL, peers)).toBe(false);
    expect(isSignalFromCallPeer({ from: 'peer-b', channelId: 'other-call' }, CHANNEL, peers)).toBe(false);
    expect(isSignalFromCallPeer({ from: 'peer-b' }, CHANNEL, peers)).toBe(false);
    expect(isSignalFromCallPeer({ from: 42, channelId: CHANNEL }, CHANNEL, peers)).toBe(false);
    expect(isSignalFromCallPeer(null, CHANNEL, peers)).toBe(false);
  });
});

describe('CallOverlay signaling (FA-RT-01)', () => {
  it('requests microphone access once, for the call the user started — never because offers arrive', async () => {
    const socket = await startCall();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ video: false, audio: true });

    await deliver(socket, 'webrtc:offer', { from: 'intruder', channelId: CHANNEL, offer: OFFER });
    await deliver(socket, 'webrtc:peer-joined', { socketId: 'peer-b', userId: 'u-b', username: 'bob' });
    await deliver(socket, 'webrtc:offer', { from: 'peer-b', channelId: CHANNEL, offer: OFFER });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('ignores offers, answers and ICE from anyone who is not a participant of this call', async () => {
    const socket = await startCall();
    await deliver(socket, 'webrtc:offer', { from: 'intruder', channelId: CHANNEL, offer: OFFER });
    await deliver(socket, 'webrtc:answer', { from: 'intruder', channelId: CHANNEL, answer: ANSWER });
    await deliver(socket, 'webrtc:ice-candidate', { from: 'intruder', channelId: CHANNEL, candidate: CANDIDATE });

    // A real participant's socket, but the signal claims a different call (or none).
    await deliver(socket, 'webrtc:peer-joined', { socketId: 'peer-b', userId: 'u-b', username: 'bob' });
    await deliver(socket, 'webrtc:offer', { from: 'peer-b', channelId: 'some-other-call', offer: OFFER });
    await deliver(socket, 'webrtc:offer', { from: 'peer-b', offer: OFFER });

    expect(FakePeerConnection.instances).toHaveLength(0); // no peer connection, so no local track was ever attached
    expect(socket.emitted('webrtc:answer')).toEqual([]);
  });

  it('answers a legitimate participant of this call and attaches local tracks only for them', async () => {
    const socket = await startCall();
    await deliver(socket, 'webrtc:peer-joined', { socketId: 'peer-b', userId: 'u-b', username: 'bob' });
    await deliver(socket, 'webrtc:offer', { from: 'peer-b', channelId: CHANNEL, offer: OFFER });

    await waitFor(() => expect(socket.emitted('webrtc:answer')).toHaveLength(1));
    expect(socket.emitted('webrtc:answer')[0]).toMatchObject({ channelId: CHANNEL, to: 'peer-b', answer: { type: 'answer' } });
    expect(FakePeerConnection.instances).toHaveLength(1);
    const [pc] = FakePeerConnection.instances;
    expect(pc.setRemoteDescription).toHaveBeenCalledWith(expect.objectContaining(OFFER));
    expect(pc.addTrack).toHaveBeenCalledWith(localTrack, localStream);
  });

  it('offers to participants the server announced and accepts only their answers', async () => {
    const socket = await startCall();
    await deliver(socket, 'webrtc:existing-participants', { participants: [{ socketId: 'peer-c', userId: 'u-c', username: 'carl' }] });
    await waitFor(() => expect(socket.emitted('webrtc:offer')).toHaveLength(1));
    expect(socket.emitted('webrtc:offer')[0]).toMatchObject({ channelId: CHANNEL, to: 'peer-c' });
    const [pc] = FakePeerConnection.instances;

    await deliver(socket, 'webrtc:answer', { from: 'intruder', channelId: CHANNEL, answer: ANSWER });
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    await deliver(socket, 'webrtc:answer', { from: 'peer-c', channelId: CHANNEL, answer: ANSWER });
    expect(pc.setRemoteDescription).toHaveBeenCalledWith(expect.objectContaining(ANSWER));
  });

  it('bounds the ICE candidates buffered for a participant before its offer arrives', async () => {
    const socket = await startCall();
    await deliver(socket, 'webrtc:peer-joined', { socketId: 'peer-d', userId: 'u-d', username: 'dee' });
    await act(async () => {
      for (let i = 0; i < MAX_PENDING_CANDIDATES + 36; i++) {
        socket.receive('webrtc:ice-candidate', { from: 'peer-d', channelId: CHANNEL, candidate: CANDIDATE });
      }
    });
    await deliver(socket, 'webrtc:offer', { from: 'peer-d', channelId: CHANNEL, offer: OFFER });
    await waitFor(() => expect(socket.emitted('webrtc:answer')).toHaveLength(1));
    expect(FakePeerConnection.instances[0].addIceCandidate).toHaveBeenCalledTimes(MAX_PENDING_CANDIDATES);
  });
});
