import { differenceInCalendarDays, format, isSameDay } from 'date-fns';

/**
 * P2 message-list presentation helpers: per-conversation composer drafts,
 * author grouping, day separators and the attachment-preview guard. Pure
 * (or localStorage-only) so they're unit-testable without rendering ChatArea.
 */

// ── Drafts ────────────────────────────────────────────────────────────────
export interface Draft {
  html: string;
  text: string;
}

export const draftStorageKey = (userId: string, conversationId: string) => `smartconnect:draft:${userId}:${conversationId}`;

// Storage can be unavailable (private mode, blocked site data) — drafts are a
// convenience, so every access fails soft.
const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export const loadDraft = (userId: string | undefined, conversationId: string | undefined): Draft | null => {
  if (!userId || !conversationId) return null;
  try {
    const raw = storage()?.getItem(draftStorageKey(userId, conversationId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { html, text } = parsed as Record<string, unknown>;
    return typeof html === 'string' && typeof text === 'string' ? { html, text } : null;
  } catch {
    return null;
  }
};

export const saveDraft = (userId: string | undefined, conversationId: string | undefined, html: string, text: string) => {
  if (!userId || !conversationId) return;
  try {
    const key = draftStorageKey(userId, conversationId);
    if (!text.trim()) storage()?.removeItem(key);
    else storage()?.setItem(key, JSON.stringify({ html, text }));
  } catch {
    // Quota or access errors — the draft just isn't persisted.
  }
};

export const clearDraft = (userId: string | undefined, conversationId: string | undefined) => {
  if (!userId || !conversationId) return;
  try {
    storage()?.removeItem(draftStorageKey(userId, conversationId));
  } catch {
    // ignore
  }
};

// ── Grouping and day separators ───────────────────────────────────────────
/** Consecutive messages from one author within this window share a header. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export interface LayoutInput {
  id: string;
  senderId: string;
  createdAt: string;
  pollData?: unknown;
  isPinned?: boolean;
}

export interface MessageLayout {
  /** Separator label to render above this message, or null. */
  dayLabel: string | null;
  /** True when the author/avatar header is folded into the previous message. */
  grouped: boolean;
}

export const formatDayLabel = (date: Date, now: Date = new Date()): string => {
  const diff = differenceInCalendarDays(now, date);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.getFullYear() === now.getFullYear() ? format(date, 'EEEE, MMMM d') : format(date, 'MMMM d, yyyy');
};

export const layoutMessages = (messages: LayoutInput[], now: Date = new Date()): Map<string, MessageLayout> => {
  const layout = new Map<string, MessageLayout>();
  let prev: LayoutInput | undefined;
  for (const m of messages) {
    const created = new Date(m.createdAt);
    const prevCreated = prev ? new Date(prev.createdAt) : null;
    const newDay = !prevCreated || !isSameDay(prevCreated, created);
    const grouped =
      !newDay &&
      !!prev &&
      prev.senderId === m.senderId &&
      created.getTime() - prevCreated!.getTime() <= GROUP_WINDOW_MS &&
      !m.pollData &&
      !prev.pollData &&
      !m.isPinned &&
      !prev.isPinned;
    layout.set(m.id, { dayLabel: newDay ? formatDayLabel(created, now) : null, grouped });
    prev = m;
  }
  return layout;
};

// ── Attachments ───────────────────────────────────────────────────────────
// Defense in depth: the server only accepts its own upload URLs
// (lib/messageInput.ts isTrustedUploadUrl); this keeps the inline preview to
// web or same-origin paths regardless.
const PREVIEW_URL = /^(?:https?:\/\/|\/(?!\/))/i;

export const isPreviewableImage = (fileType: string | undefined | null, fileUrl: string | undefined | null): boolean =>
  !!fileType && fileType.toLowerCase().startsWith('image/') && !!fileUrl && PREVIEW_URL.test(fileUrl);
