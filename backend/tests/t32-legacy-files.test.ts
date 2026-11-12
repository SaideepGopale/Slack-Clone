import { describe, expect, it, vi } from 'vitest';
import { privatizeLegacyFiles } from '../lib/legacyFiles';
import { prisma } from '../lib/prisma';
import { createWorkspace, seedMessage, trustedUploadUrl } from './collab-helpers';
import { createAndLoginUser } from './helpers';

/**
 * T.32 — audit H3 for existing data: files uploaded before T.32 are public
 * until converted. The conversion renames each to a random name with the
 * "authenticated" delivery type and points its message at an Attachment.
 * Cloudinary is a stub here (no network); nothing runs against real storage.
 */
const stubCloud = () => {
  const rename = vi.fn(async (_from: string, to: string, options: Record<string, unknown>) => ({
    public_id: to,
    resource_type: options.resource_type,
    format: options.resource_type === 'raw' ? undefined : 'png',
    bytes: 1234,
  }));
  return { cloud: { uploader: { rename } } as never, rename };
};

describe('T.32 H3 — converting pre-T.32 public files', () => {
  it('dry run reports and changes nothing; apply converts, and the message then uses a private attachment', async () => {
    const owner = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(owner);
    const name = `legacy-${Date.now()}.pdf`;
    const legacyUrl = trustedUploadUrl(name);
    const message = await seedMessage(generalChannelId, workspaceId, owner.user.id, 'old file', { fileUrl: legacyUrl, fileName: 'Old plan.pdf', fileType: 'application/pdf' });

    const { cloud, rename } = stubCloud();
    const dry = await privatizeLegacyFiles({ cloud });
    expect(dry.dryRun).toBe(true);
    expect(dry.convertible).toBeGreaterThanOrEqual(1);
    expect(rename).not.toHaveBeenCalled();
    expect((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).fileUrl).toBe(legacyUrl);

    const applied = await privatizeLegacyFiles({ apply: true, cloud });
    expect(applied.failed).toEqual([]);
    const call = rename.mock.calls.find(([from]) => from === `workspace-uploads/${name}`);
    expect(call).toBeDefined();
    expect(call![1]).toMatch(/^workspace-uploads\/[0-9a-f]{32}\.pdf$/);
    expect(call![2]).toMatchObject({ resource_type: 'raw', type: 'upload', to_type: 'authenticated' });

    const after = await prisma.message.findUniqueOrThrow({ where: { id: message.id }, include: { attachment: true } });
    expect(after.fileUrl).toBe(`/api/attachments/${after.attachment!.id}`);
    expect(after.attachment).toMatchObject({ deliveryType: 'authenticated', originalName: 'Old plan.pdf', uploaderId: owner.user.id });

    // Idempotent: converted messages no longer match.
    rename.mockClear();
    await privatizeLegacyFiles({ apply: true, cloud });
    expect(rename.mock.calls.some(([from]) => from === `workspace-uploads/${name}`)).toBe(false);
  });

  it('a legacy URL shared by several messages is reported and left alone', async () => {
    const owner = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(owner);
    const shared = trustedUploadUrl(`shared-${Date.now()}.pdf`);
    await seedMessage(generalChannelId, workspaceId, owner.user.id, 'a', { fileUrl: shared });
    await seedMessage(generalChannelId, workspaceId, owner.user.id, 'b', { fileUrl: shared });
    const { cloud, rename } = stubCloud();
    const report = await privatizeLegacyFiles({ apply: true, cloud });
    expect(report.skippedShared).toBeGreaterThanOrEqual(2);
    expect(rename.mock.calls.some(([from]) => shared.endsWith(from))).toBe(false);
    expect(await prisma.message.count({ where: { fileUrl: shared } })).toBe(2);
  });
});
