import { Prisma } from '@prisma/client';
import { HttpError } from './httpError';
import { isUuid } from './messageInput';
import { prisma } from './prisma';
import { htmlToPlainText } from './sanitize';

/**
 * P2 Phase I — mention/reply notifications and workspace search.
 *
 * Authorization model: a notification or search result only ever describes a
 * message in a conversation the recipient/caller is CURRENTLY a member of
 * (ChannelMember row, within their visible-history window) in a workspace they
 * explicitly belong to. Notifications are re-filtered at read time, so leaving
 * a conversation also hides its earlier mentions.
 */


// ── Mentions ──────────────────────────────────────────────────────────────
// "@name" not preceded by a word character, dot, @ or dash (so e-mail
// addresses don't count); names are 1–40 characters and never end in . _ -
const MENTION = /(^|[^A-Za-z0-9._@-])@([A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}[A-Za-z0-9])?)/g;
export const MAX_MENTIONS_PER_MESSAGE = 20;

/** Lower-cased, de-duplicated usernames mentioned in a message's HTML. */
export const extractMentions = (html: string | null | undefined): string[] => {
  const names = new Set<string>();
  for (const match of htmlToPlainText(html).matchAll(MENTION)) {
    names.add(match[2].toLowerCase());
    if (names.size >= MAX_MENTIONS_PER_MESSAGE) break;
  }
  return [...names];
};

export type NotificationType = 'MENTION' | 'REPLY';

const PREVIEW_LENGTH = 160;
const preview = (content: string | null, fileName: string | null) => {
  const text = htmlToPlainText(content) || (fileName ? `Attachment: ${fileName}` : 'Message');
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
};

const conversationSelect = {
  id: true,
  name: true,
  isDM: true,
  isGroupDM: true,
  workspaceId: true,
  members: { select: { user: { select: { id: true, username: true } } }, take: 10 },
} satisfies Prisma.ChannelSelect;

type ConversationRow = Prisma.ChannelGetPayload<{ select: typeof conversationSelect }>;

/** Display name of a conversation for this viewer: "#name", or the other people in a DM. */
const conversationView = (channel: ConversationRow, viewerId: string) => {
  const others = channel.members.map((m) => m.user.username).filter((_, i) => channel.members[i].user.id !== viewerId);
  const label = channel.isDM ? others.join(', ') || 'Direct message' : channel.name ?? 'channel';
  return { id: channel.id, name: channel.name, isDM: channel.isDM, isGroupDM: channel.isGroupDM, label };
};

const notificationSelect = {
  id: true,
  userId: true,
  type: true,
  isRead: true,
  createdAt: true,
  message: {
    select: {
      id: true,
      parentId: true,
      content: true,
      fileName: true,
      createdAt: true,
      sender: { select: { id: true, username: true } },
      channel: { select: conversationSelect },
    },
  },
} satisfies Prisma.NotificationSelect;

type NotificationRow = Prisma.NotificationGetPayload<{ select: typeof notificationSelect }>;

const toNotificationView = (n: NotificationRow) => ({
  id: n.id,
  type: n.type as NotificationType,
  isRead: n.isRead,
  createdAt: n.createdAt,
  workspaceId: n.message.channel.workspaceId,
  channel: conversationView(n.message.channel, n.userId),
  message: {
    id: n.message.id,
    parentId: n.message.parentId,
    createdAt: n.message.createdAt,
    preview: preview(n.message.content, n.message.fileName),
    sender: n.message.sender,
  },
});
export type NotificationView = ReturnType<typeof toNotificationView>;

/**
 * Creates MENTION notifications for mentioned members of the conversation and
 * a REPLY notification for the thread's author, never for the sender or for
 * anyone who isn't an active member of both the conversation and its
 * workspace. `deliver` pushes each one live to its recipient.
 */
export const createMessageNotifications = async (
  message: { id: string; content: string | null; channelId: string; senderId: string; parentId: string | null },
  deliver: (userId: string, notification: NotificationView) => void
) => {
  const channel = await prisma.channel.findUnique({ where: { id: message.channelId }, select: { workspaceId: true } });
  if (!channel) return [];
  const eligible = (userIds?: string[], usernames?: string[]) =>
    prisma.channelMember.findMany({
      where: {
        channelId: message.channelId,
        userId: { not: message.senderId, ...(userIds ? { in: userIds } : {}) },
        user: {
          status: 'ACTIVE',
          workspaces: { some: { workspaceId: channel.workspaceId } },
          ...(usernames ? { username: { in: usernames, mode: 'insensitive' as const } } : {}),
        },
      },
      select: { userId: true },
    });

  const recipients = new Map<string, NotificationType>();
  const mentioned = extractMentions(message.content);
  if (mentioned.length > 0) {
    for (const m of await eligible(undefined, mentioned)) recipients.set(m.userId, 'MENTION');
  }
  if (message.parentId) {
    const parent = await prisma.message.findUnique({ where: { id: message.parentId }, select: { senderId: true } });
    if (parent && !recipients.has(parent.senderId) && (await eligible([parent.senderId])).length > 0) {
      recipients.set(parent.senderId, 'REPLY');
    }
  }
  if (recipients.size === 0) return [];

  const created = await prisma.$transaction(
    [...recipients].map(([userId, type]) =>
      prisma.notification.create({ data: { userId, type, messageId: message.id }, select: notificationSelect })
    )
  );
  const views = created.map(toNotificationView);
  for (const view of views) deliver(created.find((n) => n.id === view.id)!.userId, view);
  return views;
};

// ── Feed ──────────────────────────────────────────────────────────────────
const requireWorkspaceMember = async (userId: string, workspaceId: unknown): Promise<string> => {
  if (!isUuid(workspaceId)) throw new HttpError(400, 'A valid workspace is required.');
  const member = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { id: true },
  });
  if (!member) throw new HttpError(403, 'You are not a member of this workspace.');
  return workspaceId;
};

const visibleTo = (userId: string, workspaceId: string): Prisma.NotificationWhereInput => ({
  userId,
  message: { channel: { workspaceId, members: { some: { userId } } } },
});

export const listNotifications = async (userId: string, workspaceIdParam: unknown) => {
  const workspaceId = await requireWorkspaceMember(userId, workspaceIdParam);
  const where = visibleTo(userId, workspaceId);
  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where, select: notificationSelect, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.notification.count({ where: { ...where, isRead: false } }),
  ]);
  return { notifications: rows.map(toNotificationView), unreadCount };
};

/** Marks the caller's own notifications read — all in the workspace, or just `ids`. */
export const markNotificationsRead = async (userId: string, workspaceIdParam: unknown, ids: unknown) => {
  const workspaceId = await requireWorkspaceMember(userId, workspaceIdParam);
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 200 || !ids.every(isUuid))) {
    throw new HttpError(400, 'ids must be a list of notification ids.');
  }
  const { count } = await prisma.notification.updateMany({
    where: { ...visibleTo(userId, workspaceId), isRead: false, ...(ids ? { id: { in: ids as string[] } } : {}) },
    data: { isRead: true },
  });
  return { updated: count };
};

// ── Workspace search ──────────────────────────────────────────────────────
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 200;

export const searchWorkspace = async (userId: string, workspaceIdParam: unknown, q: unknown) => {
  const workspaceId = await requireWorkspaceMember(userId, workspaceIdParam);
  const query = typeof q === 'string' ? q.trim() : '';
  if (query.length < SEARCH_MIN || query.length > SEARCH_MAX) {
    throw new HttpError(400, `Search for ${SEARCH_MIN}–${SEARCH_MAX} characters.`);
  }

  // Only conversations the caller belongs to, within their history window.
  const memberships = await prisma.channelMember.findMany({
    where: { userId, channel: { workspaceId } },
    select: { channelId: true, historyFrom: true },
  });
  if (memberships.length === 0) return { results: [] };
  const fullHistory = memberships.filter((m) => !m.historyFrom).map((m) => m.channelId);
  const scope: Prisma.MessageWhereInput[] = [
    ...(fullHistory.length > 0 ? [{ channelId: { in: fullHistory } }] : []),
    ...memberships.filter((m) => m.historyFrom).map((m) => ({ channelId: m.channelId, createdAt: { gte: m.historyFrom! } })),
  ];

  const messages = await prisma.message.findMany({
    where: { content: { contains: query, mode: 'insensitive' }, OR: scope },
    select: {
      id: true,
      parentId: true,
      content: true,
      fileName: true,
      createdAt: true,
      sender: { select: { id: true, username: true } },
      channel: { select: conversationSelect },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 30,
  });
  return {
    results: messages.map((m) => ({
      id: m.id,
      parentId: m.parentId,
      createdAt: m.createdAt,
      preview: preview(m.content, m.fileName),
      sender: m.sender,
      channel: conversationView(m.channel, userId),
    })),
  };
};
