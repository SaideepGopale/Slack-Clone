import { randomUUID } from 'crypto';
import { Server } from 'socket.io';
import { isUuid } from '../lib/messageInput';
import { prisma } from '../lib/prisma';
import { CallParticipant, getCallStore } from './callStore';
import { STALE_MS } from './presenceStore';
import { isChannelMember } from './channelAccess';
import { AuthenticatedSocket } from './types';

// WebRTC signaling payloads (SDP blobs / ICE candidates). The server checks
// only their shape and size (FA-RT-01, see the relay hardening below) and
// relays them between browsers, which do the actual SDP/ICE parsing — so
// they're typed loosely rather than pulling in DOM lib types for a backend file.
interface SessionDescriptionPayload {
  type: string;
  sdp?: string;
}

interface IceCandidatePayload {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

// T.32 (audit RT-9): calls are a full mesh (every browser sends to every
// other), which degrades sharply beyond a handful of people. Configurable,
// default 8.
export const MAX_CALL_PARTICIPANTS = (() => {
  const n = Number(process.env.CALL_MAX_PARTICIPANTS);
  return Number.isInteger(n) && n >= 2 && n <= 16 ? n : 8;
})();

// Participants and rings live in a CallStore (callStore.ts): in memory for
// one process, in Redis when REDIS_URL is set (T.33), so a call can span
// instances. The store — not any one process's socket list — is the source of
// truth for "who is in this call". Signals are delivered with
// `io.to(socketId)`, which the Redis adapter routes to whichever instance
// holds that socket.
const calls = () => getCallStore();

const callRoom = (channelId: string) => `call:${channelId}`;

// A participant whose instance died never ran its disconnect handler; on the
// next join, entries older than this whose socket is gone are pruned (the
// grace covers a join that is registered but not yet in the room).
const STALE_PARTICIPANT_GRACE_MS = STALE_MS;

/**
 * Removes one socket (on any instance) from a call and tells the remaining
 * participants. Exported for access revocation (sockets/revocation.ts): a
 * member removed from a channel/workspace is dropped from any call in it
 * immediately.
 */
export const removeFromCall = async (io: Server, socketId: string, channelId: string) => {
  if (!(await calls().leave(channelId, socketId))) return;
  io.in(socketId).socketsLeave(callRoom(channelId));
  io.to(callRoom(channelId)).except(socketId).emit('webrtc:peer-left', { socketId });
};

/** Drops every socket of `userId` from the calls of the given channels. */
export const removeUserFromCalls = async (io: Server, userId: string, channelIds: string[]) => {
  for (const channelId of channelIds) {
    for (const p of await calls().participants(channelId)) {
      if (p.userId === userId) await removeFromCall(io, p.socketId, channelId);
    }
  }
};

// Two-layer check, same reasoning as channels.handlers.ts's channel:join:
// isChannelMember alone isn't enough once workspaces are the real tenant
// boundary, since a ChannelMember row can outlive an actual WorkspaceMember
// removal (there's no "remove workspace member" cleanup cascade today).
// Calls need this doubly so — a call is a standing, real-time media session
// that keeps running for as long as both ends leave it running.
// P2: archived conversations are read-only, so they can't host calls either.
// Returns the conversation kind when the user may call in it, null otherwise.
const loadCallChannel = async (userId: string, channelId: string): Promise<{ oneToOne: boolean } | null> => {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { workspaceId: true, isDM: true, isGroupDM: true, archivedAt: true },
  });
  if (!channel || channel.archivedAt) return null;

  const [channelMember, workspaceMember] = await Promise.all([
    isChannelMember(userId, channelId),
    prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: channel.workspaceId } },
      select: { id: true },
    }),
  ]);

  return channelMember && !!workspaceMember ? { oneToOne: !!channel.isDM && !channel.isGroupDM } : null;
};

const verifyCallAccess = async (userId: string, channelId: string): Promise<boolean> =>
  (await loadCallChannel(userId, channelId)) !== null;

// ── Ringing lifecycle (P2 Phase H) ────────────────────────────────────────
// One ring per conversation, owned by the caller's socket. It ends when the
// caller cancels or disconnects, when the ring times out, or — in a 1:1 DM,
// where only one person can pick up — when the other person declines or
// answers. Every end is broadcast as `call:ring_ended` so each of the callee's
// devices dismisses its banner; a decline is reported to the caller alone.
// T.33: the ring itself is in the CallStore; its timeout timer lives on the
// instance of the caller's socket (keyed by ringId, so a timer belonging to a
// replaced or already-ended ring is a no-op). The stored ring also expires on
// its own shortly after the timeout, should that instance die.
type RingEndReason = 'cancelled' | 'timeout' | 'declined' | 'answered';

const ringTimers = new Map<string, { ringId: string; callerSocketId: string; timer: ReturnType<typeof setTimeout> }>();
const DEFAULT_RING_TIMEOUT_MS = 45_000;
const RING_TTL_MARGIN_MS = 5_000;

/** Ring duration; CALL_RING_TIMEOUT_MS may override it within 1 s – 5 min. */
const ringTimeoutMs = () => {
  const configured = Number(process.env.CALL_RING_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= 1_000 && configured <= 300_000 ? configured : DEFAULT_RING_TIMEOUT_MS;
};

const endRing = async (io: Server, channelId: string, reason: RingEndReason, ringId?: string) => {
  const ring = await calls().takeRing(channelId, ringId);
  if (!ring) return;
  const local = ringTimers.get(channelId);
  if (local?.ringId === ring.ringId) {
    clearTimeout(local.timer);
    ringTimers.delete(channelId);
  }
  io.to(channelId).emit('call:ring_ended', { channelId, reason });
};

// ── Relay hardening (P1-A, finding FA-RT-01) ─────────────────────────────
// WebRTC offers/answers/ICE candidates used to be relayed with
// `io.to(data.to)`, where `to` was ANY room the sender named (`user:<id>`,
// `ws:<id>`, a channel id, another call's socket…). A user in any call could
// therefore make someone else's in-call client answer them and stream its
// microphone/camera across workspaces. Now the only valid recipient is
// another socket that is a current participant of the SAME call, both ends
// are re-authorized, and only well-formed, size-capped signaling fields are
// forwarded.
const MAX_SDP_LENGTH = 100_000; // real SDP offers/answers are a few KB
const MAX_CANDIDATE_LENGTH = 4_096; // real ICE candidate lines are a few hundred bytes
const MAX_ID_LENGTH = 128;

const isBoundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

const sanitizeDescription = (value: unknown, expectedType: 'offer' | 'answer'): SessionDescriptionPayload | null => {
  if (!value || typeof value !== 'object') return null;
  const { type, sdp } = value as Record<string, unknown>;
  if (type !== expectedType || !isBoundedString(sdp, MAX_SDP_LENGTH)) return null;
  return { type: expectedType, sdp };
};

const sanitizeCandidate = (value: unknown): IceCandidatePayload | null => {
  if (!value || typeof value !== 'object') return null;
  const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = value as Record<string, unknown>;
  // An empty candidate string is legal ("end of candidates").
  if (typeof candidate !== 'string' || candidate.length > MAX_CANDIDATE_LENGTH) return null;
  if (sdpMid != null && !isBoundedString(sdpMid, MAX_ID_LENGTH)) return null;
  if (sdpMLineIndex != null && !(Number.isInteger(sdpMLineIndex) && (sdpMLineIndex as number) >= 0 && (sdpMLineIndex as number) < 1024)) {
    return null;
  }
  if (usernameFragment != null && !isBoundedString(usernameFragment, MAX_ID_LENGTH)) return null;
  return {
    candidate,
    sdpMid: (sdpMid as string | null | undefined) ?? null,
    sdpMLineIndex: (sdpMLineIndex as number | null | undefined) ?? null,
    usernameFragment: (usernameFragment as string | null | undefined) ?? null,
  };
};

// The recipient of a relay must be ANOTHER socket that is currently a
// participant of the same call (it passed verifyCallAccess at webrtc:join and
// is in the call store). Anything else — a room name, a socket in a different
// call, the sender itself, a socket that left or disconnected — resolves to
// null. A socket on this instance must additionally still be connected and in
// the call room; a socket on another instance is trusted to the store, which
// its own instance updates on leave/disconnect.
const resolveCallPeer = async (io: Server, channelId: string, senderSocketId: string, to: unknown) => {
  if (!isBoundedString(to, MAX_ID_LENGTH) || to === senderSocketId) return null;
  const participant = await calls().get(channelId, to);
  if (!participant) return null;
  const local = io.sockets.sockets.get(to);
  if (local && (!local.connected || !local.rooms.has(callRoom(channelId)))) return null;
  return participant;
};

const stillInCall = async (socketId: string, channelId: string) => (await calls().get(channelId, socketId)) !== null;

// ── Ring-request validation (P1-B, finding FA-RT-02) ─────────────────────
// `call:initiate` used to relay the client's own `callerName` and `callType`
// verbatim, so any channel member could ring as someone else and crash every
// recipient's incoming-call banner with a non-string value. Now:
//  - the payload is {channelId, callType}; any other field is refused;
//  - callType must be one of the two types the app uses;
//  - the relayed callerName/from always come from the authenticated socket.
// Clients from before this fix still send their own `callerName`. It is never
// used, and is tolerated only when it is exactly the caller's authenticated
// username (what those clients send); any other value — another name, a
// non-string, an oversized string — is refused as a spoofing attempt.
const CALL_TYPES = new Set(['audio', 'video']);
const CALL_INITIATE_FIELDS = new Set(['channelId', 'callType', 'callerName']);
const MAX_CALLER_NAME_LENGTH = 80;

const parseCallInitiate = (
  data: unknown,
  callerUsername: string
): { channelId: string; callType: 'audio' | 'video' } | null => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !CALL_INITIATE_FIELDS.has(key))) return null;
  const { channelId, callType, callerName } = fields;
  if (!isBoundedString(channelId, MAX_ID_LENGTH)) return null;
  if (typeof callType !== 'string' || !CALL_TYPES.has(callType)) return null;
  if (callerName !== undefined && callerName !== callerUsername) return null;
  return { channelId, callType: callType as 'audio' | 'video' };
};

/** The ringing banner's caller name, from the authenticated user — never from the payload. */
const callerDisplayName = (username: unknown) =>
  typeof username === 'string' && username.trim() ? username.trim().slice(0, MAX_CALLER_NAME_LENGTH) : 'Someone';

export const registerCallHandlers = (io: Server, socket: AuthenticatedSocket) => {
  const user = socket.user;

  // "Ring the channel" notification that drives the IncomingCallBanner —
  // separate from the WebRTC media signaling below. Previously had no
  // authorization check at all: any authenticated socket could ring any
  // channelId, in any workspace, just by knowing its id.
  // FA-RT-02: strict payload, server-derived caller identity (see above).
  socket.on('call:initiate', async (data: unknown) => {
    const ring = parseCallInitiate(data, user.username);
    if (!ring) {
      socket.emit('webrtc:error', { message: 'Invalid call request.' });
      return;
    }
    try {
      const callChannel = await loadCallChannel(user.id, ring.channelId);
      if (!callChannel) {
        socket.emit('webrtc:error', { message: 'You are not authorized to start a call in this channel.' });
        return;
      }

      // Someone else's ring already in progress stays theirs; a re-ring by
      // the same caller replaces it (and restarts the timer).
      const channelId = ring.channelId;
      const timeout = ringTimeoutMs();
      const proposed = { ringId: randomUUID(), callerId: user.id, callerSocketId: socket.id, oneToOne: callChannel.oneToOne, answered: false };
      const inForce = await calls().startRing(channelId, proposed, timeout + RING_TTL_MARGIN_MS);
      if (inForce.ringId === proposed.ringId) {
        const previous = ringTimers.get(channelId);
        if (previous) clearTimeout(previous.timer);
        const timer = setTimeout(() => {
          ringTimers.delete(channelId);
          calls()
            .getRing(channelId)
            .then((current) => {
              if (current?.ringId === proposed.ringId) return endRing(io, channelId, current.answered ? 'answered' : 'timeout', proposed.ringId);
            })
            .catch((err) => console.error('call ring timeout failed:', err));
        }, timeout);
        timer.unref?.();
        ringTimers.set(channelId, { ringId: proposed.ringId, callerSocketId: socket.id, timer });
      }

      // P3: never to the caller's own other tabs/devices (they share the room).
      socket.to(ring.channelId).except(`user:${user.id}`).emit('call:incoming', {
        channelId: ring.channelId,
        callerName: callerDisplayName(user.username),
        callType: ring.callType,
        from: user.id,
      });
    } catch (err) {
      console.error('call:initiate failed:', err);
    }
  });

  // The callee turned the call down: the caller hears about it (only them);
  // in a 1:1 DM that also ends the ring on the callee's other devices.
  socket.on('call:decline', async (data: unknown) => {
    const channelId = (data as { channelId?: unknown } | null)?.channelId;
    if (!isBoundedString(channelId, MAX_ID_LENGTH)) return;
    try {
      const ring = await calls().getRing(channelId);
      if (!ring || ring.callerId === user.id) return;
      if (!(await verifyCallAccess(user.id, channelId))) return;
      if ((await calls().getRing(channelId))?.ringId !== ring.ringId) return; // ended meanwhile
      io.to(ring.callerSocketId).emit('call:declined', { channelId, userId: user.id, username: callerDisplayName(user.username) });
      if (ring.oneToOne) await endRing(io, channelId, 'declined', ring.ringId);
    } catch (err) {
      console.error('call:decline failed:', err);
    }
  });

  // Only the caller can stop their own ring.
  socket.on('call:cancel', (data: unknown) => {
    const channelId = (data as { channelId?: unknown } | null)?.channelId;
    if (!isBoundedString(channelId, MAX_ID_LENGTH)) return;
    calls()
      .getRing(channelId)
      .then((ring) => {
        if (ring && ring.callerId === user.id) return endRing(io, channelId, 'cancelled', ring.ringId);
      })
      .catch((err) => console.error('call:cancel failed:', err));
  });

  // A socket must have successfully joined the call room to send/receive
  // signaling for it at all — that in-memory room check gates every relay
  // below. offer/answer additionally re-verify against the DB (cheap: once
  // per peer pairing); ice-candidate relies on the room check alone, since
  // by the time candidates are flowing the pairing's offer/answer already
  // did that fresh check moments earlier (see its own comment below).
  const isActiveInCall = (channelId: string) => socket.rooms.has(callRoom(channelId));

  socket.on('webrtc:join', async (data: { channelId?: unknown; media?: { audio?: unknown; video?: unknown } }) => {
    const channelId = data?.channelId;
    if (!isUuid(channelId)) return;
    const media = { audio: data?.media?.audio !== false, video: data?.media?.video === true };

    try {
      if (!(await verifyCallAccess(user.id, channelId))) {
        socket.emit('webrtc:error', { message: 'You are not authorized to join this call.' });
        return;
      }

      // T.33: drop participants whose instance died without cleaning up
      // (their socket is in no instance's call room any more).
      const existing = await calls().participants(channelId);
      if (existing.some((p) => p.socketId !== socket.id)) {
        try {
          const live = new Set((await io.in(callRoom(channelId)).fetchSockets()).map((s) => s.id));
          for (const socketId of await calls().prune(channelId, live, STALE_PARTICIPANT_GRACE_MS)) {
            io.to(callRoom(channelId)).emit('webrtc:peer-left', { socketId });
          }
        } catch (err) {
          console.error('webrtc:join prune skipped:', err instanceof Error ? err.message : err);
        }
      }

      // T.32 (audit RT-9): a repeated join from the same socket replaces its
      // own entry instead of listing itself as an "existing participant". The
      // cap is checked and the participant registered in one atomic step, so
      // concurrent joins on different instances cannot exceed it.
      const participant: CallParticipant = { socketId: socket.id, userId: user.id, username: user.username, media, joinedAt: Date.now() };
      const joined = await calls().join(channelId, participant, MAX_CALL_PARTICIPANTS);
      if (!joined.ok) {
        socket.emit('webrtc:error', { code: 'call_full', message: `This call is full (${MAX_CALL_PARTICIPANTS} people). Try again when someone leaves.` });
        return;
      }
      // The socket may have disconnected while we were checking.
      if (socket.disconnected) {
        await calls().leave(channelId, socket.id);
        return;
      }
      const { rejoin } = joined;

      // Tell the joiner who's already in the call (they'll initiate offers to each)...
      socket.emit('webrtc:existing-participants', {
        participants: joined.others.map(({ joinedAt: _joinedAt, ...p }) => p),
        maxParticipants: MAX_CALL_PARTICIPANTS,
      });

      // ...then tell the existing participants a new peer arrived.
      socket.join(callRoom(channelId));
      if (rejoin) socket.to(callRoom(channelId)).emit('webrtc:peer-left', { socketId: socket.id });
      socket.to(callRoom(channelId)).emit('webrtc:peer-joined', {
        socketId: socket.id,
        userId: user.id,
        username: user.username,
        media,
      });

      // Someone other than the caller picked up.
      const ring = await calls().markAnswered(channelId, user.id);
      if (ring?.oneToOne) await endRing(io, channelId, 'answered', ring.ringId);
    } catch (err) {
      console.error('webrtc:join failed:', err);
    }
  });

  // Offer/answer fire once per peer *pairing* (not per candidate — a 5-person
  // call is ~10 of these, not dozens), so a fresh DB check on each is cheap
  // and closes the same "membership revoked mid-call" gap message:send was
  // hardened against: isActiveInCall alone only proves membership *at
  // webrtc:join time*. A failed re-check evicts the socket from the call
  // room entirely, rather than just silently dropping this one relay.
  // FA-RT-01: offer and answer share one relay. The target must be a
  // participant of the same call, and BOTH ends are re-verified against the
  // DB: a sender that lost access is evicted, and so is a recipient that lost
  // access (instead of receiving the signal). Only {type, sdp} is forwarded,
  // directly to that one socket, tagged with the call's channelId.
  const relayDescription = async (kind: 'offer' | 'answer', data: unknown) => {
    const payload = (data ?? {}) as { channelId?: unknown; to?: unknown; offer?: unknown; answer?: unknown };
    const channelId = payload.channelId;
    if (!isBoundedString(channelId, MAX_ID_LENGTH) || !isActiveInCall(channelId)) return;
    const description = sanitizeDescription(kind === 'offer' ? payload.offer : payload.answer, kind);
    if (!description) return;
    try {
      const peer = await resolveCallPeer(io, channelId, socket.id, payload.to);
      if (!peer) return;
      const [senderAllowed, recipientAllowed] = await Promise.all([
        verifyCallAccess(user.id, channelId),
        verifyCallAccess(peer.userId, channelId),
      ]);
      if (!senderAllowed) {
        await removeFromCall(io, socket.id, channelId);
        return;
      }
      if (!recipientAllowed) {
        await removeFromCall(io, peer.socketId, channelId);
        return;
      }
      // Re-check after the awaits: either side may have left meanwhile.
      if (!isActiveInCall(channelId) || !(await stillInCall(peer.socketId, channelId))) return;
      io.to(peer.socketId).emit(`webrtc:${kind}`, { from: socket.id, channelId, [kind]: description });
    } catch (err) {
      console.error(`webrtc:${kind} failed:`, err);
    }
  };

  socket.on('webrtc:offer', (data: unknown) => relayDescription('offer', data));
  socket.on('webrtc:answer', (data: unknown) => relayDescription('answer', data));

  // Deliberately NOT re-verified against the DB here, unlike offer/answer
  // above — a single connection attempt can generate dozens of these in
  // rapid succession, and by the time they're flowing, the offer/answer for
  // that same peer pairing has already been freshly checked moments earlier.
  // The in-memory checks are still real authorization, not a bypass: BOTH the
  // sender and the target must currently be participants of this call (each
  // passed verifyCallAccess at webrtc:join), and the target must be another
  // socket in that same call (FA-RT-01) — never an arbitrary room.
  socket.on('webrtc:ice-candidate', (data: unknown) => {
    const payload = (data ?? {}) as { channelId?: unknown; to?: unknown; candidate?: unknown };
    const channelId = payload.channelId;
    if (!isBoundedString(channelId, MAX_ID_LENGTH) || !isActiveInCall(channelId)) return;
    const candidate = sanitizeCandidate(payload.candidate);
    if (!candidate) return;
    resolveCallPeer(io, channelId, socket.id, payload.to)
      .then((peer) => {
        if (peer && isActiveInCall(channelId)) io.to(peer.socketId).emit('webrtc:ice-candidate', { from: socket.id, channelId, candidate });
      })
      .catch((err) => console.error('webrtc:ice-candidate failed:', err));
  });

  socket.on('webrtc:leave', (data: { channelId?: unknown }) => {
    if (isUuid(data?.channelId)) removeFromCall(io, socket.id, data.channelId).catch((err) => console.error('webrtc:leave failed:', err));
  });

  // T.32: microphone/camera on-off, relayed to the other participants of the
  // same call only (the sender must be in it). Lets peers show "camera off"
  // and "muted" instead of a black or silent tile.
  socket.on('webrtc:media-state', (data: { channelId?: unknown; audio?: unknown; video?: unknown }) => {
    const channelId = data?.channelId;
    if (!isUuid(channelId) || typeof data.audio !== 'boolean' || typeof data.video !== 'boolean') return;
    if (!isActiveInCall(channelId)) return;
    const media = { audio: data.audio, video: data.video };
    socket.to(callRoom(channelId)).emit('webrtc:media-state', { channelId, socketId: socket.id, ...media });
    calls()
      .setMedia(channelId, socket.id, media)
      .catch((err) => console.error('webrtc:media-state failed:', err));
  });

  socket.on('disconnect', () => {
    (async () => {
      for (const channelId of await calls().channelsOf(socket.id)) await removeFromCall(io, socket.id, channelId);
      for (const [channelId, local] of Array.from(ringTimers)) {
        if (local.callerSocketId === socket.id) await endRing(io, channelId, 'cancelled', local.ringId);
      }
    })().catch((err) => console.error('call disconnect cleanup failed:', err));
  });
};
