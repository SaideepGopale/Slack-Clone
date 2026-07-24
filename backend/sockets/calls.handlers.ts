import { Server } from 'socket.io';
import { prisma } from '../lib/prisma';
import { isChannelMember } from './channelAccess';
import { AuthenticatedSocket } from './types';

// Opaque WebRTC signaling payloads (SDP blobs / ICE candidates). The server
// never inspects these — it only relays them between browsers, which do the
// actual parsing/validation — so they're typed loosely rather than pulling in
// DOM lib types for a backend file.
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

const removeFromCallRoom = (socket: AuthenticatedSocket, channelId: string) => {
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
const verifyCallAccess = async (userId: string, channelId: string): Promise<boolean> => {
  const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { workspaceId: true } });
  if (!channel) return false;

  const [channelMember, workspaceMember] = await Promise.all([
    isChannelMember(userId, channelId),
    prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: channel.workspaceId } },
      select: { id: true },
    }),
  ]);

  return channelMember && !!workspaceMember;
};

export const registerCallHandlers = (io: Server, socket: AuthenticatedSocket) => {
  const user = socket.user;

  // "Ring the channel" notification that drives the IncomingCallBanner —
  // separate from the WebRTC media signaling below. Previously had no
  // authorization check at all: any authenticated socket could ring any
  // channelId, in any workspace, just by knowing its id.
  socket.on('call:initiate', async (data: { channelId: string; callerName: string; callType: 'audio' | 'video' }) => {
    if (!data?.channelId) return;
    try {
      if (!(await verifyCallAccess(user.id, data.channelId))) {
        socket.emit('webrtc:error', { message: 'You are not authorized to start a call in this channel.' });
        return;
      }

      socket.to(data.channelId).emit('call:incoming', {
        channelId: data.channelId,
        callerName: data.callerName,
        callType: data.callType,
        from: user.id,
      });
    } catch (err) {
      console.error('call:initiate failed:', err);
    }
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
  socket.on('webrtc:offer', async (data: { channelId: string; to: string; offer: SessionDescriptionPayload }) => {
    if (!data?.channelId || !data?.to || !isActiveInCall(data.channelId)) return;
    try {
      if (!(await verifyCallAccess(user.id, data.channelId))) {
        removeFromCallRoom(socket, data.channelId);
        return;
      }
      io.to(data.to).emit('webrtc:offer', { from: socket.id, offer: data.offer });
    } catch (err) {
      console.error('webrtc:offer failed:', err);
    }
  });

  socket.on('webrtc:answer', async (data: { channelId: string; to: string; answer: SessionDescriptionPayload }) => {
    if (!data?.channelId || !data?.to || !isActiveInCall(data.channelId)) return;
    try {
      if (!(await verifyCallAccess(user.id, data.channelId))) {
        removeFromCallRoom(socket, data.channelId);
        return;
      }
      io.to(data.to).emit('webrtc:answer', { from: socket.id, answer: data.answer });
    } catch (err) {
      console.error('webrtc:answer failed:', err);
    }
  });

  // Deliberately NOT re-verified against the DB here, unlike offer/answer
  // above — a single connection attempt can generate dozens of these in
  // rapid succession, and by the time they're flowing, the offer/answer for
  // that same peer pairing has already been freshly checked moments earlier.
  // The in-memory room check is still real authorization, not a bypass: a
  // socket can only be "active in call" by having passed verifyCallAccess at
  // webrtc:join (and, per-pairing, at its own offer/answer).
  socket.on('webrtc:ice-candidate', (data: { channelId: string; to: string; candidate: IceCandidatePayload }) => {
    if (!data?.channelId || !data?.to || !isActiveInCall(data.channelId)) return;
    io.to(data.to).emit('webrtc:ice-candidate', { from: socket.id, candidate: data.candidate });
  });

  socket.on('webrtc:leave', (data: { channelId: string }) => {
    if (data?.channelId) removeFromCallRoom(socket, data.channelId);
  });

  socket.on('disconnect', () => {
    for (const channelId of callRooms.keys()) {
      removeFromCallRoom(socket, channelId);
    }
  });
};
