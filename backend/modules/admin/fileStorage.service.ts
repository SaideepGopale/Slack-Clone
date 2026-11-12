import { destroyAttachments, parseLegacyUploadUrl, UPLOAD_FOLDER } from '../../lib/attachments';
import { cloudinary } from '../../lib/cloudinary';
import { prisma } from '../../lib/prisma';

/**
 * Admin "File Storage" (T.32 rework, audit M11).
 *
 * Two kinds of stored files:
 *  - private attachments (uploads since T.32) — the Attachment table is the
 *    source of truth (who uploaded, which message), no storage API needed;
 *  - legacy public uploads (before T.32) — listed from Cloudinary, all pages
 *    (cursor), cross-referenced to messages by their exact delivery URL.
 *
 * Direct-message files are never listed by name or link and cannot be deleted
 * here, matching the message-moderation rule that DMs are out of the admin's
 * reach; the page only reports how many there are and their total size.
 * A storage API failure is reported as a warning, never as "0 files".
 */
export interface StoredFileInfo {
  /** Attachment id (private) or Cloudinary public id (legacy). */
  id: string;
  kind: 'private' | 'legacy-public';
  name: string;
  /** Legacy public files only (already public); private files have no URL. */
  url: string | null;
  mimeType: string | null;
  sizeBytes: number;
  modifiedAt: string;
  messageId: string | null;
  channelId: string | null;
  channelName: string | null;
  senderUsername: string | null;
}

export interface StoredFilesReport {
  files: StoredFileInfo[];
  directMessageFiles: { count: number; bytes: number };
  totals: { count: number; bytes: number };
  warnings: string[];
}

const RESOURCE_TYPES = ['image', 'video', 'raw'] as const;
const MAX_PRIVATE = 2000;
const MAX_LEGACY_PAGES = 10; // × 500 per resource type

interface CloudinaryResource {
  public_id: string;
  secure_url: string;
  bytes: number;
  created_at: string;
}

const listLegacyResources = async (warnings: string[]): Promise<CloudinaryResource[]> => {
  const all: CloudinaryResource[] = [];
  for (const resource_type of RESOURCE_TYPES) {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LEGACY_PAGES; page++) {
      try {
        const res = await cloudinary.api.resources({
          type: 'upload',
          resource_type,
          prefix: `${UPLOAD_FOLDER}/`,
          max_results: 500,
          ...(cursor ? { next_cursor: cursor } : {}),
        });
        all.push(...(res.resources as CloudinaryResource[]));
        cursor = res.next_cursor;
        if (!cursor) break;
      } catch (err) {
        console.error(`Failed to list Cloudinary ${resource_type} resources:`, err instanceof Error ? err.message : err);
        warnings.push(`Older public ${resource_type} files could not be listed (file storage did not respond). The list may be incomplete.`);
        break;
      }
      if (page === MAX_LEGACY_PAGES - 1 && cursor) warnings.push(`Only the first ${MAX_LEGACY_PAGES * 500} older public ${resource_type} files are shown.`);
    }
  }
  return all;
};

export const listStoredFiles = async (): Promise<StoredFilesReport> => {
  const warnings: string[] = [];

  const attachments = await prisma.attachment.findMany({
    orderBy: { size: 'desc' },
    take: MAX_PRIVATE,
    include: {
      message: { select: { id: true, channelId: true, channel: { select: { name: true, isDM: true } }, sender: { select: { username: true } } } },
    },
  });
  if (attachments.length === MAX_PRIVATE) warnings.push(`Only the ${MAX_PRIVATE} largest private files are shown.`);

  const dm = { count: 0, bytes: 0 };
  const files: StoredFileInfo[] = [];
  for (const a of attachments) {
    if (a.message?.channel.isDM) {
      dm.count += 1;
      dm.bytes += a.size;
      continue;
    }
    files.push({
      id: a.id,
      kind: 'private',
      name: a.originalName,
      url: null,
      mimeType: a.mimeType,
      sizeBytes: a.size,
      modifiedAt: a.createdAt.toISOString(),
      messageId: a.message?.id ?? null,
      channelId: a.message?.channelId ?? null,
      channelName: a.message?.channel.name ?? null,
      senderUsername: a.message?.sender.username ?? null,
    });
  }

  const legacy = await listLegacyResources(warnings);
  const messages = legacy.length
    ? await prisma.message.findMany({
        where: { fileUrl: { in: legacy.map((r) => r.secure_url) } },
        select: { id: true, fileUrl: true, fileName: true, channelId: true, channel: { select: { name: true, isDM: true } }, sender: { select: { username: true } } },
      })
    : [];
  const messageByUrl = new Map(messages.map((m) => [m.fileUrl!, m]));
  for (const r of legacy) {
    const message = messageByUrl.get(r.secure_url);
    if (message?.channel.isDM) {
      dm.count += 1;
      dm.bytes += r.bytes;
      continue;
    }
    files.push({
      id: r.public_id,
      kind: 'legacy-public',
      name: message?.fileName ?? r.public_id.split('/').pop() ?? r.public_id,
      url: r.secure_url,
      mimeType: null,
      sizeBytes: r.bytes,
      modifiedAt: r.created_at,
      messageId: message?.id ?? null,
      channelId: message?.channelId ?? null,
      channelName: message?.channel.name ?? null,
      senderUsername: message?.sender.username ?? null,
    });
  }

  files.sort((a, b) => b.sizeBytes - a.sizeBytes); // biggest first — a "reclaim space" tool
  const totals = files.reduce((t, f) => ({ count: t.count + 1, bytes: t.bytes + f.sizeBytes }), { count: dm.count, bytes: dm.bytes });
  return { files, directMessageFiles: dm, totals, warnings };
};

export type DeleteFileResult =
  | { status: 'not_found' }
  | { status: 'invalid' }
  | { status: 'forbidden' }
  | { status: 'storage_error' }
  | { status: 'deleted'; deletedMessages: { id: string; channelId: string }[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deletes one stored file and the message(s) that carry it. The database
 * change happens first; if the storage deletion then fails, the file stays
 * listed (private ones are also retried by the orphan sweeper).
 */
export const deleteStoredFile = async (id: string): Promise<DeleteFileResult> => {
  if (!id || typeof id !== 'string') return { status: 'invalid' };

  if (UUID_RE.test(id)) {
    const attachment = await prisma.attachment.findUnique({
      where: { id },
      include: { message: { select: { id: true, channelId: true, channel: { select: { isDM: true } } } } },
    });
    if (!attachment) return { status: 'not_found' };
    if (attachment.message?.channel.isDM) return { status: 'forbidden' };
    const deletedMessages = attachment.message ? [{ id: attachment.message.id, channelId: attachment.message.channelId }] : [];
    if (attachment.message) await prisma.message.delete({ where: { id: attachment.message.id } });
    const destroyed = await destroyAttachments([attachment]);
    if (destroyed === 0) return deletedMessages.length ? { status: 'deleted', deletedMessages } : { status: 'storage_error' };
    return { status: 'deleted', deletedMessages };
  }

  // Legacy public upload: only ids inside the upload folder.
  if (!id.startsWith(`${UPLOAD_FOLDER}/`) || id.includes('..')) return { status: 'invalid' };
  const candidates = await prisma.message.findMany({
    where: { fileUrl: { contains: id } },
    select: { id: true, channelId: true, fileUrl: true, channel: { select: { isDM: true } } },
  });
  // Exact match on the parsed public id (no substring false positives).
  const owners = candidates.filter((m) => parseLegacyUploadUrl(m.fileUrl)?.publicId === id);
  if (owners.some((m) => m.channel.isDM)) return { status: 'forbidden' };
  if (owners.length) await prisma.message.deleteMany({ where: { id: { in: owners.map((m) => m.id) } } });

  let destroyed = false;
  for (const resource_type of RESOURCE_TYPES) {
    const result = await cloudinary.uploader.destroy(id, { resource_type, type: 'upload', invalidate: true }).catch(() => null);
    if (result?.result === 'ok') {
      destroyed = true;
      break;
    }
  }
  if (!destroyed && owners.length === 0) return { status: 'not_found' };
  return { status: 'deleted', deletedMessages: owners.map((m) => ({ id: m.id, channelId: m.channelId })) };
};
