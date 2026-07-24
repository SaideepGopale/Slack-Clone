import fs from 'fs';
import path from 'path';
import { prisma } from '../../lib/prisma';
import { uploadDir } from '../uploads/storage.service';

export interface StoredFileInfo {
  filename: string;
  url: string;
  sizeBytes: number;
  modifiedAt: string;
  messageId: string | null;
  channelId: string | null;
  channelName: string | null;
  senderUsername: string | null;
}

// Reads straight from disk rather than a `fileSize` DB column — uploads
// never persisted a size (see uploads.routes.ts), and stat-ing the real file
// is simpler and can't drift from reality the way a cached column could.
export const listStoredFiles = async (): Promise<StoredFileInfo[]> => {
  const filenames = await fs.promises.readdir(uploadDir);

  const fileStats = await Promise.all(
    filenames.map(async (filename) => {
      const fullPath = path.join(uploadDir, filename);
      const stat = await fs.promises.stat(fullPath);
      if (!stat.isFile()) return null;
      return { filename, sizeBytes: stat.size, modifiedAt: stat.mtime };
    })
  );
  const validFiles = fileStats.filter((f): f is NonNullable<typeof f> => f !== null);

  // Cross-reference with Message rows (matched by the exact /uploads/<file>
  // URL multer generates — see uploads.routes.ts) so the admin can see which
  // channel/sender a file belongs to, and so deleting it can cascade to the
  // message that references it.
  const urls = validFiles.map((f) => `/uploads/${f.filename}`);
  const messages = await prisma.message.findMany({
    where: { fileUrl: { in: urls } },
    select: {
      id: true,
      fileUrl: true,
      channelId: true,
      channel: { select: { name: true } },
      sender: { select: { username: true } },
    },
  });
  const messageByUrl = new Map(messages.map((m) => [m.fileUrl!, m]));

  return validFiles
    .map((f) => {
      const url = `/uploads/${f.filename}`;
      const message = messageByUrl.get(url);
      return {
        filename: f.filename,
        url,
        sizeBytes: f.sizeBytes,
        modifiedAt: f.modifiedAt.toISOString(),
        messageId: message?.id ?? null,
        channelId: message?.channelId ?? null,
        channelName: message?.channel.name ?? null,
        senderUsername: message?.sender.username ?? null,
      };
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes); // biggest first — this is a "reclaim space" tool
};

export type DeleteFileResult =
  | { status: 'not_found' }
  | { status: 'invalid' }
  | { status: 'deleted'; channelId: string | null; messageId: string | null };

export const deleteStoredFile = async (rawFilename: string): Promise<DeleteFileResult> => {
  // path.basename strips any directory components — if the sanitized name
  // doesn't match the raw input, the caller tried a path-traversal filename
  // (e.g. "../../../etc/passwd"); reject rather than silently "fix" it.
  const filename = path.basename(rawFilename);
  if (!filename || filename !== rawFilename) {
    return { status: 'invalid' };
  }

  const fullPath = path.join(uploadDir, filename);
  if (!fs.existsSync(fullPath)) {
    return { status: 'not_found' };
  }

  const url = `/uploads/${filename}`;
  const message = await prisma.message.findFirst({ where: { fileUrl: url } });

  await fs.promises.unlink(fullPath);

  if (message) {
    // A file exposed through this tool that's still attached to a message
    // gets the whole message removed too — leaving it behind with a dead
    // fileUrl would just turn "reclaim disk space" into "show everyone a
    // broken attachment forever."
    await prisma.message.delete({ where: { id: message.id } });
    return { status: 'deleted', channelId: message.channelId, messageId: message.id };
  }

  return { status: 'deleted', channelId: null, messageId: null };
};
