/**
 * Client-side guard for WebRTC call signaling (P1-A, finding FA-RT-01).
 *
 * The server only relays offers/answers/ICE candidates between participants
 * of the same call, but the client must not trust that alone: an offer that
 * isn't from a known participant of the call this overlay joined would make
 * the browser attach its live microphone/camera tracks to a new peer
 * connection and answer it. Participants are only ever learned from
 * `webrtc:existing-participants` / `webrtc:peer-joined`, which the server
 * sends to authorized members of the call room.
 */

export interface SignalEnvelope {
  from?: unknown;
  channelId?: unknown;
}

/** True only for a signal about THIS call, from a participant we were told about. */
export const isSignalFromCallPeer = (
  data: SignalEnvelope | null | undefined,
  channelId: string,
  participants: ReadonlyMap<string, unknown>
): data is SignalEnvelope & { from: string; channelId: string } =>
  !!data && data.channelId === channelId && typeof data.from === 'string' && participants.has(data.from);

/** Cap on ICE candidates buffered for one peer before its offer/answer completes. */
export const MAX_PENDING_CANDIDATES = 64;

// ── Incoming-call ring validation (P1-B, finding FA-RT-02) ──────────────────
// The server now derives the caller's name itself and only relays the two
// call types below, but the ringing UI still must not trust what arrives over
// the socket: a malformed payload must neither crash the banner nor start an
// unknown kind of call when accepted.

export type CallType = 'audio' | 'video';

export interface IncomingCall {
  channelId: string;
  callerName: string;
  callType: CallType;
}

/** Same cap the server applies to the caller name it derives (calls.handlers.ts). */
export const MAX_CALLER_NAME_LENGTH = 80;
const MAX_CHANNEL_ID_LENGTH = 128;

export const isCallType = (value: unknown): value is CallType => value === 'audio' || value === 'video';

/** The name shown while ringing: trimmed, bounded, and never empty or non-text. */
export const displayCallerName = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_CALLER_NAME_LENGTH) : 'Someone';

/**
 * Validates a `call:incoming` payload. No usable channel id or an unsupported
 * call type → null (the ring is ignored); a missing or invalid caller name
 * falls back to "Someone" rather than dropping a legitimate call.
 */
export const parseIncomingCall = (data: unknown): IncomingCall | null => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { channelId, callerName, callType } = data as Record<string, unknown>;
  if (typeof channelId !== 'string' || !channelId || channelId.length > MAX_CHANNEL_ID_LENGTH) return null;
  if (!isCallType(callType)) return null;
  return { channelId, callType, callerName: displayCallerName(callerName) };
};

// ── Ringing lifecycle (P2 Phase H) ────────────────────────────────────────
// Server events: `call:ring_ended` (to the conversation: the ring was
// cancelled, timed out, declined in a 1:1 DM, or answered) and
// `call:declined` (to the caller only). Validated like `call:incoming`.
export type RingEndReason = 'cancelled' | 'timeout' | 'declined' | 'answered';
const RING_END_REASONS = new Set<RingEndReason>(['cancelled', 'timeout', 'declined', 'answered']);

const isChannelId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_CHANNEL_ID_LENGTH;

export const parseRingEnded = (data: unknown): { channelId: string; reason: RingEndReason } | null => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { channelId, reason } = data as Record<string, unknown>;
  if (!isChannelId(channelId) || !RING_END_REASONS.has(reason as RingEndReason)) return null;
  return { channelId, reason: reason as RingEndReason };
};

export const parseCallDeclined = (data: unknown): { channelId: string; userId: string; username: string } | null => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { channelId, userId, username } = data as Record<string, unknown>;
  if (!isChannelId(channelId) || !isChannelId(userId)) return null;
  return { channelId, userId, username: displayCallerName(username) };
};

/** "m:ss", or "h:mm:ss" once a call passes an hour. */
export const formatCallDuration = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};
