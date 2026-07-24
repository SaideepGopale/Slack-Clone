import { groupReactions } from '../../lib/reactionSummary';
import { prisma } from '../../lib/prisma';
import { isChannelMember } from '../../sockets/channelAccess';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const messageInclude = {
  sender: { select: { id: true, username: true } },
  reactions: {
    include: { user: { select: { id: true, username: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
  // Lets the frontend show "N replies" on a parent message without eagerly
  // loading every reply's full content — those are fetched on demand, only
  // when a thread is actually opened (see getThread below).
  _count: { select: { replies: true } },
};

// Reshape each message's raw Reaction rows into the same grouped
// {emoji, count, users}[] shape the live `message:reaction:updated` socket
// event uses, so the frontend has one format for both initial load and
// real-time updates.
const withGroupedReactions = <T extends { reactions: any[] }>(message: T) => ({
  ...message,
  reactions: groupReactions(message.reactions),
});

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export interface MessagePage {
  messages: ReturnType<typeof withGroupedReactions>[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Cursor pagination keyed on message `id` (the compound-unique-friendly,
 * always-monotonic-with-createdAt cursor Prisma recommends for this pattern),
 * ordered by `createdAt desc` under the hood so each page is "the next chunk
 * of older messages." `cursor` is the id of the oldest message the client
 * already has — omit it for the first page (the most recent messages).
 *
 * No cursor: page 1 = the 50 most recent messages, oldest-first for display.
 * With cursor=<id>: the 50 messages immediately older than that message.
 *
 * `take: limit + 1` (fetch one extra) lets us report `hasMore` without a
 * separate COUNT query — if we got back more than `limit` rows, there's at
 * least one more page after this one.
 */
export const getChannelMessages = async (
  channelId: string,
  cursor?: string,
  limit: number = DEFAULT_PAGE_SIZE
): Promise<MessagePage> => {
  const take = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);

  const rows = await prisma.message.findMany({
    // Thread replies are fetched separately, on demand, by getThread below —
    // the channel's main list only ever shows top-level messages now.
    where: { channelId, parentId: null },
    include: messageInclude,
    // `id` is a required tiebreaker, not decoration: two messages can land in
    // the same millisecond (createdAt has ms precision, and a busy channel
    // sends faster than that), and `createdAt desc` alone isn't a stable
    // total order across ties. Without a deterministic order matching the
    // cursor, pages can skip or duplicate rows whenever a page boundary
    // falls inside a group of same-timestamp messages — verified this
    // actually happens with a 120-message burst before adding the `id` key.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const page = rows.slice(0, take);

  // Capture the cursor (the oldest row in this desc-ordered page) BEFORE
  // reversing — `.reverse()` mutates `page` in place, so reading it after
  // would silently grab the newest row's id instead.
  const nextCursor = hasMore ? page[page.length - 1].id : null;

  return {
    // Reverse to ascending (oldest-first) order for direct rendering —
    // matches the pre-pagination endpoint's contract, just one page at a time.
    messages: page.reverse().map(withGroupedReactions),
    nextCursor,
    hasMore,
  };
};

/**
 * Powers ThreadPanel.tsx: the parent message plus every reply, fetched
 * on-demand only when a thread is actually opened (see the comment on
 * getChannelMessages' `parentId: null` filter above). No pagination here —
 * a single message's reply count is expected to stay small relative to a
 * whole channel's history, unlike getChannelMessages.
 */
export const getThread = async (userId: string, messageId: string) => {
  const parent = await prisma.message.findUnique({
    where: { id: messageId },
    include: messageInclude,
  });
  if (!parent) throw new HttpError(404, 'Message not found');

  if (!(await isChannelMember(userId, parent.channelId))) {
    throw new HttpError(403, 'You are not a member of this channel.');
  }

  const replies = await prisma.message.findMany({
    where: { parentId: messageId },
    include: messageInclude,
    orderBy: { createdAt: 'asc' },
  });

  return {
    parent: withGroupedReactions(parent),
    replies: replies.map(withGroupedReactions),
  };
};

export const searchChannelMessages = async (channelId: string, query: string) => {
  const messages = await prisma.message.findMany({
    where: { channelId, content: { contains: query, mode: 'insensitive' } },
    include: messageInclude,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return messages.map(withGroupedReactions);
};

// Admin content-moderation search — across every non-DM channel, not just
// one. DMs are deliberately excluded: this is a workspace-moderation tool,
// not a way for admins to read private 1:1 conversations.
export const searchMessagesGlobal = async (query: string) => {
  return prisma.message.findMany({
    where: {
      content: { contains: query, mode: 'insensitive' },
      channel: { isDM: false },
    },
    include: {
      sender: { select: { id: true, username: true } },
      channel: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
};

type AdminDeleteMessageResult =
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'deleted'; channelId: string; senderUsername: string; contentPreview: string };

// Admin override of the owner-only delete in sockets/messages.handlers.ts's
// message:delete — same DM restriction as searchMessagesGlobal above.
export const adminDeleteMessage = async (messageId: string): Promise<AdminDeleteMessageResult> => {
  const existing = await prisma.message.findUnique({
    where: { id: messageId },
    include: { channel: { select: { isDM: true } }, sender: { select: { username: true } } },
  });
  if (!existing) return { status: 'not_found' };
  if (existing.channel.isDM) return { status: 'forbidden' };

  await prisma.message.delete({ where: { id: messageId } });

  return {
    status: 'deleted',
    channelId: existing.channelId,
    senderUsername: existing.sender.username,
    contentPreview: existing.content?.slice(0, 80) || (existing.fileName ? `[file: ${existing.fileName}]` : '[empty message]'),
  };
};

/**
 * Single idempotent toggle rather than separate add/remove actions — the
 * caller doesn't need to know (or trust its own possibly-stale local state
 * about) whether it's already reacted; the current DB row is the only source
 * of truth for that. This is the REST counterpart to (and now the only
 * implementation behind) what used to be two separate socket events —
 * see messages.controller.ts's toggleReactionHandler for the broadcast side.
 */
export const toggleReaction = async (userId: string, messageId: string, emoji: string) => {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { channelId: true },
  });
  if (!message) throw new HttpError(404, 'Message not found');

  // REST has no "already in the channel's socket room" shortcut to lean on
  // (see channelAccess.ts's isInChannelRoom) — this is a real DB check, same
  // one requireChannelMembership uses for the channel-scoped message routes.
  if (!(await isChannelMember(userId, message.channelId))) {
    throw new HttpError(403, 'You are not a member of this channel.');
  }

  const existing = await prisma.reaction.findUnique({
    where: { userId_messageId_emoji: { userId, messageId, emoji } },
  });

  if (existing) {
    await prisma.reaction.delete({ where: { id: existing.id } });
  } else {
    await prisma.reaction.create({ data: { userId, messageId, emoji } });
  }

  const reactions = await prisma.reaction.findMany({
    where: { messageId },
    include: { user: { select: { id: true, username: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return { channelId: message.channelId, reactions: groupReactions(reactions) };
};

export { HttpError };
