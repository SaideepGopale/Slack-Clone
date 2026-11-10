import { ReadState } from '../types';

/**
 * Client-side mirror of the server's persisted read state. The server is the
 * source of truth (GET /api/workspaces/:id/unread, `read:updated` events);
 * the client only applies optimistic increments for live messages in
 * between, and never lets an older state overwrite a newer one.
 */

export const UNREAD_DISPLAY_CAP = 100;

export type ReadStateMap = Record<string, ReadState>;

export const toReadStateMap = (states: ReadState[]): ReadStateMap =>
  Object.fromEntries(states.map((s) => [s.channelId, s]));

const positionOf = (s: Pick<ReadState, 'lastReadAt' | 'lastReadMessageId'>) =>
  [new Date(s.lastReadAt).getTime(), s.lastReadMessageId ?? ''] as const;

/** True when `a` is a strictly later read position than `b`. */
export const isLaterPosition = (
  a: Pick<ReadState, 'lastReadAt' | 'lastReadMessageId'>,
  b: Pick<ReadState, 'lastReadAt' | 'lastReadMessageId'>
) => {
  const [ta, ia] = positionOf(a);
  const [tb, ib] = positionOf(b);
  return ta > tb || (ta === tb && ia > ib);
};

/**
 * Applies an authoritative state from the server. A state whose read
 * position is older than the one we hold (an out-of-order response from
 * another tab's earlier request) is ignored.
 */
export const applyReadState = (map: ReadStateMap, incoming: ReadState): ReadStateMap => {
  const current = map[incoming.channelId];
  if (current && isLaterPosition(current, incoming)) return map;
  return { ...map, [incoming.channelId]: incoming };
};

export interface IncomingMessage {
  id: string;
  channelId: string;
  senderId: string;
  parentId?: string | null;
  createdAt: string;
}

export interface ViewContext {
  currentUserId?: string;
  activeChannelId?: string | null;
  // The conversation is on screen AND the tab is visible.
  isViewing: boolean;
}

/**
 * Optimistic unread bump for a live message. Mirrors the server's counting
 * rule (top-level messages from other people after the read position); a
 * message the user is actively looking at is not counted (the view marks it
 * read on the server right after).
 */
export const applyIncomingMessage = (map: ReadStateMap, msg: IncomingMessage, ctx: ViewContext): ReadStateMap => {
  if (msg.parentId || msg.senderId === ctx.currentUserId) return map;
  if (ctx.isViewing && ctx.activeChannelId === msg.channelId) return map;
  const current = map[msg.channelId];
  if (current && !isLaterPosition({ lastReadAt: msg.createdAt, lastReadMessageId: msg.id }, current)) return map;
  const base: ReadState = current ?? {
    channelId: msg.channelId,
    unreadCount: 0,
    lastReadMessageId: null,
    lastReadAt: new Date(0).toISOString(),
  };
  return { ...map, [msg.channelId]: { ...base, unreadCount: base.unreadCount + 1 } };
};

export const unreadCountsOf = (map: ReadStateMap): Record<string, number> =>
  Object.fromEntries(Object.values(map).filter((s) => s.unreadCount > 0).map((s) => [s.channelId, s.unreadCount]));

export const formatUnread = (count: number) => (count >= UNREAD_DISPLAY_CAP ? '99+' : String(count));
