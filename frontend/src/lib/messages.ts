/**
 * Pure helpers for the messaging UI — kept free of React/socket concerns so
 * the ordering/dedupe rules can be unit-tested directly.
 */

export type DeliveryState = 'pending' | 'failed';

export interface OrderableMessage {
  id: string;
  createdAt: string;
  clientId?: string | null;
  deliveryState?: DeliveryState;
}

export const PENDING_PREFIX = 'pending:';

export const isPending = (m: OrderableMessage) => m.id.startsWith(PENDING_PREFIX);

/** Collision-resistant id for idempotent sends (matches the server's ^[A-Za-z0-9_-]{8,64}$). */
export const createClientId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

const compareConfirmed = (a: OrderableMessage, b: OrderableMessage) => {
  const ta = new Date(a.createdAt).getTime();
  const tb = new Date(b.createdAt).getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Merges message lists into one ordered, de-duplicated list:
 *  - confirmed messages are unique by id (later lists win, so live updates
 *    override a stale fetched copy) and sorted by (createdAt, id) — the same
 *    total order the server paginates by;
 *  - an optimistic pending/failed entry is dropped once a confirmed message
 *    with the same clientId exists (no double rendering after an ack or a
 *    retried send);
 *  - remaining pending/failed entries stay at the end in send order.
 */
export const mergeMessages = <T extends OrderableMessage>(...lists: T[][]): T[] => {
  const confirmed = new Map<string, T>();
  const pending = new Map<string, T>();
  for (const list of lists) {
    for (const m of list) {
      if (isPending(m)) pending.set(m.id, m);
      else confirmed.set(m.id, confirmed.has(m.id) ? { ...confirmed.get(m.id)!, ...m } : m);
    }
  }
  const confirmedClientIds = new Set(
    Array.from(confirmed.values())
      .map((m) => m.clientId)
      .filter((id): id is string => !!id)
  );
  const stillPending = Array.from(pending.values()).filter((m) => !m.clientId || !confirmedClientIds.has(m.clientId));
  return [...Array.from(confirmed.values()).sort(compareConfirmed), ...stillPending];
};

/** Inserts or replaces a confirmed message (and retires its pending twin). */
export const upsertMessage = <T extends OrderableMessage>(list: T[], message: T): T[] => mergeMessages(list, [message]);

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Plain text of stored message HTML — for previews, pinned bar, URL extraction. */
export const htmlToText = (html: string | null | undefined): string => {
  if (!html) return '';
  return html
    .replace(/<\/(p|div|li|h[1-6])>|<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, ' ')
    .trim();
};

/** http(s) URLs in a message's visible text (never inside markup). */
export const extractUrls = (html: string | null | undefined, max = 3): string[] => {
  const text = htmlToText(html);
  const found = text.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  const cleaned = found.map((u) => u.replace(/[),.;:!?]+$/, ''));
  return Array.from(new Set(cleaned)).slice(0, max);
};

export const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
