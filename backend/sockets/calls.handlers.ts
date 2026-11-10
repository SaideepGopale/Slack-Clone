import { Server } from 'socket.io';
import { prisma } from '../lib/prisma';
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

interface CallParticipant {
  socketId: string;
  userId: string;
  username: string;
}

// channelId -> socketId -> participant. Kept as our own bookkeeping rather
// than relying on Socket.IO's fetchSockets() (whose RemoteSocket shape only
// exposes `.data`, not arbitrary properties like our `.user` — this stays
// correct even if a Redis adapter is added later for multi-instance scaling).
const callRooms = new Map<string, Map<string, CallParticipant>>();

const callRoom = (channelId: string) => `call:${channelId}`;

// Exported for access revocation (sockets/revocation.ts): a member removed
// from a channel/workspace is dropped from any call in it immediately.
export const removeFromCallRoom = (socket: AuthenticatedSocket, channelId: string) => {
  const room = callRooms.get(channelId);
  if (!room?.has(socket.id)) return;

  room.delete(socket.id);
  if (room.size === 0) callRooms.delete(channelId);

  socket.leave(callRoom(channelId));
  socket.to(callRoom(channelId)).emit('webrtc:peer-left', { socketId: socket.id });
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
interface ActiveRing {
  callerId: string;
  callerSocketId: string;
  oneToOne: boolean;
  answered: boolean;
  timer: ReturnType<typeof setTimeout>;
}
type RingEndReason = 'cancelled' | 'timeout' | 'declined' | 'answered';

const activeRings = new Map<string, ActiveRing>();
const DEFAULT_RING_TIMEOUT_MS = 45_000;

/** Ring duration; CALL_RING_TIMEOUT_MS may override it within 1 s – 5 min. */
const ringTimeoutMs = () => {
  const configured = Number(process.env.CALL_RING_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= 1_000 && configured <= 300_000 ? configured : DEFAULT_RING_TIMEOUT_MS;
};

const endRing = (io: Server, channelId: string, reason: RingEndReason) => {
  const ring = activeRings.get(channelId);
  if (!ring) return;
  clearTimeout(ring.timer);
  activeRings.delete(channelId);
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
// participant of the same call (it passed verifyCallAccess at webrtc:join).
// Anything else — a room name, a socket in a different call, the sender
// itself, a socket that already disconnected — resolves to null.
const resolveCallPeer = (io: Server, channelId: string, senderSocketId: string, to: unknown) => {
  if (!isBoundedString(to, MAX_ID_LENGTH) || to === senderSocketId) return null;
  const participant = callRooms.get(channelId)?.get(to);
  if (!participant) return null;
  const target = io.sockets.sockets.get(to) as AuthenticatedSocket | undefined;
  if (!target?.connected || !target.rooms.has(callRoom(channelId))) return null;
  return { participant, target };
};

const stillInCall = (target: AuthenticatedSocket, channelId: string) =>
  target.connected && !!callRooms.get(channelId)?.has(target.id);

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
      // the same caller restarts the timer.
      const existing = activeRings.get(ring.channelId);
      if (!existing || existing.callerId === user.id) {
        if (existing) clearTimeout(existing.timer);
        const channelId = ring.channelId;
        activeRings.set(channelId, {
          callerId: user.id,
          callerSocketId: socket.id,
          oneToOne: callChannel.oneToOne,
          answered: false,
          timer: setTimeout(() => {
            const current = activeRings.get(channelId);
            if (current) endRing(io, channelId, current.answered ? 'answered' : 'timeout');
          }, ringTimeoutMs()),
        });
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
    const ring = activeRings.get(channelId);
    if (!ring || ring.callerId === user.id) return;
    try {
      if (!(await verifyCallAccess(user.id, channelId))) return;
      if (activeRings.get(channelId) !== ring) return; // ended meanwhile
      io.to(ring.callerSocketId).emit('call:declined', { channelId, userId: user.id, username: callerDisplayName(user.username) });
      if (ring.oneToOne) endRing(io, channelId, 'declined');
    } catch (err) {
      console.error('call:decline failed:', err);
    }
  });

  // Only the caller can stop their own ring.
  socket.on('call:cancel', (data: unknown) => {
    const channelId = (data as { channelId?: unknown } | null)?.channelId;
    if (!isBoundedString(channelId, MAX_ID_LENGTH)) return;
    const ring = activeRings.get(channelId);
    if (ring && ring.callerId === user.id) endRing(io, channelId, 'cancelled');
  });

  // A socket must have successfully joined the call room to send/receive
  // signaling for it at all — that in-memory room check gates every relay
  // below. offer/answer additionally re-verify against the DB (cheap: once
  // per peer pairing); ice-candidate relies on the room check alone, since
  // by the time candidates are flowing the pairing's offer/answer already
  // did that fresh check moments earlier (see its own comment below).
  const isActiveInCall = (channelId: string) => socket.rooms.has(callRoom(channelId));

  socket.on('webrtc:join', async (data: { channelId: string }) => {
    const channelId = data?.channelId;
    if (!channelId) return;

    try {
      if (!(await verifyCallAccess(user.id, channelId))) {
        socket.emit('webrtc:error', { message: 'You are not authorized to join this call.' });
        return;
      }

      const room = callRooms.get(channelId) ?? new Map<string, CallParticipant>();
      callRooms.set(channelId, room);

      // Tell the joiner who's already in the call (they'll initiate offers to each)...
      socket.emit('webrtc:existing-participants', { participants: Array.from(room.values()) });

      // ...then register them and tell the existing participants a new peer arrived.
      room.set(socket.id, { socketId: socket.id, userId: user.id, username: user.username });
      socket.join(callRoom(channelId));
      socket.to(callRoom(channelId)).emit('webrtc:peer-joined', {
        socketId: socket.id,
        userId: user.id,
        username: user.username,
      });

      // Someone other than the caller picked up.
      const ring = activeRings.get(channelId);
      if (ring && ring.callerId !== user.id) {
        ring.answered = true;
        if (ring.oneToOne) endRing(io, channelId, 'answered');
      }
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
    const peer = resolveCallPeer(io, channelId, socket.id, payload.to);
    const description = sanitizeDescription(kind === 'offer' ? payload.offer : payload.answer, kind);
    if (!peer || !description) return;
    try {
      const [senderAllowed, recipientAllowed] = await Promise.all([
        verifyCallAccess(user.id, channelId),
        verifyCallAccess(peer.participant.userId, channelId),
      ]);
      if (!senderAllowed) {
        removeFromCallRoom(socket, channelId);
        return;
      }
      if (!recipientAllowed) {
        removeFromCallRoom(peer.target, channelId);
        return;
      }
      // Re-check after the awaits: either side may have left meanwhile.
      if (!isActiveInCall(channelId) || !stillInCall(peer.target, channelId)) return;
      peer.target.emit(`webrtc:${kind}`, { from: socket.id, channelId, [kind]: description });
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
    const peer = resolveCallPeer(io, channelId, socket.id, payload.to);
    const candidate = sanitizeCandidate(payload.candidate);
    if (!peer || !candidate) return;
    peer.target.emit('webrtc:ice-candidate', { from: socket.id, channelId, candidate });
  });

  socket.on('webrtc:leave', (data: { channelId: string }) => {
    if (data?.channelId) removeFromCallRoom(socket, data.channelId);
  });

  socket.on('disconnect', () => {
    for (const channelId of callRooms.keys()) {
      removeFromCallRoom(socket, channelId);
    }
    for (const [channelId, ring] of activeRings) {
      if (ring.callerSocketId === socket.id) endRing(io, channelId, 'cancelled');
    }
  });
};
