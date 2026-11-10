export interface AckResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export type Ack = (response: AckResponse) => void;

/**
 * Socket.IO passes the acknowledgement callback as the last argument only
 * when the client asked for one. Normalizes "maybe a function" into a callable
 * so every handler can answer unconditionally.
 */
export const toAck = (maybeAck: unknown): Ack =>
  typeof maybeAck === 'function' ? (maybeAck as Ack) : () => undefined;
