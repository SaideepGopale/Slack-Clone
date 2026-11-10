import { CLOUDINARY_CLOUD_NAME } from '../config/env';
import { htmlToPlainText, sanitizeMessageHtml } from './sanitize';

/**
 * Server-side validation for every message write that arrives over Socket.IO.
 *
 * message:send is a socket event, not a form post — nothing stops a client
 * from bypassing the composer and emitting arbitrary payloads. Previously
 * fileUrl/fileName/fileType/pollData/parentId were persisted verbatim
 * (audit SEC-09, SEC-05); everything below is the actual trust boundary.
 */

export const MESSAGE_LIMITS = {
  contentHtml: 20_000,
  contentText: 8_000,
  fileName: 255,
  fileType: 100,
  fileUrl: 2_048,
  pollQuestion: 300,
  pollOption: 200,
  pollOptionsMin: 2,
  pollOptionsMax: 10,
} as const;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: string): Result<T> => ({ ok: false, error });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(\s*;\s*[a-z0-9-]+=[a-z0-9.+_-]+)*$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value);

const isBlank = (value: unknown) => value === undefined || value === null || value === '';

/**
 * Only URLs that our own upload endpoint can have produced: HTTPS delivery
 * URLs on this account's Cloudinary cloud, inside the upload folder used by
 * upload.middleware.ts. Anything else (phishing links, tracking pixels,
 * `javascript:` URLs) is rejected.
 */
export const isTrustedUploadUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > MESSAGE_LIMITS.fileUrl) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === 'res.cloudinary.com' &&
    !url.username &&
    !url.password &&
    url.pathname.startsWith(`/${CLOUDINARY_CLOUD_NAME}/`) &&
    url.pathname.includes('/workspace-uploads/')
  );
};

/** Sanitized HTML, or null when the message has no visible text at all. */
export const normalizeContent = (raw: unknown): Result<string | null> => {
  if (isBlank(raw)) return ok(null);
  if (typeof raw !== 'string') return fail('Message content must be text.');
  if (raw.length > MESSAGE_LIMITS.contentHtml) return fail('Message is too long.');
  const clean = sanitizeMessageHtml(raw);
  const text = htmlToPlainText(clean);
  if (text.length > MESSAGE_LIMITS.contentText) return fail('Message is too long.');
  return ok(text.length > 0 ? clean : null);
};

export interface PollOption {
  id: string;
  text: string;
  votes: string[];
}

export interface PollData {
  question: string;
  options: PollOption[];
}

/**
 * New polls always start with zero votes and server-assigned option ids — a
 * client can no longer create a poll with pre-filled (forged) votes.
 */
export const normalizeNewPoll = (raw: unknown): Result<PollData> => {
  if (!raw || typeof raw !== 'object') return fail('Invalid poll.');
  const { question, options } = raw as { question?: unknown; options?: unknown };
  if (typeof question !== 'string' || !question.trim() || question.length > MESSAGE_LIMITS.pollQuestion) {
    return fail(`A poll needs a question of at most ${MESSAGE_LIMITS.pollQuestion} characters.`);
  }
  if (
    !Array.isArray(options) ||
    options.length < MESSAGE_LIMITS.pollOptionsMin ||
    options.length > MESSAGE_LIMITS.pollOptionsMax
  ) {
    return fail(`A poll needs between ${MESSAGE_LIMITS.pollOptionsMin} and ${MESSAGE_LIMITS.pollOptionsMax} options.`);
  }
  const texts: string[] = [];
  for (const option of options) {
    const text = typeof option === 'string' ? option : (option as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > MESSAGE_LIMITS.pollOption) {
      return fail(`Each poll option must be 1-${MESSAGE_LIMITS.pollOption} characters.`);
    }
    texts.push(text.trim());
  }
  return ok({
    question: question.trim(),
    options: texts.map((text, index) => ({ id: `opt-${index}`, text, votes: [] })),
  });
};

/** Shape check for a poll already stored in the database (used by poll:vote). */
export const asStoredPoll = (raw: unknown): PollData | null => {
  if (!raw || typeof raw !== 'object') return null;
  const { question, options } = raw as { question?: unknown; options?: unknown };
  if (typeof question !== 'string' || !Array.isArray(options)) return null;
  const valid = options.every(
    (o) =>
      o &&
      typeof o === 'object' &&
      typeof (o as PollOption).id === 'string' &&
      typeof (o as PollOption).text === 'string' &&
      Array.isArray((o as PollOption).votes)
  );
  return valid ? (raw as PollData) : null;
};

export interface NormalizedMessageInput {
  channelId: string;
  content: string | null;
  fileUrl: string | null;
  fileName: string | null;
  fileType: string | null;
  pollData: PollData | null;
  parentId: string | null;
  clientId: string | null;
}

export const normalizeMessageInput = (data: unknown): Result<NormalizedMessageInput> => {
  if (!data || typeof data !== 'object') return fail('Invalid message payload.');
  const raw = data as Record<string, unknown>;

  if (!isUuid(raw.channelId)) return fail('A valid channelId is required.');

  const content = normalizeContent(raw.content);
  if (!content.ok) return content;

  let fileUrl: string | null = null;
  let fileName: string | null = null;
  let fileType: string | null = null;
  if (!isBlank(raw.fileUrl)) {
    if (!isTrustedUploadUrl(raw.fileUrl)) return fail('Attachments must be uploaded through SmartConnect.');
    fileUrl = raw.fileUrl;
    const name = typeof raw.fileName === 'string' ? raw.fileName.replace(CONTROL_CHARS_RE, '').trim() : '';
    fileName = (name || 'attachment').slice(0, MESSAGE_LIMITS.fileName);
    const type = typeof raw.fileType === 'string' ? raw.fileType.trim() : '';
    if (type && (type.length > MESSAGE_LIMITS.fileType || !MIME_RE.test(type))) return fail('Invalid attachment type.');
    fileType = type || 'application/octet-stream';
  }

  let pollData: PollData | null = null;
  if (!isBlank(raw.pollData)) {
    const poll = normalizeNewPoll(raw.pollData);
    if (!poll.ok) return poll;
    pollData = poll.value;
  }

  let parentId: string | null = null;
  if (!isBlank(raw.parentId)) {
    if (!isUuid(raw.parentId)) return fail('Invalid thread parent.');
    parentId = raw.parentId;
  }

  let clientId: string | null = null;
  if (!isBlank(raw.clientId)) {
    if (typeof raw.clientId !== 'string' || !CLIENT_ID_RE.test(raw.clientId)) return fail('Invalid clientId.');
    clientId = raw.clientId;
  }

  if (!content.value && !fileUrl && !pollData) return fail('Message cannot be empty.');
  if (pollData && parentId) return fail('Polls cannot be posted inside threads.');

  return ok({ channelId: raw.channelId, content: content.value, fileUrl, fileName, fileType, pollData, parentId, clientId });
};
