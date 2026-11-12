import type { v2 as CloudinaryV2 } from 'cloudinary';
import { attachmentPath, parseLegacyUploadUrl, randomAssetName, safeExtension, UPLOAD_FOLDER } from './attachments';
import { cloudinary as defaultCloudinary } from './cloudinary';
import { prisma } from './prisma';

/**
 * Converts files uploaded before T.32 (public "upload"-type Cloudinary assets
 * with guessable names) into private attachments (audit H3, existing data).
 *
 * For each message whose fileUrl is a legacy public upload URL of this
 * account: the asset is renamed in Cloudinary to a random name AND switched to
 * the "authenticated" delivery type (Cloudinary `rename` with `to_type`), which
 * makes the old public URL stop working; an Attachment row is recorded and
 * the message is pointed at /api/attachments/<id>. Thereafter the file is only
 * reachable through short-lived signed links after the access check.
 *
 * Dry run by default (reports what it would do). A legacy URL attached to more
 * than one message is reported and skipped (an attachment belongs to one
 * message). Re-running is safe: converted messages no longer match.
 */
export interface LegacyConversionReport {
  scanned: number;
  convertible: number;
  converted: number;
  skippedShared: number;
  failed: { messageId: string; reason: string }[];
  dryRun: boolean;
}

type CloudinaryLike = Pick<typeof CloudinaryV2, 'uploader'>;

export const privatizeLegacyFiles = async (options: { apply?: boolean; limit?: number; cloud?: CloudinaryLike } = {}): Promise<LegacyConversionReport> => {
  const cloud = options.cloud ?? defaultCloudinary;
  const report: LegacyConversionReport = { scanned: 0, convertible: 0, converted: 0, skippedShared: 0, failed: [], dryRun: !options.apply };

  const messages = await prisma.message.findMany({
    where: { fileUrl: { startsWith: 'https://res.cloudinary.com/' } },
    select: { id: true, fileUrl: true, fileName: true, fileType: true, senderId: true },
    orderBy: { createdAt: 'asc' },
    take: options.limit ?? 1000,
  });
  report.scanned = messages.length;

  const byUrl = new Map<string, typeof messages>();
  for (const m of messages) {
    if (!parseLegacyUploadUrl(m.fileUrl)) continue;
    byUrl.set(m.fileUrl!, [...(byUrl.get(m.fileUrl!) ?? []), m]);
  }

  for (const [url, owners] of byUrl) {
    if (owners.length > 1) {
      report.skippedShared += owners.length;
      continue;
    }
    report.convertible += 1;
    if (!options.apply) continue;

    const [message] = owners;
    const legacy = parseLegacyUploadUrl(url)!;
    const ext = legacy.resourceType === 'raw' ? safeExtension(legacy.publicId) : '';
    const targetId = `${UPLOAD_FOLDER}/${randomAssetName()}${ext}`;
    try {
      const renamed = (await cloud.uploader.rename(legacy.publicId, targetId, {
        resource_type: legacy.resourceType,
        type: 'upload',
        to_type: 'authenticated',
        invalidate: true,
      })) as { public_id: string; resource_type: string; format?: string; bytes?: number };
      const attachment = await prisma.attachment.create({
        data: {
          publicId: renamed.public_id,
          resourceType: renamed.resource_type ?? legacy.resourceType,
          deliveryType: 'authenticated',
          format: legacy.resourceType === 'raw' ? null : renamed.format ?? null,
          originalName: message.fileName || 'attachment',
          mimeType: message.fileType || 'application/octet-stream',
          size: renamed.bytes ?? 0,
          uploaderId: message.senderId,
          messageId: message.id,
        },
      });
      await prisma.message.update({ where: { id: message.id }, data: { fileUrl: attachmentPath(attachment.id) } });
      report.converted += 1;
    } catch (err) {
      report.failed.push({ messageId: message.id, reason: err instanceof Error ? err.message : 'unknown error' });
    }
  }
  return report;
};
