/**
 * Tiny pub/sub that lets the header's in-channel search ask the open
 * conversation (ChatArea) to bring a message into view — without the two
 * components knowing about each other.
 */
export interface MessageFocusTarget {
  channelId: string;
  messageId: string;
  /** Set for thread replies: the conversation opens the parent's thread. */
  parentId?: string | null;
}

type Listener = (target: MessageFocusTarget) => void;
const listeners = new Set<Listener>();

export const requestMessageFocus = (target: MessageFocusTarget) => {
  listeners.forEach((listener) => listener(target));
};

// P2 Phase I: a focus request made while navigating to a different
// conversation (search results, Activity). The conversation consumes it once
// its messages have loaded; a newer request replaces an older one.
let pending: MessageFocusTarget | null = null;

export const requestMessageFocusAfterNavigation = (target: MessageFocusTarget) => {
  pending = target;
  requestMessageFocus(target);
};

/** Returns (and forgets) the pending request for `channelId`, if any. */
export const takePendingFocus = (channelId: string): MessageFocusTarget | null => {
  if (!pending || pending.channelId !== channelId) return null;
  const target = pending;
  pending = null;
  return target;
};

/** Returns an unsubscribe function. */
export const onMessageFocus = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
