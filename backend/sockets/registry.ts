import { Server } from 'socket.io';

// Lets REST-side code (admin.service.ts) reach the live Socket.IO server
// without importing sockets/index.ts directly, which would pull in the full
// server-construction/middleware setup and risk a circular import back into
// the modules that register admin routes.
let io: Server | null = null;

export const setSocketServer = (server: Server) => {
  io = server;
};

// Forcibly disconnects every active socket session for a user — used both
// when an admin bans/suspends someone via REST (real-time enforcement, not
// "wait for their token to expire or next reconnect") and by the explicit
// admin:user:kick socket event. Every authenticated socket joins a
// `user:<id>` room on connect (see sockets/index.ts), so this is just a
// room-scoped disconnect; a no-op if the user has no active connections.
export const kickUserSockets = (userId: string) => {
  io?.in(`user:${userId}`).disconnectSockets(true);
};

// Lets a REST-side admin delete (message moderation, file storage cleanup)
// broadcast the exact same `message:deleted` event the normal owner-only
// socket delete already emits (see sockets/messages.handlers.ts) — every
// channel member's ChatArea already listens for this, so an admin-initiated
// delete disappears from their screen instantly with zero frontend changes.
export const broadcastMessageDeleted = (channelId: string, messageId: string) => {
  io?.to(channelId).emit('message:deleted', messageId);
};

// Lets a REST-side "add member to channel" action (channels.controller.ts)
// notify the newly-added user in real time — they aren't in the channel's
// own Socket.IO room yet (that's the whole point: they're being invited into
// it), so this reaches them via their personal `user:<id>` room instead. The
// frontend feeds this straight into WorkspaceContext's addChannel, the same
// helper used right after creating a channel, so the new channel appears in
// their sidebar instantly with no refetch.
export const notifyChannelMemberAdded = (targetUserId: string, channel: unknown) => {
  io?.to(`user:${targetUserId}`).emit('channel:member_added', channel);
};

// Lets the REST reactions endpoint (messages.controller.ts) broadcast the
// exact same event every channel member's ChatArea already listens for —
// same event name and payload shape the old socket-only reaction handlers
// used, so no frontend listener changes were needed to switch the write path
// from socket events to a REST call.
export const broadcastReactionUpdate = (channelId: string, messageId: string, reactions: unknown) => {
  io?.to(channelId).emit('message:reaction:updated', { messageId, reactions });
};
