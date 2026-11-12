import { Receipt } from '../types';

interface PositionedMessage {
  id: string;
  createdAt: string;
}

/** Whether a participant's read pointer is at or past `message`. */
export const hasRead = (receipt: Receipt, message: PositionedMessage): boolean => {
  if (!receipt.lastReadAt) return false;
  const readAt = new Date(receipt.lastReadAt).getTime();
  const at = new Date(message.createdAt).getTime();
  if (readAt !== at) return readAt > at;
  return (receipt.lastReadMessageId ?? '') >= message.id;
};

/** Usernames of the participants who have read `message`. */
export const seenBy = (receipts: Receipt[], message: PositionedMessage | undefined): string[] =>
  message ? receipts.filter((r) => hasRead(r, message)).map((r) => r.username) : [];

/** Short label: "Seen" in 1:1 conversations, "Seen by A, B" (or "+N") in groups. */
export const seenLabel = (names: string[], isGroup: boolean): string | null => {
  if (names.length === 0) return null;
  if (!isGroup) return 'Seen';
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `Seen by ${shown} +${names.length - 3}` : `Seen by ${shown}`;
};

/** Replaces one participant's receipt (live `receipt:updated`), keeping the newest position. */
export const upsertReceipt = (receipts: Receipt[], next: Receipt): Receipt[] => {
  const current = receipts.find((r) => r.userId === next.userId);
  if (current?.lastReadAt && next.lastReadAt && new Date(current.lastReadAt) > new Date(next.lastReadAt)) return receipts;
  return [...receipts.filter((r) => r.userId !== next.userId), next];
};
