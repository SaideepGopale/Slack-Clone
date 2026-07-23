import { Server } from 'socket.io';
import { prisma } from '../lib/prisma';
import { sanitizeMessageHtml } from '../lib/sanitize';
import { isInChannelRoom, rejectUnauthorized } from './channelAccess';
import { AuthenticatedSocket } from './types';

const senderInclude = {
  sender: { select: { id: true, username: true } },
  parent: { include: { sender: { select: { id: true, username: true } } } },
};

// One room per thread, scoped by the parent message's id — separate from the
// channel room a reply's own message:received still goes to (that keeps
// WorkspaceLayout's global unread-badge counting working for replies exactly
// like it already does for top-level messages). Only sockets with a
// ThreadPanel actually open for this message join it, so the full reply
// content only ever reaches someone who asked for it.
const threadRoom = (messageId: string) => `thread_${messageId}`;

export const registerMessageHandlers = (io: Server, socket: AuthenticatedSocket) => {
  const user = socket.user;

  // Every handler below trusts "this socket is sitting in the channel's
  // Socket.IO room" as proof of membership — that room can only have been
  // joined via `channel:join`, which now verifies BOTH channel membership
  // and the workspace that owns the channel (see channels.handlers.ts +
  // channelAccess.ts). So this is a Set lookup, not a query: no per-message
  // database round-trip just to re-authorize an event that was already
  // authorized at join time.
  //
  // Cross-workspace isolation falls out of this for free: every `io.to(...)`
  // /`socket.to(...)` broadcast below is scoped to `channelId` (the room),
  // and channel ids are globally unique UUIDs — a message sent in
  // Workspace A's "General" is emitted to room <workspace-A-general-id>,
  // which no Workspace B socket has ever joined (join-time checks above see
  // to that), so it structurally cannot reach them. There's no separate
  // "workspace room" to manage; the channel room already IS the isolation
  // boundary, one layer down.
  const requireChannelAccess = (channelId: string, event: string): boolean => {
    if (isInChannelRoom(socket, channelId)) return true;
    rejectUnauthorized(socket, { event, channelId });
    return false;
  };

  // .volatile: a typing indicator is only ever useful in the instant it's
  // sent — if a recipient's socket is momentarily disconnected/buffering,
  // Socket.IO's default behavior would queue this for delivery on reconnect,
  // which is actively wrong here (a "so-and-so is typing" from 10 seconds
  // ago is just noise). Dropping it is the correct behavior, not a
  // reliability gap: the next keystroke re-emits typing:start anyway.
  socket.on('typing:start', (data: { channelId: string }) => {
    if (!data?.channelId || !requireChannelAccess(data.channelId, 'typing:start')) return;
    socket.volatile.to(data.channelId).emit('typing:started', { channelId: data.channelId, username: user.username });
  });

  socket.on('typing:stop', (data: { channelId: string }) => {
    if (!data?.channelId || !requireChannelAccess(data.channelId, 'typing:stop')) return;
    socket.volatile.to(data.channelId).emit('typing:stopped', { channelId: data.channelId, username: user.username });
  });

  // Gated on the PARENT message's channel room, the same trust model
  // requireChannelAccess uses everywhere else in this file — a socket can
  // only be sitting in that room if channel:join already DB-verified it, so
  // this itself needs no fresh query beyond looking up which channel the
  // parent belongs to.
  socket.on('thread:join', async (data: { messageId: string }) => {
    if (!data?.messageId) return;
    try {
      const parent = await prisma.message.findUnique({
        where: { id: data.messageId },
        select: { channelId: true },
      });
      if (!parent || !requireChannelAccess(parent.channelId, 'thread:join')) return;
      socket.join(threadRoom(data.messageId));
    } catch (err) { console.error(err); }
  });

  socket.on('thread:leave', (data: { messageId: string }) => {
    if (data?.messageId) socket.leave(threadRoom(data.messageId));
  });

  socket.on('message:send', async (data) => {
    if (!data?.channelId || !requireChannelAccess(data.channelId, 'message:send')) return;
    try {
      // Message.workspaceId is denormalized from channel.workspaceId (see
      // schema.prisma) — this is a data lookup, not an authorization check
      // (requireChannelAccess above already handled that), so it doesn't
      // conflict with this file's "no DB hit just to re-authorize" rule; it's
      // the same one-query-per-action shape as poll:vote/message:edit below.
      const channel = await prisma.channel.findUnique({
        where: { id: data.channelId },
        select: { workspaceId: true },
      });
      if (!channel) return;

      // requireChannelAccess/isInChannelRoom only prove membership *at
      // channel:join time* — a workspace removal or ban afterward doesn't
      // retroactively evict an already-open socket (documented gap in
      // channelAccess.ts). Before a message is ever created or broadcast,
      // re-verify against the real, current WorkspaceMember + active
      // User.status rows — both for the sender (below) and for whichever
      // sockets actually receive the emit (after creation, further down).
      const activeMembers = await prisma.workspaceMember.findMany({
        where: { workspaceId: channel.workspaceId, user: { status: 'ACTIVE' } },
        select: { userId: true },
      });
      const activeMemberIds = new Set(activeMembers.map((m) => m.userId));

      if (!activeMemberIds.has(user.id)) {
        rejectUnauthorized(socket, {
          event: 'message:send',
          channelId: data.channelId,
          message: 'You are no longer an active member of this workspace.',
        });
        socket.leave(data.channelId);
        return;
      }

      const msg = await prisma.message.create({
        data: {
          // Sanitized server-side regardless of what the client claims to
          // have sent — message:send is a socket event, not a form post;
          // nothing stops a client from bypassing the rich text editor's UI
          // entirely and emitting arbitrary HTML directly.
          content: data.content ? sanitizeMessageHtml(data.content) : data.content,
          fileUrl: data.fileUrl,
          fileName: data.fileName,
          fileType: data.fileType,
          pollData: data.pollData,
          channelId: data.channelId,
          workspaceId: channel.workspaceId,
          senderId: user.id,
          parentId: data.parentId || null,
        },
        include: senderInclude,
      });

      // Verified-receivers broadcast: only sockets in this room that are
      // still real, active workspace members get the message — anyone else
      // (membership revoked since they joined) is evicted from the room
      // instead of being trusted indefinitely. Single-process assumption,
      // matching presence.handlers.ts's in-memory presence map: io.sockets.sockets
      // is the local socket registry, which preserves the `.user` property
      // set directly on each socket. A multi-node deployment behind a Redis
      // adapter would need io.in(...).fetchSockets() + socket.data instead,
      // since fetchSockets() only serializes `.data`, not arbitrary properties.
      for (const roomSocket of io.sockets.sockets.values()) {
        if (!roomSocket.rooms.has(data.channelId)) continue;
        const authedSocket = roomSocket as AuthenticatedSocket;
        if (activeMemberIds.has(authedSocket.user.id)) {
          authedSocket.emit('message:received', msg);
        } else {
          authedSocket.leave(data.channelId);
          // Symmetry with the channel-room eviction above: a membership
          // revoked mid-session shouldn't leave a stale socket sitting in any
          // thread room either, even though thread:join itself re-verifies
          // channel-room membership at join time.
          for (const room of authedSocket.rooms) {
            if (room.startsWith('thread_')) authedSocket.leave(room);
          }
        }
      }

      // A reply also gets the full-content broadcast above (into the channel
      // room, via message:received) — same as any other message, so
      // WorkspaceLayout's unread-badge counting keeps working unchanged for
      // replies. This is the *additional* live update a thread needs: the
      // full reply, scoped to whoever actually has that thread open, plus a
      // lightweight count bump for the parent's "N replies" button for
      // everyone else just watching the channel.
      if (msg.parentId) {
        io.to(threadRoom(msg.parentId)).emit('thread:message_received', msg);
        const replyCount = await prisma.message.count({ where: { parentId: msg.parentId } });
        io.to(data.channelId).emit('thread:reply_count_updated', { parentId: msg.parentId, replyCount });
      }
    } catch (err) { console.error(err); }
  });

  // Live poll vote tally. The channelId isn't in the payload (only the
  // messageId is), so we look the message up first and gate on *its*
  // channelId before touching anything.
  socket.on('poll:vote', async (data) => {
    try {
      const existing = await prisma.message.findUnique({ where: { id: data.messageId } });
      if (!existing || !existing.pollData) return;
      if (!requireChannelAccess(existing.channelId, 'poll:vote')) return;

      const pollData: any = existing.pollData;

      // Remove the user's vote from every other option so they can only vote once.
      pollData.options.forEach((opt: any) => {
        opt.votes = opt.votes.filter((id: string) => id !== user.id);
      });

      const selectedOption = pollData.options.find((opt: any) => opt.id === data.optionId);
      if (selectedOption) {
        selectedOption.votes.push(user.id);
      }

      const updated = await prisma.message.update({
        where: { id: data.messageId },
        data: { pollData },
        include: { sender: { select: { username: true } } },
      });

      io.to(updated.channelId).emit('message:updated', updated);
    } catch (err) { console.error(err); }
  });

  socket.on('message:edit', async (data) => {
    try {
      const existing = await prisma.message.findUnique({ where: { id: data.id } });
      if (!existing || existing.senderId !== user.id) return;
      if (!requireChannelAccess(existing.channelId, 'message:edit')) return;

      const updated = await prisma.message.update({
        where: { id: data.id },
        data: { content: data.content ? sanitizeMessageHtml(data.content) : data.content },
        include: { sender: { select: { username: true } } },
      });
      io.to(updated.channelId).emit('message:updated', updated);
    } catch (err) { console.error(err); }
  });

  socket.on('message:delete', async (data) => {
    try {
      const existing = await prisma.message.findUnique({ where: { id: data.id } });
      if (!existing || existing.senderId !== user.id) return;
      if (!requireChannelAccess(existing.channelId, 'message:delete')) return;

      await prisma.message.delete({ where: { id: data.id } });
      io.to(existing.channelId).emit('message:deleted', data.id);
    } catch (err) { console.error(err); }
  });

  socket.on('message:pin', async (data) => {
    try {
      // Previously went straight to `update` with no existence or membership
      // check at all — anyone could pin/unpin any message by guessing its id.
      const existing = await prisma.message.findUnique({ where: { id: data.id } });
      if (!existing) return;
      if (!requireChannelAccess(existing.channelId, 'message:pin')) return;

      const updated = await prisma.message.update({
        where: { id: data.id },
        data: { isPinned: data.isPinned },
        include: { sender: { select: { username: true } } },
      });
      io.to(updated.channelId).emit('message:updated', updated);
    } catch (err) { console.error(err); }
  });
};
