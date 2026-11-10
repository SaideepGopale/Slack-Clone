import { Prisma } from '@prisma/client';
import { isUuid } from '../../lib/messageInput';
import { prisma } from '../../lib/prisma';
import { ChannelAccess, visibleHistoryFilter } from '../../sockets/channelAccess';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Persistent read state (Batch 2).
 *
 * Source of truth: ChannelMember.(lastReadAt, lastReadMessageId), one row
 * per user per conversation. Because the pointer lives in that single row
 * and only ever moves forward (see markRead), concurrent marks from several
 * tabs/devices converge on the furthest position, and read receipts —
 * derived from the same pointer — can never be duplicated.
 *
 * Unread = top-level messages from other people after the pointer, inside
 * the member's visible-history window. Counting is capped (UNREAD_CAP) so a
 * channel with a huge backlog costs at most one bounded index range scan.
 *
 * Timestamp comparisons happen column-to-column inside SQL: Prisma stores
 * DateTime as UTC in timestamp-without-time-zone columns, so binding JS Dates
 * or using NOW() unqualified would depend on the DB session time zone.
 */

export const UNREAD_CAP = 100;

export interface ReadState {
  channelId: string;
  lastReadMessageId: string | null;
  lastReadAt: Date;
  unreadCount: number;
}

const readStateQuery = (userId: string, scope: Prisma.Sql) => Prisma.sql`
  SELECT cm."channelId", cm."lastReadMessageId", cm."lastReadAt",
    (SELECT COUNT(*)::int FROM (
       SELECT 1 FROM "Message" m
       WHERE m."channelId" = cm."channelId"
         AND m."parentId" IS NULL
         AND m."senderId" <> ${userId}
         AND (m."createdAt" > cm."lastReadAt"
              OR (m."createdAt" = cm."lastReadAt"
                  AND cm."lastReadMessageId" IS NOT NULL
                  AND m."id" > cm."lastReadMessageId"))
         AND (cm."historyFrom" IS NULL OR m."createdAt" >= cm."historyFrom")
       LIMIT ${UNREAD_CAP}
     ) AS capped) AS "unreadCount"
  FROM "ChannelMember" cm
  JOIN "Channel" c ON c."id" = cm."channelId"
  LEFT JOIN "Project" p ON p."id" = c."projectId"
  WHERE cm."userId" = ${userId} AND ${scope}
    -- Batch 3/C (lib/policy projectAllowsChannelAccess): a private project's
    -- channels count only for project members.
    AND (p."id" IS NULL OR p."visibility" = 'PUBLIC'
         OR EXISTS (SELECT 1 FROM "ProjectMember" pm WHERE pm."projectId" = p."id" AND pm."userId" = ${userId}))
`;

/** Read state of every channel and DM the user belongs to in a workspace. */
export const getWorkspaceReadState = async (userId: string, workspaceId: string): Promise<ReadState[]> =>
  prisma.$queryRaw<ReadState[]>(readStateQuery(userId, Prisma.sql`c."workspaceId" = ${workspaceId}`));

export const getChannelReadState = async (userId: string, channelId: string): Promise<ReadState | null> => {
  const rows = await prisma.$queryRaw<ReadState[]>(readStateQuery(userId, Prisma.sql`cm."channelId" = ${channelId}`));
  return rows[0] ?? null;
};

/**
 * Advances the caller's read position to `messageId` (or to the latest
 * visible top-level message when omitted). Monotonic and atomic: the
 * conditional UPDATE only applies when the target is strictly newer than the
 * stored position, so a stale tab/device can never move it backwards.
 */
export const markRead = async (
  userId: string,
  access: ChannelAccess,
  messageId?: unknown
): Promise<{ state: ReadState; advanced: boolean }> => {
  let targetId: string | null = null;
  if (messageId !== undefined && messageId !== null) {
    if (!isUuid(messageId)) throw new HttpError(400, 'Invalid messageId.');
    const target = await prisma.message.findFirst({
      where: { id: messageId, channelId: access.channelId, ...visibleHistoryFilter(access) },
      select: { id: true },
    });
    if (!target) throw new HttpError(400, 'Unknown message for this conversation.');
    targetId = target.id;
  } else {
    const latest = await prisma.message.findFirst({
      where: { channelId: access.channelId, parentId: null, ...visibleHistoryFilter(access) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    targetId = latest?.id ?? null;
  }

  let advanced = false;
  if (targetId) {
    const updated = await prisma.$executeRaw`
      UPDATE "ChannelMember" AS cm
      SET "lastReadAt" = m."createdAt",
          "lastReadMessageId" = m."id",
          "updatedAt" = (NOW() AT TIME ZONE 'UTC')
      FROM "Message" AS m
      WHERE m."id" = ${targetId}
        AND cm."userId" = ${userId}
        AND cm."channelId" = ${access.channelId}
        AND (cm."lastReadAt" < m."createdAt"
             OR (cm."lastReadAt" = m."createdAt"
                 AND (cm."lastReadMessageId" IS NULL OR cm."lastReadMessageId" < m."id")))
    `;
    advanced = updated > 0;
  }

  const state = await getChannelReadState(userId, access.channelId);
  if (!state) throw new HttpError(403, 'You are not a member of this conversation.');
  return { state, advanced };
};

export const readReceiptsEnabled = async (userId: string): Promise<boolean> => {
  const profile = await prisma.userProfile.findUnique({ where: { userId }, select: { readReceiptsEnabled: true } });
  return profile?.readReceiptsEnabled ?? true;
};

export interface Receipt {
  userId: string;
  username: string;
  lastReadMessageId: string | null;
  lastReadAt: Date | null;
}

const sharingReceiptsFilter = {
  OR: [{ profile: { is: null } }, { profile: { is: { readReceiptsEnabled: true } } }],
} satisfies Prisma.UserWhereInput;

// A member who joined a group DM without shared history must not learn the
// position of messages that predate them.
const maskForViewer = (receipt: Receipt, viewerHistoryFrom: Date | null): Receipt =>
  viewerHistoryFrom && receipt.lastReadAt && receipt.lastReadAt < viewerHistoryFrom
    ? { ...receipt, lastReadMessageId: null, lastReadAt: null }
    : receipt;

/**
 * Read receipts — privacy rules:
 *  - only in direct conversations (1:1 and group DMs), never in channels;
 *  - only other participants who share receipts are included;
 *  - reciprocal: a viewer who turned receipts off sees none.
 * Membership is enforced by requireChannelMembership before this runs.
 */
export const getReadReceipts = async (userId: string, access: ChannelAccess) => {
  if (!access.isDM) return { enabled: false as const, reason: 'not_a_conversation' as const, receipts: [] as Receipt[] };
  if (!(await readReceiptsEnabled(userId))) {
    return { enabled: false as const, reason: 'disabled' as const, receipts: [] as Receipt[] };
  }
  const rows = await prisma.channelMember.findMany({
    where: { channelId: access.channelId, userId: { not: userId }, user: sharingReceiptsFilter },
    select: { userId: true, lastReadAt: true, lastReadMessageId: true, user: { select: { username: true } } },
  });
  return {
    enabled: true as const,
    receipts: rows.map((r) =>
      maskForViewer(
        { userId: r.userId, username: r.user.username, lastReadMessageId: r.lastReadMessageId, lastReadAt: r.lastReadAt },
        access.historyFrom
      )
    ),
  };
};

/**
 * Who should receive a live receipt for `readerId`'s new position: the other
 * current participants of a direct conversation who share receipts — only
 * if the reader shares receipts too. Returns each recipient's masked view.
 */
export const receiptRecipients = async (readerId: string, access: ChannelAccess, state: ReadState) => {
  if (!access.isDM || !(await readReceiptsEnabled(readerId))) return [];
  const reader = await prisma.user.findUnique({ where: { id: readerId }, select: { username: true } });
  const recipients = await prisma.channelMember.findMany({
    where: { channelId: access.channelId, userId: { not: readerId }, user: sharingReceiptsFilter },
    select: { userId: true, historyFrom: true },
  });
  const receipt: Receipt = {
    userId: readerId,
    username: reader?.username ?? '',
    lastReadMessageId: state.lastReadMessageId,
    lastReadAt: state.lastReadAt,
  };
  return recipients.map((r) => ({ userId: r.userId, receipt: maskForViewer(receipt, r.historyFrom) }));
};

export { HttpError };
