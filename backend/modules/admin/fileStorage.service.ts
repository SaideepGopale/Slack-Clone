import { v2 as cloudinary } from 'cloudinary';
import { prisma } from '../../lib/prisma';

export interface StoredFileInfo {
  publicId: string;
  url: string;
  sizeBytes: number;
  modifiedAt: string;
  messageId: string | null;
  channelId: string | null;
  channelName: string | null;
  senderUsername: string | null;
}

// Must match upload.middleware.ts's CloudinaryStorage engine, which uploads
// everything under this folder.
const CLOUDINARY_FOLDER = 'workspace-uploads';

// Uploads go in with resource_type: 'auto' (see upload.middleware.ts), which
// Cloudinary internally routes into one of these three — but its Admin API
// only ever lists one resource_type per call, never all of them at once, so
// listing "everything in the folder" means asking three times and merging.
const RESOURCE_TYPES = ['image', 'video', 'raw'] as const;

interface CloudinaryResource {
  public_id: string;
  secure_url: string;
  bytes: number;
  created_at: string;
}

// Previously read from local disk (fs.readdir on the old multer diskStorage
// uploadDir) — stale ever since uploads moved to streaming straight into
// Cloudinary (upload.middleware.ts), which never touches local disk at all.
// That made this page always report 0 files regardless of what had actually
// been uploaded. Cloudinary's own Admin API is the real source of truth now.
export const listStoredFiles = async (): Promise<StoredFileInfo[]> => {
  const resourceLists = await Promise.all(
    RESOURCE_TYPES.map((resource_type) =>
      cloudinary.api
        .resources({
          type: 'upload',
          resource_type,
          prefix: `${CLOUDINARY_FOLDER}/`,
          max_results: 500,
        })
        .catch((err: unknown) => {
          console.error(`Failed to list Cloudinary ${resource_type} resources:`, err);
          return { resources: [] as CloudinaryResource[] };
        })
    )
  );

  const allResources = resourceLists.flatMap((r) => r.resources as CloudinaryResource[]);

  // Cross-reference with Message rows (matched by the exact secure_url
  // Cloudinary returned at upload time — see upload.middleware.ts) so the
  // admin can see which channel/sender a file belongs to, and so deleting it
  // can cascade to the message that references it.
  const urls = allResources.map((r) => r.secure_url);
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

  return allResources
    .map((r) => {
      const message = messageByUrl.get(r.secure_url);
      return {
        publicId: r.public_id,
        url: r.secure_url,
        sizeBytes: r.bytes,
        modifiedAt: r.created_at,
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

export const deleteStoredFile = async (publicId: string): Promise<DeleteFileResult> => {
  // publicId only ever comes from what listStoredFiles itself returned
  // (real Cloudinary ids, always prefixed with our upload folder) — reject
  // anything that doesn't look like one rather than handing an arbitrary
  // string straight to Cloudinary's destroy API.
  if (!publicId || typeof publicId !== 'string' || !publicId.startsWith(`${CLOUDINARY_FOLDER}/`)) {
    return { status: 'invalid' };
  }

  // destroy() needs the correct resource_type or it reports "not found" even
  // for a real asset — try each until one actually deletes something.
  let deleted = false;
  for (const resource_type of RESOURCE_TYPES) {
    const result = await cloudinary.uploader.destroy(publicId, { resource_type }).catch(() => null);
    if (result?.result === 'ok') {
      deleted = true;
      break;
    }
  }
  if (!deleted) {
    return { status: 'not_found' };
  }

  // The delivery URL embeds the public_id verbatim (see buildPublicId in
  // upload.middleware.ts), so a substring match reliably finds the message
  // that referenced this exact upload without needing to reconstruct the
  // full secure_url (which would require knowing the resource_type/format
  // Cloudinary picked, not just the public_id).
  const message = await prisma.message.findFirst({ where: { fileUrl: { contains: publicId } } });

  if (message) {
    // A file exposed through this tool that's still attached to a message
    // gets the whole message removed too — leaving it behind with a dead
    // fileUrl would just turn "reclaim storage" into "show everyone a
    // broken attachment forever."
    await prisma.message.delete({ where: { id: message.id } });
    return { status: 'deleted', channelId: message.channelId, messageId: message.id };
  }

  return { status: 'deleted', channelId: null, messageId: null };
};
