import { PassThrough } from 'stream';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T.32 — audit H3 (public, guessable file URLs; no authorized download),
 * M9 (uploads not bound to an uploader), M10 (files never deleted) and M11
 * (admin File Storage). Cloudinary is replaced by an in-memory stub; URL
 * signing (utils) stays the real SDK code.
 */
const storage = vi.hoisted(() => ({
  uploads: [] as { options: Record<string, unknown>; bytes: number }[],
  destroyed: [] as { publicId: string; options: Record<string, unknown> }[],
  legacy: [] as { public_id: string; secure_url: string; bytes: number; created_at: string }[],
}));

vi.mock('cloudinary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cloudinary')>();
  const v2 = actual.v2;
  const uploader = {
    upload_stream: (options: Record<string, unknown>, callback: (err: unknown, result?: Record<string, unknown>) => void) => {
      const sink = new PassThrough();
      let bytes = 0;
      sink.on('data', (chunk: Buffer) => (bytes += chunk.length));
      sink.on('end', () => {
        storage.uploads.push({ options, bytes });
        const publicId = `${options.folder}/${options.public_id}`;
        const raw = /\.[a-z0-9]+$/.test(String(options.public_id));
        callback(null, { public_id: publicId, resource_type: raw ? 'raw' : 'image', type: options.type, format: raw ? undefined : 'png', bytes, secure_url: `https://res.cloudinary.com/x/${publicId}` });
      });
      return sink;
    },
    destroy: vi.fn(async (publicId: string, options: Record<string, unknown>) => {
      storage.destroyed.push({ publicId, options });
      return { result: 'ok' };
    }),
  };
  const api = {
    resources: vi.fn(async (options: { resource_type: string }) => ({
      resources: options.resource_type === 'raw' ? storage.legacy : [],
    })),
  };
  return { ...actual, v2: Object.assign(Object.create(v2), { config: v2.config, utils: v2.utils, uploader, api }) };
});

import { app } from '../app';
import { parseLegacyUploadUrl, signedAttachmentUrl, sweepOrphanAttachments, ORPHAN_GRACE_MS } from '../lib/attachments';
import { prisma } from '../lib/prisma';
import { addToWorkspace, createDM, createWorkspace, TestUser, trustedUploadUrl } from './collab-helpers';
import { authHeader, createAndLoginUser } from './helpers';
import { emitAck, useSocketHarness } from './socket-harness';

const harness = useSocketHarness();

beforeEach(() => {
  storage.uploads.length = 0;
  storage.destroyed.length = 0;
  storage.legacy.length = 0;
});

// T.33: uploads must now be genuine files of their declared type (magic
// bytes are checked), so the fixture starts with a real header for its type.
const HEADERS: Record<string, Buffer> = {
  'application/pdf': Buffer.from('%PDF-1.7\n'),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};
const upload = (user: TestUser, name = 'Quarterly plan.pdf', type = 'application/pdf', body = 'file-bytes') =>
  request(app)
    .post('/api/upload')
    .set(authHeader(user.token))
    .attach('attachment', Buffer.concat([HEADERS[type] ?? Buffer.alloc(0), Buffer.from(body)]), { filename: name, contentType: type });

const link = (user: TestUser, path: string) => request(app).get(path).set(authHeader(user.token));

const send = async (user: TestUser, channelId: string, fileUrl: string, extra: object = {}) => {
  const { socket } = await harness.connect(user);
  return emitAck(socket, 'message:send', { channelId, content: '<p>see attached</p>', fileUrl, fileName: 'claimed.exe', fileType: 'application/x-msdownload', clientId: `att-${Math.random().toString(36).slice(2, 12)}`, ...extra });
};

describe('T.32 H3 — private uploads', () => {
  it('stores uploads as authenticated assets under a random id and returns an app path, not a storage URL', async () => {
    const alice = await createAndLoginUser();
    const res = await upload(alice);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, name: 'Quarterly plan.pdf', type: 'application/pdf' });
    expect(res.body.url).toBe(`/api/attachments/${res.body.id}`);
    expect(JSON.stringify(res.body)).not.toContain('cloudinary');

    const { options } = storage.uploads[0];
    expect(options.type).toBe('authenticated');
    expect(String(options.public_id)).toMatch(/^[0-9a-f]{32}\.pdf$/); // 128 random bits, no filename, no timestamp
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ uploaderId: alice.user.id, messageId: null, deliveryType: 'authenticated', originalName: 'Quarterly plan.pdf' });
  });

  it('an unsent upload can be opened by its uploader only; links are short-lived and signed', async () => {
    const alice = await createAndLoginUser();
    const mallory = await createAndLoginUser();
    const { body } = await upload(alice);

    const own = await link(alice, body.url);
    expect(own.status).toBe(200);
    expect(own.headers['cache-control']).toContain('no-store');
    const signed = new URL(own.body.url);
    expect(signed.hostname).toBe('api.cloudinary.com');
    expect(signed.searchParams.get('type')).toBe('authenticated');
    expect(signed.searchParams.get('signature')).toBeTruthy();
    const ttl = Number(signed.searchParams.get('expires_at')) - Date.now() / 1000;
    expect(ttl).toBeGreaterThan(500);
    expect(ttl).toBeLessThanOrEqual(600);

    expect((await link(mallory, body.url)).status).toBe(404);
    expect((await request(app).get(body.url)).status).toBe(401);
    expect((await link(alice, '/api/attachments/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it('once sent, the file is visible to members of that conversation only; its stored name and type win over the client\'s', async () => {
    const alice = await createAndLoginUser();
    const bob = await createAndLoginUser();
    const outsider = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(alice);
    await addToWorkspace(bob, workspaceId, [generalChannelId]);
    await addToWorkspace(outsider, workspaceId, []); // same workspace, not in the channel

    const { body } = await upload(alice);
    const ack = await send(alice, generalChannelId, body.url);
    expect(ack.ok).toBe(true);
    expect(ack.message).toMatchObject({ fileUrl: body.url, fileName: 'Quarterly plan.pdf', fileType: 'application/pdf' });
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: body.id } })).messageId).toBe(ack.message!.id);

    expect((await link(bob, body.url)).status).toBe(200);
    expect((await link(outsider, body.url)).status).toBe(404);

    // A DM file is visible to the two participants only.
    const dm = await createDM(alice, bob, workspaceId);
    const dmFile = (await upload(alice, 'private.png', 'image/png')).body;
    expect((await send(alice, dm.id, dmFile.url)).ok).toBe(true);
    expect((await link(bob, dmFile.url)).status).toBe(200);
    expect((await link(outsider, dmFile.url)).status).toBe(404);
  });

  it('only the uploader can attach an upload, and only once', async () => {
    const alice = await createAndLoginUser();
    const bob = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(alice);
    await addToWorkspace(bob, workspaceId, [generalChannelId]);
    const { body } = await upload(alice);

    const stolen = await send(bob, generalChannelId, body.url);
    expect(stolen).toMatchObject({ ok: false });
    expect(stolen.error).toMatch(/no longer available/i);

    expect((await send(alice, generalChannelId, body.url)).ok).toBe(true);
    const again = await send(alice, generalChannelId, body.url);
    expect(again).toMatchObject({ ok: false });
    expect(await prisma.message.count({ where: { fileUrl: body.url } })).toBe(1);
  });

  it('deleting a message destroys its stored file (and its thread replies\' files)', async () => {
    const alice = await createAndLoginUser();
    const { generalChannelId } = await createWorkspace(alice);
    const parentFile = (await upload(alice)).body;
    const parent = await send(alice, generalChannelId, parentFile.url);
    const replyFile = (await upload(alice, 'reply.txt', 'text/plain')).body;
    expect((await send(alice, generalChannelId, replyFile.url, { parentId: parent.message!.id })).ok).toBe(true);

    const { socket } = await harness.connect(alice);
    expect((await emitAck(socket, 'message:delete', { id: parent.message!.id })).ok).toBe(true);
    await vi.waitFor(() => expect(storage.destroyed.map((d) => d.publicId).length).toBe(2));
    for (const d of storage.destroyed) expect(d.options).toMatchObject({ type: 'authenticated', invalidate: true });
    expect(await prisma.attachment.count({ where: { id: { in: [parentFile.id, replyFile.id] } } })).toBe(0);
  });

  it('the sweeper destroys uploads never sent after the grace period, and keeps recent ones', async () => {
    const alice = await createAndLoginUser();
    const stale = (await upload(alice)).body;
    const fresh = (await upload(alice)).body;
    await prisma.attachment.update({ where: { id: stale.id }, data: { createdAt: new Date(Date.now() - ORPHAN_GRACE_MS - 60_000) } });
    await sweepOrphanAttachments();
    expect(await prisma.attachment.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await prisma.attachment.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });

  it('messages sent before T.32 with public upload URLs keep working', async () => {
    const alice = await createAndLoginUser();
    const { generalChannelId } = await createWorkspace(alice);
    expect((await send(alice, generalChannelId, trustedUploadUrl('old.pdf'))).ok).toBe(true);
    expect((await send(alice, generalChannelId, 'https://evil.example/x.pdf')).ok).toBe(false);
  });
});

describe('T.32 M11 — admin File Storage', () => {
  it('lists private files with their message, counts DM files without exposing them, and deletes exactly', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const alice = await createAndLoginUser();
    const bob = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(alice);
    await addToWorkspace(bob, workspaceId, [generalChannelId]);
    const shared = (await upload(alice, 'roadmap.pdf')).body;
    const sent = await send(alice, generalChannelId, shared.url);
    const dm = await createDM(alice, bob, workspaceId);
    const secret = (await upload(alice, 'secret.pdf')).body;
    expect((await send(alice, dm.id, secret.url)).ok).toBe(true);

    const list = await request(app).get('/api/admin/files').set(authHeader(admin.token));
    expect(list.status).toBe(200);
    const mine = list.body.files.find((f: { id: string }) => f.id === shared.id);
    expect(mine).toMatchObject({ kind: 'private', name: 'roadmap.pdf', url: null, messageId: sent.message!.id });
    expect(JSON.stringify(list.body.files)).not.toContain('secret.pdf');
    expect(list.body.directMessageFiles.count).toBeGreaterThanOrEqual(1);
    expect(list.body.warnings).toEqual([]);

    expect((await request(app).delete(`/api/admin/files/${secret.id}`).set(authHeader(admin.token))).status).toBe(403);
    const del = await request(app).delete(`/api/admin/files/${shared.id}`).set(authHeader(admin.token));
    expect(del.status).toBe(200);
    expect(del.body.deletedMessages).toBe(1);
    expect(await prisma.message.findUnique({ where: { id: sent.message!.id } })).toBeNull();
    expect(storage.destroyed.some((d) => d.publicId.endsWith('.pdf'))).toBe(true);
  });

  it('reports a storage listing failure as a warning instead of an empty list', async () => {
    const admin = await createAndLoginUser({ role: 'ADMIN' });
    const { v2 } = await import('cloudinary');
    vi.mocked(v2.api.resources).mockRejectedValueOnce(new Error('timeout'));
    const list = await request(app).get('/api/admin/files').set(authHeader(admin.token));
    expect(list.status).toBe(200);
    expect(list.body.warnings.length).toBeGreaterThan(0);
  });
});

describe('T.32 — attachment helpers', () => {
  it('signs expiring download links for authenticated assets', () => {
    const now = Date.UTC(2026, 10, 11, 12, 0, 0);
    const { url, expiresAt } = signedAttachmentUrl({ publicId: 'workspace-uploads/abc', resourceType: 'image', deliveryType: 'authenticated', format: 'png', originalName: 'a.png' }, { now, download: true });
    const u = new URL(url);
    expect(u.pathname).toContain('/image/download');
    expect(u.searchParams.get('attachment')).toBe('true');
    expect(u.searchParams.get('expires_at')).toBe(String(now / 1000 + 600));
    expect(expiresAt).toBe(new Date(now + 600_000).toISOString());
  });

  it('parses legacy public upload URLs exactly', () => {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME;
    expect(parseLegacyUploadUrl(`https://res.cloudinary.com/${cloud}/image/upload/v17/workspace-uploads/photo-1.png`)).toEqual({ publicId: 'workspace-uploads/photo-1', resourceType: 'image', deliveryType: 'upload' });
    expect(parseLegacyUploadUrl(`https://res.cloudinary.com/${cloud}/raw/upload/workspace-uploads/notes-2.txt`)).toEqual({ publicId: 'workspace-uploads/notes-2.txt', resourceType: 'raw', deliveryType: 'upload' });
    expect(parseLegacyUploadUrl('https://res.cloudinary.com/other-cloud/image/upload/workspace-uploads/x.png')).toBeNull();
    expect(parseLegacyUploadUrl('/api/attachments/00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
