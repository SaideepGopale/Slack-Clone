import { randomBytes } from 'crypto';
import { Attachment } from '@prisma/client';
import { CLOUDINARY_CLOUD_NAME } from '../config/env';
import { getChannelAccess, isMessageVisible } from '../sockets/channelAccess';
import { cloudinary } from './cloudinary';
import { canTask, loadProjectActor } from './policy';
import { prisma } from './prisma';

/**
 * Private file attachments (T.32, audit H3/M9/M10).
 *
 * New uploads are stored in Cloudinary with delivery type "authenticated"
 * under an unguessable random public id (128 random bits), so the stored
 * asset is neither public nor guessable. Messages reference an upload by the
 * app path `/api/attachments/<id>`; a caller exchanges that for a
 * short-lived signed Cloudinary URL only after the same access check that
 * guards the message itself (channel/DM membership, private project, visible
 * history window). Uploads are bound to their uploader, can be attached by
 * that uploader only, and only once.
 *
 * Files uploaded before T.32 were public "upload"-type assets; their URLs keep
 * working as before (they are already public) — scripts/privatize-legacy-files.ts
 * converts them. Nothing here claims those are private until converted.
 */
export const UPLOAD_FOLDER = 'workspace-uploads';
export const ATTACHMENT_PATH_PREFIX = '/api/attachments/';
// Signed links are valid for 10 minutes; clients ask again when they expire.
export const SIGNED_URL_TTL_SECONDS = 10 * 60;
// An upload never sent in a message (or orphaned by a channel/workspace
// deletion) is destroyed after this long.
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const attachmentPath = (id: string) => `${ATTACHMENT_PATH_PREFIX}${id}`;

/** The attachment id inside an app attachment path, or null. */
export const parseAttachmentPath = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.startsWith(ATTACHMENT_PATH_PREFIX)) return null;
  const id = value.slice(ATTACHMENT_PATH_PREFIX.length);
  return UUID_RE.test(id) ? id : null;
};

/** 32 hex characters (128 bits) — the asset's name inside UPLOAD_FOLDER. */
export const randomAssetName = () => randomBytes(16).toString('hex');

/** A safe file extension (".pdf") from a user-supplied filename, or "". */
export const safeExtension = (originalName: string): string => {
  const dot = originalName.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = originalName.slice(dot).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
export const cleanOriginalName = (name: string) => (name.replace(CONTROL_CHARS, '').trim() || 'attachment').slice(0, 255);

/**
 * A signed, expiring URL for one private asset (Cloudinary's authenticated
 * download API). `download` asks the browser to save it under its original
 * name instead of displaying it.
 */
export const signedAttachmentUrl = (attachment: Pick<Attachment, 'publicId' | 'resourceType' | 'deliveryType' | 'format' | 'originalName'>, options: { download?: boolean; now?: number } = {}) => {
  const now = options.now ?? Date.now();
  const expiresAt = Math.floor(now / 1000) + SIGNED_URL_TTL_SECONDS;
  const url = cloudinary.utils.private_download_url(attachment.publicId, attachment.format ?? '', {
    resource_type: attachment.resourceType,
    type: attachment.deliveryType,
    expires_at: expiresAt,
    attachment: options.download ? true : undefined,
  });
  return { url, expiresAt: new Date(expiresAt * 1000).toISOString() };
};

/**
 * The attachment a user may open, or null (unknown, or not visible to them —
 * the caller answers 404 either way so ids cannot be probed). An unsent upload
 * is visible to its uploader only; a sent one to whoever may see its message.
 */
export const loadVisibleAttachment = async (userId: string, attachmentId: string) => {
  if (!UUID_RE.test(attachmentId)) return null;
  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    include: { message: { select: { id: true, channelId: true, createdAt: true } } },
  });
  if (!attachment) return null;
  // T.33: a task's file is visible to whoever may view the task (T.38: a
  // private assignment only to its assignee, creator and leads).
  if (attachment.taskId) {
    const task = await prisma.task.findUnique({ where: { id: attachment.taskId }, select: { projectId: true, assigneeOnly: true, assigneeId: true, creatorId: true } });
    if (!task) return null;
    try {
      return canTask(await loadProjectActor(userId, task.projectId), 'task.view', task) ? attachment : null;
    } catch {
      return null;
    }
  }
  if (!attachment.message) return attachment.uploaderId === userId ? attachment : null;
  const access = await getChannelAccess(userId, attachment.message.channelId);
  if (!access || !isMessageVisible(access, attachment.message)) return null;
  return attachment;
};

/** Destroys Cloudinary assets (best effort) and their rows. */
export const destroyAttachments = async (attachments: Pick<Attachment, 'id' | 'publicId' | 'resourceType' | 'deliveryType'>[]) => {
  let destroyed = 0;
  for (const a of attachments) {
    try {
      await cloudinary.uploader.destroy(a.publicId, { resource_type: a.resourceType, type: a.deliveryType, invalidate: true });
      destroyed += 1;
    } catch (err) {
      // Keep the row so the sweeper retries later.
      console.error('Could not delete a stored file:', err instanceof Error ? err.message : err);
      continue;
    }
    if (a.id) await prisma.attachment.delete({ where: { id: a.id } }).catch(() => undefined);
  }
  return destroyed;
};

/**
 * Called after messages are deleted: their private uploads (now detached by
 * the SetNull foreign key) are destroyed right away instead of waiting for
 * the sweeper. Legacy public URLs (pre-T.32) are destroyed too.
 */
export const destroyFilesOfDeletedMessages = async (messages: { id: string; fileUrl: string | null }[]) => {
  const ids = messages.map((m) => parseAttachmentPath(m.fileUrl)).filter((id): id is string => id !== null);
  if (ids.length > 0) {
    const rows = await prisma.attachment.findMany({ where: { id: { in: ids }, messageId: null } });
    await destroyAttachments(rows);
  }
  for (const m of messages) {
    const legacy = parseLegacyUploadUrl(m.fileUrl);
    if (!legacy) continue;
    // Only when no other message still points at the same legacy file.
    const stillUsed = await prisma.message.count({ where: { fileUrl: m.fileUrl } });
    if (stillUsed > 0) continue;
    await cloudinary.uploader.destroy(legacy.publicId, { resource_type: legacy.resourceType, type: legacy.deliveryType, invalidate: true }).catch(() => undefined);
  }
};

/** Destroys uploads that are attached to no message and no task (T.33) after the grace period. */
export const sweepOrphanAttachments = async (now = Date.now()) => {
  const orphans = await prisma.attachment.findMany({
    where: { messageId: null, taskId: null, createdAt: { lt: new Date(now - ORPHAN_GRACE_MS) } },
    take: 200,
  });
  return destroyAttachments(orphans);
};

let sweeper: NodeJS.Timeout | null = null;
/** Runs the orphan sweep shortly after start and every 6 hours (never blocks shutdown). */
export const startAttachmentSweeper = () => {
  if (sweeper || process.env.NODE_ENV === 'test') return;
  const run = () => sweepOrphanAttachments().catch((err) => console.error('Attachment sweep failed:', err instanceof Error ? err.message : err));
  setTimeout(run, 60_000).unref();
  sweeper = setInterval(run, 6 * 60 * 60 * 1000);
  sweeper.unref();
};

/**
 * Parses a pre-T.32 public delivery URL of this account's upload folder:
 * https://res.cloudinary.com/<cloud>/<resource>/upload/[v123/]workspace-uploads/<name>[.<fmt>]
 * Returns the public id as Cloudinary stores it (image/video ids exclude the
 * format suffix; raw ids include their extension).
 */
export const parseLegacyUploadUrl = (value: unknown): { publicId: string; resourceType: string; deliveryType: string } | null => {
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com') return null;
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  // [cloud, resourceType, deliveryType, (v123)?, folder, ...name]
  if (parts.length < 5 || parts[0] !== CLOUDINARY_CLOUD_NAME) return null;
  const [, resourceType, deliveryType] = parts;
  if (!['image', 'video', 'raw'].includes(resourceType) || deliveryType !== 'upload') return null;
  let rest = parts.slice(3);
  if (/^v\d+$/.test(rest[0] ?? '')) rest = rest.slice(1);
  if (rest[0] !== UPLOAD_FOLDER || rest.length < 2) return null;
  let publicId = rest.join('/');
  if (resourceType !== 'raw') publicId = publicId.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  return { publicId, resourceType, deliveryType };
};
