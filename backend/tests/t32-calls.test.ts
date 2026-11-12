import { createHmac } from 'crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

// A small participant cap for this file only (read when the call handlers load).
vi.hoisted(() => {
  process.env.CALL_MAX_PARTICIPANTS = '2';
});

import { app } from '../app';
import { iceConfigFor } from '../lib/iceServers';
import { addToWorkspace, createWorkspace } from './collab-helpers';
import { authHeader, createAndLoginUser } from './helpers';
import { collect, nextEvent, useSocketHarness } from './socket-harness';

/**
 * T.32 — calls: ICE/TURN configuration from the environment (audit H4),
 * join hardening (RT-9: cap, no self in the participant list on rejoin) and
 * the mic/camera state relay (RT-11), restricted to the call's participants.
 */
const harness = useSocketHarness();

describe('T.32 H4 — ICE server configuration', () => {
  it('defaults to public STUN and says no relay is configured', () => {
    const config = iceConfigFor('u1', {});
    expect(config.relay).toBe(false);
    expect(config.iceServers).toEqual([{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]);
  });

  it('issues short-lived coturn REST credentials from a shared secret', () => {
    const now = Date.UTC(2026, 10, 11, 12, 0, 0);
    const config = iceConfigFor('user-42', { CALL_TURN_URLS: 'turn:turn.example.test:3478, turns:turn.example.test:5349, http://not-turn', CALL_TURN_SECRET: 's3cret', CALL_TURN_TTL_SECONDS: '600' }, now);
    expect(config.relay).toBe(true);
    const turn = config.iceServers[1];
    expect(turn.urls).toEqual(['turn:turn.example.test:3478', 'turns:turn.example.test:5349']);
    expect(turn.username).toBe(`${now / 1000 + 600}:user-42`);
    expect(turn.credential).toBe(createHmac('sha1', 's3cret').update(turn.username!).digest('base64'));
  });

  it('supports static TURN credentials, and ignores TURN URLs without any credentials', () => {
    expect(iceConfigFor('u', { CALL_TURN_URLS: 'turn:t.example:3478', CALL_TURN_USERNAME: 'a', CALL_TURN_CREDENTIAL: 'b' }).iceServers[1]).toEqual({ urls: ['turn:t.example:3478'], username: 'a', credential: 'b' });
    expect(iceConfigFor('u', { CALL_TURN_URLS: 'turn:t.example:3478' })).toMatchObject({ relay: false, iceServers: [{ urls: expect.any(Array) }] });
  });

  it('is served to signed-in users only, never cached', async () => {
    expect((await request(app).get('/api/calls/ice-servers')).status).toBe(401);
    const user = await createAndLoginUser();
    const res = await request(app).get('/api/calls/ice-servers').set(authHeader(user.token));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toMatchObject({ relay: expect.any(Boolean), iceServers: expect.any(Array), ttlSeconds: expect.any(Number) });
  });
});

describe('T.32 — call joins and media state', () => {
  const setup = async () => {
    const alice = await createAndLoginUser();
    const bob = await createAndLoginUser();
    const carol = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(alice);
    await addToWorkspace(bob, workspaceId, [generalChannelId]);
    await addToWorkspace(carol, workspaceId, [generalChannelId]);
    return { alice, bob, carol, channelId: generalChannelId };
  };

  it('a repeated join from the same socket does not list itself, and a full call refuses newcomers', async () => {
    const { alice, bob, carol, channelId } = await setup();
    const a = await harness.connect(alice);
    const first = nextEvent<{ participants: { socketId: string }[] }>(a.socket, 'webrtc:existing-participants');
    a.socket.emit('webrtc:join', { channelId });
    expect((await first).participants).toEqual([]);
    const again = nextEvent<{ participants: { socketId: string }[] }>(a.socket, 'webrtc:existing-participants');
    a.socket.emit('webrtc:join', { channelId });
    expect((await again).participants).toEqual([]);

    const b = await harness.connect(bob);
    const bJoined = nextEvent<{ participants: { socketId: string }[] }>(b.socket, 'webrtc:existing-participants');
    b.socket.emit('webrtc:join', { channelId });
    expect((await bJoined).participants.map((p) => p.socketId)).toEqual([a.socket.id]);

    const c = await harness.connect(carol);
    const refused = nextEvent<{ code: string; message: string }>(c.socket, 'webrtc:error');
    c.socket.emit('webrtc:join', { channelId });
    expect(await refused).toMatchObject({ code: 'call_full' });
  });

  it('relays mic/camera state to the call only, from participants only, with valid payloads only', async () => {
    const { alice, bob, carol, channelId } = await setup();
    const a = await harness.connect(alice);
    const b = await harness.connect(bob);
    const c = await harness.connect(carol); // a channel member, but not in the call
    for (const s of [a.socket, b.socket]) {
      const joined = nextEvent(s, 'webrtc:existing-participants');
      s.emit('webrtc:join', { channelId });
      await joined;
    }

    const seenByBob = nextEvent<{ socketId: string; audio: boolean; video: boolean }>(b.socket, 'webrtc:media-state');
    const seenByCarol = collect(c.socket, 'webrtc:media-state', 600);
    a.socket.emit('webrtc:media-state', { channelId, audio: false, video: true });
    expect(await seenByBob).toEqual({ channelId, socketId: a.socket.id, audio: false, video: true });
    expect(await seenByCarol).toEqual([]);

    // Not in the call → nothing relayed; malformed → ignored.
    const bobSees = collect(b.socket, 'webrtc:media-state', 600);
    c.socket.emit('webrtc:media-state', { channelId, audio: true, video: true });
    a.socket.emit('webrtc:media-state', { channelId, audio: 'yes', video: true });
    a.socket.emit('webrtc:media-state', { channelId: 'not-a-uuid', audio: true, video: true });
    expect(await bobSees).toEqual([]);
  });

  it('a late joiner learns the current mic/camera state of those already in the call', async () => {
    const { alice, bob, channelId } = await setup();
    const a = await harness.connect(alice);
    const joined = nextEvent(a.socket, 'webrtc:existing-participants');
    a.socket.emit('webrtc:join', { channelId });
    await joined;
    a.socket.emit('webrtc:media-state', { channelId, audio: false, video: false });
    await new Promise((r) => setTimeout(r, 100));

    const b = await harness.connect(bob);
    const list = nextEvent<{ participants: { socketId: string; media: { audio: boolean; video: boolean } }[] }>(b.socket, 'webrtc:existing-participants');
    b.socket.emit('webrtc:join', { channelId });
    expect((await list).participants).toEqual([expect.objectContaining({ socketId: a.socket.id, media: { audio: false, video: false } })]);
  });
});
