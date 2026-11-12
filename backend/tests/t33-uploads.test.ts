import { PassThrough } from 'stream';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T.33 — upload hardening and voice-note metadata:
 *  - content must match the declared type (magic bytes), text must be text,
 *    programs are refused whatever they claim to be, empty files too;
 *  - SVGs are read in full and refused if they contain active content;
 *  - nothing that fails a check reaches storage;
 *  - a voice note's duration and waveform are stored and returned with its
 *    signed link; invalid values are dropped;
 *  - files attached to tasks follow the project's visibility, are never
 *    swept as orphans and cannot be re-used in a message.
 * Cloudinary is replaced by an in-memory sink.
 */
const storage = vi.hoisted(() => ({ uploads: [] as { options: Record<string, unknown>; bytes: number }[], destroyed: [] as string[] }));

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
        callback(null, { public_id: publicId, resource_type: 'raw', type: options.type, bytes });
      });
      return sink;
    },
    destroy: vi.fn(async (publicId: string) => {
      storage.destroyed.push(publicId);
      return { result: 'ok' };
    }),
  };
  return { ...actual, v2: Object.assign(Object.create(v2), { config: v2.config, utils: v2.utils, uploader, api: v2.api }) };
});

import { app } from '../app';
import { ORPHAN_GRACE_MS, sweepOrphanAttachments } from '../lib/attachments';
import { prisma } from '../lib/prisma';
import { addToWorkspace, createWorkspace, TestUser } from './collab-helpers';
import { authHeader, createAndLoginUser } from './helpers';
import { emitAck, useSocketHarness } from './socket-harness';

const harness = useSocketHarness();

beforeEach(() => {
  storage.uploads.length = 0;
  storage.destroyed.length = 0;
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 0)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 2)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(32, 0)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0)]);

const upload = (user: TestUser, body: Buffer, filename: string, contentType: string, fields: Record<string, string> = {}) => {
  let req = request(app).post('/api/upload').set(authHeader(user.token));
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('attachment', body, { filename, contentType });
};

describe('upload content checks (T.33)', () => {
  it('accepts genuine files of each kind', async () => {
    const alice = await createAndLoginUser();
    const cases: [Buffer, string, string][] = [
      [PNG, 'a.png', 'image/png'],
      [PDF, 'a.pdf', 'application/pdf'],
      [ZIP, 'a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      [Buffer.from('name,qty\nwidget,2\n'), 'a.csv', 'text/csv'],
      [Buffer.from('héllo — notes ✓\n'), 'a.txt', 'text/plain'],
      [WEBM, 'v.webm', 'audio/webm;codecs=opus'],
      [MP4, 'v.m4a', 'audio/mp4'],
      [ZIP, 'odd.xlsx', 'application/octet-stream'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'), 'logo.svg', 'image/svg+xml'],
    ];
    for (const [body, name, type] of cases) {
      const res = await upload(alice, body, name, type);
      expect(res.status, `${name} (${type})`).toBe(200);
    }
    expect(storage.uploads).toHaveLength(cases.length);
  });

  it('refuses content that does not match its declared type — before anything is stored', async () => {
    const alice = await createAndLoginUser();
    const cases: [Buffer, string, string, RegExp][] = [
      [EXE, 'photo.png', 'image/png', /Programs and scripts/],
      [Buffer.from('#!/bin/sh\nrm -rf /\n'), 'notes.txt', 'text/plain', /Programs and scripts/],
      [Buffer.from('plain text pretending'), 'report.pdf', 'application/pdf', /does not match/],
      [PNG, 'a.webm', 'audio/webm', /does not match/],
      [Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]), 'a.txt', 'text/plain', /does not match/],
      [Buffer.from('random binary blob'), 'x.bin', 'application/octet-stream', /does not match/],
      [Buffer.alloc(0), 'empty.pdf', 'application/pdf', /empty/],
    ];
    for (const [body, name, type, reason] of cases) {
      const res = await upload(alice, body, name, type);
      expect(res.status, `${name} (${type})`).toBe(400);
      expect(res.body.message, name).toMatch(reason);
    }
    expect(storage.uploads).toHaveLength(0);
    expect(await prisma.attachment.count({ where: { uploaderId: alice.user.id } })).toBe(0);
  });

  it('refuses SVGs with scripts, event handlers, embedded content or entities, and oversized SVGs', async () => {
    const alice = await createAndLoginUser();
    const bad = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://x"/></foreignObject></svg>',
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
      'just text, not an svg',
    ];
    for (const svg of bad) expect((await upload(alice, Buffer.from(svg), 'x.svg', 'image/svg+xml')).status, svg).toBe(400);
    const huge = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${'<!-- padding -->'.repeat(140_000)}</svg>`);
    const res = await upload(alice, huge, 'big.svg', 'image/svg+xml');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/2 MB/);
    expect(storage.uploads).toHaveLength(0);
  });
});

describe('voice-note metadata (T.33)', () => {
  it('stores duration and waveform with an audio upload and returns them with the signed link', async () => {
    const alice = await createAndLoginUser();
    const waveform = Array.from({ length: 48 }, (_, i) => i * 2).join(',');
    const res = await upload(alice, WEBM, 'voice-message-1.webm', 'audio/webm;codecs=opus', { durationMs: '42500', waveform });
    expect(res.status).toBe(200);
    const link = await request(app).get(res.body.url).set(authHeader(alice.token));
    expect(link.status).toBe(200);
    expect(link.body).toMatchObject({ durationMs: 42500, waveform });
  });

  it('drops invalid metadata and never stores it for non-audio files', async () => {
    const alice = await createAndLoginUser();
    const bad = await upload(alice, WEBM, 'v.webm', 'audio/webm', { durationMs: '-5', waveform: '1,2,999' });
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: bad.body.id } })).durationMs).toBeNull();
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: bad.body.id } })).waveform).toBeNull();
    const tooLong = await upload(alice, WEBM, 'v.webm', 'audio/webm', { durationMs: '99999999', waveform: Array(65).fill('1').join(',') });
    expect(await prisma.attachment.findUniqueOrThrow({ where: { id: tooLong.body.id } })).toMatchObject({ durationMs: null, waveform: null });
    const pdf = await upload(alice, PDF, 'a.pdf', 'application/pdf', { durationMs: '1000', waveform: '1,2' });
    expect(await prisma.attachment.findUniqueOrThrow({ where: { id: pdf.body.id } })).toMatchObject({ durationMs: null, waveform: null });
  });
});

describe('task attachments (T.33)', () => {
  const setup = async (visibility: 'PUBLIC' | 'PRIVATE' = 'PRIVATE') => {
    const lead = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(lead);
    const viewer = await createAndLoginUser();
    await addToWorkspace(viewer, workspaceId, [generalChannelId]);
    const project = await request(app).post(`/api/workspaces/${workspaceId}/projects`).set(authHeader(lead.token)).send({ name: 'Ops', visibility });
    const task = await request(app).post(`/api/projects/${project.body.id}/tasks`).set(authHeader(lead.token)).send({ title: 'Runbook' });
    return { lead, viewer, workspaceId, generalChannelId, projectId: project.body.id as string, taskId: task.body.task.id as string };
  };

  it('a task file follows project visibility, cannot be sent in a message and is not swept while attached', async () => {
    const w = await setup('PRIVATE');
    const file = (await upload(w.lead, PDF, 'runbook.pdf', 'application/pdf')).body;
    const attached = await request(app).post(`/api/tasks/${w.taskId}/attachments`).set(authHeader(w.lead.token)).send({ attachmentId: file.id });
    expect(attached.status).toBe(201);
    expect(attached.body.attachments.map((a: { id: string }) => a.id)).toEqual([file.id]);
    // Binding is once only.
    expect((await request(app).post(`/api/tasks/${w.taskId}/attachments`).set(authHeader(w.lead.token)).send({ attachmentId: file.id })).status).toBe(409);
    // The lead (project member) gets a link; a workspace member outside the private project does not.
    expect((await request(app).get(file.url).set(authHeader(w.lead.token))).status).toBe(200);
    expect((await request(app).get(file.url).set(authHeader(w.viewer.token))).status).toBe(404);
    // It cannot be re-used as a chat attachment.
    const { socket } = await harness.connect(w.lead);
    const sent = await emitAck(socket, 'message:send', { channelId: w.generalChannelId, content: 'see file', fileUrl: file.url, fileName: 'runbook.pdf', fileType: 'application/pdf' });
    expect(sent.ok).toBe(false);
    // Past the orphan grace period it survives while attached…
    await prisma.attachment.update({ where: { id: file.id }, data: { createdAt: new Date(Date.now() - ORPHAN_GRACE_MS - 60_000) } });
    await sweepOrphanAttachments();
    expect(await prisma.attachment.count({ where: { id: file.id } })).toBe(1);
    // …and is swept once detached.
    expect((await request(app).delete(`/api/tasks/${w.taskId}/attachments/${file.id}`).set(authHeader(w.lead.token))).body.attachments).toEqual([]);
    await sweepOrphanAttachments();
    expect(await prisma.attachment.count({ where: { id: file.id } })).toBe(0);
  });

  it('only the uploader can attach their file, and only to a task they may edit', async () => {
    const w = await setup('PUBLIC');
    const file = (await upload(w.lead, PDF, 'plan.pdf', 'application/pdf')).body;
    // The viewer can see the public task but is not a project member.
    expect((await request(app).post(`/api/tasks/${w.taskId}/attachments`).set(authHeader(w.viewer.token)).send({ attachmentId: file.id })).status).toBe(403);
    const theirs = (await upload(w.viewer, PDF, 'theirs.pdf', 'application/pdf')).body;
    expect((await request(app).post(`/api/tasks/${w.taskId}/attachments`).set(authHeader(w.lead.token)).send({ attachmentId: theirs.id })).status).toBe(409);
  });
});
