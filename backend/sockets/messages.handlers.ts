import { destroyFilesOfDeletedMessages, parseAttachmentPath } from '../lib/attachments';
import { Prisma } from '@prisma/client';
import { Server } from 'socket.io';
import { asStoredPoll, isUuid, normalizeContent, normalizeMessageInput } from '../lib/messageInput';
import { createMessageNotifications } from '../lib/notifications';
import { prisma } from '../lib/prisma';
import { toAck } from './ack';
import { CHANNEL_CONTENT_DENIALS, ChannelContentAction } from '../lib/policy';
import { ChannelAccess, checkChannelContent, ensureChannelAccess, getChannelAccess, isMessageVisible, rejectUnauthorized } from './channelAccess';
import { AuthenticatedSocket } from './types';

const ATTACHMENT_UNAVAILABLE = 'This file is no longer available to attach. Upload it again.';
class AttachmentUnavailableError extends Error {}

// Shape broadcast for new/updated messages. Deliberately does NOT include the
// parent message: previously `parent` (with full content) rode along on every
// reply, so a reply pointing at a message in another channel leaked that
// message's content to the sender's channel (audit SEC-05).
const messageInclude = {
  sender: { select: { id: true, username: true } },
  _count: { select: { replies: true } },
} satisfies Prisma.MessageInclude;

// One room per thread, scoped by the parent message's id. Only sockets with a
// ThreadPanel open for that message join it.
const threadRoom = (messageId: string) => `thread_${messageId}`;

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * Delivers an event to every connected member of `channelId` who may still
 * read it: an ACTIVE account, a member of the channel and of its workspace,
 * and — for a channel of a PRIVATE project — a member of that project (the
 * same rules that subscribe a socket to the channel at connect time,
 * channelAccess.subscribeToMemberChannels).
 *
 * T.33: the audience is computed from the database and the event is sent to
 * those members' personal `user:<id>` rooms in one broadcast. No socket list
 * is fetched on the send path — with several instances, fetchSockets() is a
 * round trip through Redis to every instance per message, which the load
 * test showed to dominate send latency (T.33 §T.33.4). A socket whose
 * membership is gone receives nothing from this path even if it is still
 * subscribed; stale channel subscriptions are swept off the send path, at
 * most once per channel every EVICT_EVERY_MS (revocation removes them
 * immediately in the normal flows — sockets/revocation.ts).
 */
const EVICT_EVERY_MS = 30_000;
const lastEviction = new Map<string, number>();

const evictStaleSubscriptions = async (io: Server, channelId: string, allowed: Set<string>) => {
  for (const roomSocket of await io.in(channelId).fetchSockets()) {
    const userId = roomSocket.data?.user?.id;
    if (typeof userId === 'string' && allowed.has(userId)) continue;
    const rooms = [channelId, ...Array.from(roomSocket.rooms).filter((room) => room.startsWith('thread_'))];
    io.in(roomSocket.id).socketsLeave(rooms);
  }
};

const emitToVerifiedMembers = async (
  io: Server,
  channelId: string,
  workspaceId: string,
  event: string,
  payload: unknown,
  // P3 (FA-RT-05): the message's creation time. Members whose history window
  // starts later (e.g. added to a group DM without history) don't receive
  // events about it — they stay subscribed, they just aren't told.
  visibleAt?: Date
) => {
  const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { project: { select: { id: true, visibility: true } } } });
  if (!channel) return;
  const privateProject = channel.project?.visibility === 'PRIVATE' ? channel.project.id : null;
  const members = await prisma.channelMember.findMany({
    where: {
      channelId,
      user: {
        status: 'ACTIVE',
        workspaces: { some: { workspaceId } },
        ...(privateProject ? { projectMemberships: { some: { projectId: privateProject } } } : {}),
      },
    },
    select: { userId: true, historyFrom: true },
  });
  const targets = members.filter((m) => !(visibleAt && m.historyFrom && m.historyFrom > visibleAt)).map((m) => `user:${m.userId}`);
  if (targets.length > 0) io.to(targets).emit(event, payload);

  const now = Date.now();
  if (now - (lastEviction.get(channelId) ?? 0) >= EVICT_EVERY_MS) {
    lastEviction.set(channelId, now);
    if (lastEviction.size > 10_000) lastEviction.clear();
    evictStaleSubscriptions(io, channelId, new Set(members.map((m) => m.userId))).catch((err) =>
      console.error('stale subscription sweep failed:', err instanceof Error ? err.message : err)
    );
  }
};

export const registerMessageHandlers = (io: Server, socket: AuthenticatedSocket) => {
  const user = socket.user;

  const requireChannelAccess = async (channelId: unknown, event: string): Promise<boolean> => {
    if (await ensureChannelAccess(socket, channelId)) return true;
    rejectUnauthorized(socket, { event, channelId: String(channelId ?? '') });
    return false;
  };

  // For operations on an EXISTING message (thread, reply, vote, pin): a fresh
  // DB check that also enforces the member's visible-history window, so a
  // group-DM member added without history can't act on older messages.
  // Returns the fresh access (truthy) so callers can apply content rules.
  const canActOnMessage = async (
    message: { channelId: string; createdAt: Date },
    event: string
  ): Promise<ChannelAccess | null> => {
    const access = await getChannelAccess(user.id, message.channelId);
    if (access && isMessageVisible(access, message)) {
      if (!socket.rooms.has(message.channelId)) socket.join(message.channelId);
      return access;
    }
    rejectUnauthorized(socket, { event, channelId: message.channelId });
    return null;
  };

  // Batch 3/D: archived channels are read-only; announcement channels limit
  // top-level posts (lib/policy canChannelContent). Always a fresh DB check —
  // room membership alone says nothing about the channel's current state.
  const contentDenial = async (channelId: string, action: ChannelContentAction, known?: ChannelAccess | null) => {
    const access = known ?? (await getChannelAccess(user.id, channelId));
    if (!access) return CHANNEL_CONTENT_DENIALS.notMember;
    return checkChannelContent(user.id, access, action);
  };

  // .volatile: a stale typing indicator is noise, so it is dropped rather
  // than queued while a recipient is momentarily disconnected.
  // P3 (FA-RT-10): remember where this socket is typing, so a disconnect
  // mid-typing still tells those conversations it stopped.
  const typingIn = new Set<string>();
  const relayTyping = (event: 'typing:started' | 'typing:stopped') => async (data: { channelId?: unknown }) => {
    try {
      if (!(await requireChannelAccess(data?.channelId, event))) return;
      const channelId = data.channelId as string;
      if (event === 'typing:started') typingIn.add(channelId);
      else typingIn.delete(channelId);
      socket.volatile.to(channelId).emit(event, { channelId, userId: user.id, username: user.username });
    } catch (err) {
      console.error(`${event} failed:`, err);
    }
  };
  socket.on('typing:start', relayTyping('typing:started'));
  socket.on('typing:stop', relayTyping('typing:stopped'));
  socket.on('disconnect', () => {
    for (const channelId of typingIn) {
      socket.to(channelId).emit('typing:stopped', { channelId, userId: user.id, username: user.username });
    }
    typingIn.clear();
  });

  socket.on('thread:join', async (data: { messageId?: unknown }, maybeAck?: unknown) => {
    const ack = toAck(maybeAck);
    try {
      if (!isUuid(data?.messageId)) return ack({ ok: false, error: 'Invalid thread.' });
      const parent = await prisma.message.findUnique({
        where: { id: data.messageId },
        select: { channelId: true, parentId: true, createdAt: true },
      });
      if (!parent || parent.parentId) return ack({ ok: false, error: 'Thread not found.' });
      if (!(await canActOnMessage(parent, 'thread:join'))) {
        return ack({ ok: false, error: 'Thread not found.' });
      }
      socket.join(threadRoom(data.messageId));
      ack({ ok: true });
    } catch (err) {
      console.error('thread:join failed:', err);
      ack({ ok: false, error: 'Could not open thread.' });
    }
  });

  socket.on('thread:leave', (data: { messageId?: unknown }) => {
    if (isUuid(data?.messageId)) socket.leave(threadRoom(data.messageId));
  });

  /**
   * Reliable send:
   *  1. Validate + sanitize the whole payload (lib/messageInput.ts).
   *  2. Authorize: channel + workspace membership, ACTIVE sender.
   *  3. Thread replies must target a top-level message in the SAME channel.
   *  4. Idempotent on (senderId, clientId): a retried send returns the
   *     original message instead of creating a duplicate.
   *  5. Persist, then broadcast, then acknowledge with the stored message.
   */
  socket.on('message:send', async (data: unknown, maybeAck?: unknown) => {
    const ack = toAck(maybeAck);
    const parsed = normalizeMessageInput(data);
    if (!parsed.ok) return ack({ ok: false, error: parsed.error });
    const input = parsed.value;

    try {
      if (!(await requireChannelAccess(input.channelId, 'message:send'))) {
        return ack({ ok: false, error: 'You are not a member of this channel.' });
      }

      const channel = await prisma.channel.findUnique({
        where: { id: input.channelId },
        select: { workspaceId: true },
      });
      if (!channel) return ack({ ok: false, error: 'Channel not found.' });

      // Room membership only proves access at subscription time — re-verify
      // the sender against the current WorkspaceMember + User.status rows.
      const senderMembership = await prisma.workspaceMember.findFirst({
        where: { workspaceId: channel.workspaceId, userId: user.id, user: { status: 'ACTIVE' } },
        select: { id: true },
      });
      if (!senderMembership) {
        rejectUnauthorized(socket, {
          event: 'message:send',
          channelId: input.channelId,
          message: 'You are no longer an active member of this workspace.',
        });
        socket.leave(input.channelId);
        return ack({ ok: false, error: 'You are no longer an active member of this workspace.' });
      }

      const sendDenial = await contentDenial(input.channelId, input.parentId ? 'reply' : 'post');
      if (sendDenial) return ack({ ok: false, error: sendDenial });

      if (input.parentId) {
        const parent = await prisma.message.findUnique({
          where: { id: input.parentId },
          select: { channelId: true, parentId: true, createdAt: true },
        });
        if (
          !parent ||
          parent.channelId !== input.channelId ||
          parent.parentId !== null ||
          !(await canActOnMessage(parent, 'message:send'))
        ) {
          return ack({ ok: false, error: 'Thread parent not found in this channel.' });
        }
      }

      if (input.clientId) {
        const existing = await prisma.message.findUnique({
          where: { senderId_clientId: { senderId: user.id, clientId: input.clientId } },
          include: messageInclude,
        });
        if (existing) return ack({ ok: true, duplicate: true, message: existing });
      }

      // T.32 (audit H3/M9): a private upload can be attached only by the
      // person who uploaded it, and only once; its stored name and type are
      // authoritative (not what the client claims).
      const attachmentId = parseAttachmentPath(input.fileUrl);
      let attachment: { id: string; originalName: string; mimeType: string } | null = null;
      if (attachmentId) {
        attachment = await prisma.attachment.findFirst({
          // T.33: a file already attached to a task cannot also be sent.
          where: { id: attachmentId, uploaderId: user.id, messageId: null, taskId: null },
          select: { id: true, originalName: true, mimeType: true },
        });
        if (!attachment) return ack({ ok: false, error: ATTACHMENT_UNAVAILABLE });
      }

      let msg;
      try {
        msg = await prisma.$transaction(async (tx) => {
          const created = await tx.message.create({
            data: {
              content: input.content,
              fileUrl: input.fileUrl,
              fileName: attachment?.originalName ?? input.fileName,
              fileType: attachment?.mimeType ?? input.fileType,
              pollData: input.pollData ? (input.pollData as unknown as Prisma.InputJsonValue) : undefined,
              channelId: input.channelId,
              workspaceId: channel.workspaceId,
              senderId: user.id,
              parentId: input.parentId,
              clientId: input.clientId,
            },
            include: messageInclude,
          });
          if (attachment) {
            const bound = await tx.attachment.updateMany({
              where: { id: attachment.id, uploaderId: user.id, messageId: null, taskId: null },
              data: { messageId: created.id },
            });
            if (bound.count !== 1) throw new AttachmentUnavailableError();
          }
          return created;
        });
      } catch (err) {
        if (err instanceof AttachmentUnavailableError) return ack({ ok: false, error: ATTACHMENT_UNAVAILABLE });
        // Two concurrent retries with the same clientId: the loser returns
        // the winner's row rather than failing or duplicating.
        if (input.clientId && isUniqueViolation(err)) {
          const existing = await prisma.message.findUnique({
            where: { senderId_clientId: { senderId: user.id, clientId: input.clientId } },
            include: messageInclude,
          });
          if (existing) return ack({ ok: true, duplicate: true, message: existing });
        }
        throw err;
      }

      await emitToVerifiedMembers(io, input.channelId, channel.workspaceId, 'message:received', msg);

      if (msg.parentId) {
        io.to(threadRoom(msg.parentId)).emit('thread:message_received', msg);
        const replyCount = await prisma.message.count({ where: { parentId: msg.parentId } });
        io.to(input.channelId).emit('thread:reply_count_updated', { parentId: msg.parentId, replyCount });
      }

      ack({ ok: true, message: msg });

      // P2 Phase I: @mentions and thread replies. After the ack — a
      // notification failure must never fail or delay the send itself.
      createMessageNotifications(msg, (userId, notification) => io.to(`user:${userId}`).emit('notification:new', notification)).catch(
        (err) => console.error('notifications failed:', err)
      );
    } catch (err) {
      console.error('message:send failed:', err);
      ack({ ok: false, error: 'Failed to send message. Please retry.' });
    }
  });

  // Poll votes are a read-modify-write of a JSON column. The row lock makes
  // concurrent votes serialize instead of overwriting each other (RT-05).
  socket.on('poll:vote', async (data: { messageId?: unknown; optionId?: unknown }, maybeAck?: unknown) => {
    const ack = toAck(maybeAck);
    if (!isUuid(data?.messageId) || typeof data?.optionId !== 'string') {
      return ack({ ok: false, error: 'Invalid vote.' });
    }
    const messageId = data.messageId;
    const optionId = data.optionId;
    try {
      const head = await prisma.message.findUnique({
        where: { id: messageId },
        select: { channelId: true, pollData: true, createdAt: true },
      });
      if (!head || !asStoredPoll(head.pollData)) return ack({ ok: false, error: 'Poll not found.' });
      const voteAccess = await canActOnMessage(head, 'poll:vote');
      if (!voteAccess) return ack({ ok: false, error: 'Poll not found.' });
      const voteDenial = await contentDenial(head.channelId, 'vote', voteAccess);
      if (voteDenial) return ack({ ok: false, error: voteDenial });

      const updated = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Message" WHERE "id" = ${messageId} FOR UPDATE`;
        const row = await tx.message.findUnique({ where: { id: messageId }, select: { pollData: true } });
        const poll = asStoredPoll(row?.pollData);
        if (!poll || !poll.options.some((o) => o.id === optionId)) return null;
        const options = poll.options.map((o) => {
          const others = o.votes.filter((v) => v !== user.id);
          return { ...o, votes: o.id === optionId ? [...others, user.id] : others };
        });
        return tx.message.update({
          where: { id: messageId },
          data: { pollData: { ...poll, options } as unknown as Prisma.InputJsonValue },
          include: messageInclude,
        });
      });
      if (!updated) return ack({ ok: false, error: 'Unknown poll option.' });

      await emitToVerifiedMembers(io, updated.channelId, updated.workspaceId, 'message:updated', updated, updated.createdAt);
      ack({ ok: true, message: updated });
    } catch (err) {
      console.error('poll:vote failed:', err);
      ack({ ok: false, error: 'Could not record vote.' });
    }
  });

  socket.on('message:edit', async (data: { id?: unknown; content?: unknown }, maybeAck?: unknown) => {
    const ack = toAck(maybeAck);
    try {
      if (!isUuid(data?.id)) return ack({ ok: false, error: 'Invalid message.' });
      const existing = await prisma.message.findUnique({ where: { id: data.id } });
      if (!existing) return ack({ ok: false, error: 'Message not found.' });
      if (existing.senderId !== user.id) return ack({ ok: false, error: 'You can only edit your own messages.' });
      if (!(await requireChannelAccess(existing.channelId, 'message:edit'))) {
        return ack({ ok: false, error: 'You are not a member of this channel.' });
      }
      if (existing.pollData) return ack({ ok: false, error: 'Polls cannot be edited.' });
      const editDenial = await contentDenial(existing.channelId, 'edit');
      if (editDenial) return ack({ ok: false, error: editDenial });

      const content = normalizeContent(data.content);
      if (!content.ok) return ack({ ok: false, error: content.error });
      if (!content.value && !existing.fileUrl) return ack({ ok: false, error: 'Message cannot be empty.' });

      const updated = await prisma.message.update({
        where: { id: existing.id },
        data: { content: content.value, editedAt: new Date() }, // P2: drives the "edited" label
        include: messageInclude,
      });
      await emitToVerifiedMembers(io, updated.channelId, updated.workspaceId, 'message:updated', updated, updated.createdAt);
      if (updated.parentId) io.to(threadRoom(updated.parentId)).emit('thread:message_updated', updated);
      ack({ ok: true, message: updated });
    } catch (err) {
      console.error('message:edit failed:', err);
      ack({ ok: false, error: 'Could not edit message.' });
    }
  });

  socket.on('message:delete', async (data: { id?: unknown }, maybeAck?: unknown) => {
    const ack = toAck(maybeAck);
    try {
      if (!isUuid(data?.id)) return ack({ ok: false, error: 'Invalid message.' });
      const existing = await prisma.message.findUnique({ where: { id: data.id } });
      if (!existing) return ack({ ok: false, error: 'Message not found.' });
      if (existing.senderId !== user.id) return ack({ ok: false, error: 'You can only delete your own messages.' });
      if (!(await requireChannelAccess(existing.channelId, 'message:delete'))) {
        return ack({ ok: false, error: 'You are not a member of this channel.' });
      }
      const deleteDenial = await contentDenial(existing.channelId, 'delete');
      if (deleteDenial) return ack({ ok: false, error: deleteDenial });

      // Thread replies go with their parent (cascade): collect their files first.
      const replies = await prisma.message.findMany({ where: { parentId: existing.id }, select: { id: true, fileUrl: true } });
      await prisma.message.delete({ where: { id: existing.id } });
      // T.32 (audit M10): the stored files of deleted messages are destroyed too.
      void destroyFilesOfDeletedMessages([existing, ...replies]).catch((err) => console.error('File cleanup after delete failed:', err));
      io.to(existing.channelId).emit('message:deleted', existing.id);
      if (existing.parentId) {
        io.to(threadRoom(existing.parentId)).emit('thread:message_deleted', {
          parentId: existing.parentId,
          id: existing.id,
        });
        const replyCount = await prisma.message.count({ where: { parentId: existing.parentId } });
        io.to(existing.channelId).emit('thread:reply_count_updated', { parentId: existing.parentId, replyCount });
      }
      ack({ ok: true });
    } catch (err) {
      console.error('message:delete failed:', err);
      ack({ ok: false, error: 'Could not delete message.' });
    }
  });

  socket.on('message:pin', async (data: { id?: unknown; isPinned?: unknown }, maybeAck?: unknown) => {
    const ack = toAck(maybeAck);
    try {
      if (!isUuid(data?.id) || typeof data?.isPinned !== 'boolean') return ack({ ok: false, error: 'Invalid request.' });
      const existing = await prisma.message.findUnique({
        where: { id: data.id },
        select: { channelId: true, createdAt: true },
      });
      if (!existing) return ack({ ok: false, error: 'Message not found.' });
      const pinAccess = await canActOnMessage(existing, 'message:pin');
      if (!pinAccess) return ack({ ok: false, error: 'Message not found.' });
      const pinDenial = await contentDenial(existing.channelId, 'pin', pinAccess);
      if (pinDenial) return ack({ ok: false, error: pinDenial });

      const updated = await prisma.message.update({
        where: { id: data.id },
        data: { isPinned: data.isPinned },
        include: messageInclude,
      });
      await emitToVerifiedMembers(io, updated.channelId, updated.workspaceId, 'message:updated', updated, updated.createdAt);
      ack({ ok: true, message: updated });
    } catch (err) {
      console.error('message:pin failed:', err);
      ack({ ok: false, error: 'Could not update pin.' });
    }
  });
};
