import { destroyFilesOfDeletedMessages } from '../../lib/attachments';
import { groupReactions } from '../../lib/reactionSummary';
import { prisma } from '../../lib/prisma';
import { checkChannelContent, getChannelAccess, isMessageVisible, visibleHistoryFilter } from '../../sockets/channelAccess';

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
};

/**
 * "N replies" on each message, without loading the replies' content (those
 * are fetched on demand when a thread opens — getThread below).
 *
 * T.33: counted here for exactly the rows returned — one grouped query on
 * the (parentId, createdAt) index. Prisma's `_count: { replies }` include on
 * findMany generated `LEFT JOIN (SELECT parentId, COUNT(*) FROM "Message"
 * GROUP BY parentId)` — an aggregate over the WHOLE message table on every
 * page load. Under the 500-user load test that one query took 95% of all
 * database time and grew with the table (T.33 §T.33.4). Same `_count` shape
 * as before, so clients are unchanged.
 */
const withReplyCounts = async <T extends { id: string }>(rows: T[]): Promise<(T & { _count: { replies: number } })[]> => {
  if (rows.length === 0) return [];
  const counts = await prisma.message.groupBy({ by: ['parentId'], where: { parentId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
  const byParent = new Map(counts.map((c) => [c.parentId, c._count._all]));
  return rows.map((r) => ({ ...r, _count: { replies: byParent.get(r.id) ?? 0 } }));
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
  limit: number = DEFAULT_PAGE_SIZE,
  after?: string,
  // The requesting member's visible-history window (group DM members added
  // without shared history). Omitted = full history.
  history: { historyFrom: Date | null } = { historyFrom: null }
): Promise<MessagePage> => {
  const take = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
  const visible = visibleHistoryFilter(history);

  // Reconnect backfill: everything newer than the last message the client
  // already has, oldest-first, so it can be appended in order. The anchor
  // must belong to this channel — a foreign id is rejected rather than used
  // as a position in someone else's history.
  if (after) {
    const anchor = await prisma.message.findFirst({
      where: { id: after, channelId, ...visible },
      select: { id: true, createdAt: true },
    });
    if (!anchor) throw new HttpError(400, 'Unknown "after" message for this channel.');
    const newer = await prisma.message.findMany({
      where: {
        channelId,
        parentId: null,
        ...visible,
        OR: [{ createdAt: { gt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { gt: anchor.id } }],
      },
      include: messageInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: take + 1,
    });
    return {
      messages: (await withReplyCounts(newer.slice(0, take))).map(withGroupedReactions),
      nextCursor: null,
      hasMore: newer.length > take,
    };
  }

  if (cursor) {
    const cursorRow = await prisma.message.findFirst({ where: { id: cursor, channelId, ...visible }, select: { id: true } });
    if (!cursorRow) throw new HttpError(400, 'Unknown cursor for this channel.');
  }

  const rows = await prisma.message.findMany({
    // Thread replies are fetched separately, on demand, by getThread below —
    // the channel's main list only ever shows top-level messages now.
    where: { channelId, parentId: null, ...visible },
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
    messages: (await withReplyCounts(page.reverse())).map(withGroupedReactions),
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

  const access = await getChannelAccess(userId, parent.channelId);
  if (!access) {
    throw new HttpError(403, 'You are not a member of this channel.');
  }
  // A member without shared history can't open threads that predate them.
  if (!isMessageVisible(access, parent)) throw new HttpError(404, 'Message not found');

  // Scoped to the parent's channel: a reply row from another channel
  // (possible before message:send validated parentId) is never returned.
  const replies = await prisma.message.findMany({
    where: { parentId: messageId, channelId: parent.channelId, ...visibleHistoryFilter(access) },
    include: messageInclude,
    orderBy: { createdAt: 'asc' },
  });

  const [counted] = await withReplyCounts([parent]);
  return {
    parent: withGroupedReactions(counted),
    replies: (await withReplyCounts(replies)).map(withGroupedReactions),
  };
};

export const searchChannelMessages = async (
  channelId: string,
  query: string,
  history: { historyFrom: Date | null } = { historyFrom: null }
) => {
  const messages = await prisma.message.findMany({
    where: { channelId, content: { contains: query, mode: 'insensitive' }, ...visibleHistoryFilter(history) },
    include: messageInclude,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return (await withReplyCounts(messages)).map(withGroupedReactions);
};

// P2 Phase G: the conversation's pinned top-level messages, newest first,
// within the member's visible-history window. Independent of how much
// history the client has paged in.
export const getPinnedMessages = async (channelId: string, history: { historyFrom: Date | null } = { historyFrom: null }) => {
  const messages = await prisma.message.findMany({
    where: { channelId, parentId: null, isPinned: true, ...visibleHistoryFilter(history) },
    include: messageInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 50,
  });
  return (await withReplyCounts(messages)).map(withGroupedReactions);
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

  const replies = await prisma.message.findMany({ where: { parentId: messageId }, select: { id: true, fileUrl: true } });
  await prisma.message.delete({ where: { id: messageId } });
  // T.32 (audit M10): the deleted messages' stored files go too.
  void destroyFilesOfDeletedMessages([existing, ...replies]).catch((err) => console.error('File cleanup after moderation delete failed:', err));

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
    select: { channelId: true, createdAt: true },
  });
  if (!message) throw new HttpError(404, 'Message not found');

  // Same channel + workspace membership check requireChannelMembership uses.
  const access = await getChannelAccess(userId, message.channelId);
  if (!access) {
    throw new HttpError(403, 'You are not a member of this channel.');
  }
  if (!isMessageVisible(access, message)) throw new HttpError(404, 'Message not found');
  // Batch 3/D: reactions follow the content rules (archived = read-only).
  const denial = await checkChannelContent(userId, access, 'react');
  if (denial) throw new HttpError(access.archived ? 409 : 403, denial);

  // T.32 (audit M13): race-safe toggle. Removing first is atomic (deleteMany
  // on the unique key); only when nothing was removed is one added, with
  // ON CONFLICT DO NOTHING — two concurrent toggles can no longer collide on
  // the unique index and 500.
  const removed = await prisma.reaction.deleteMany({ where: { userId, messageId, emoji } });
  if (removed.count === 0) {
    await prisma.reaction.createMany({ data: [{ userId, messageId, emoji }], skipDuplicates: true });
  }

  const reactions = await prisma.reaction.findMany({
    where: { messageId },
    include: { user: { select: { id: true, username: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return { channelId: message.channelId, reactions: groupReactions(reactions) };
};

export { HttpError };
