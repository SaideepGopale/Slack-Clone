import { describe, expect, it } from 'vitest';
import { parseVoiceMetadata } from '../modules/uploads/message.routes';
import { databaseUrlWithPool } from '../lib/prisma';
import { baseMimeType, contentMismatch, svgProblem } from '../lib/fileSignature';
import { canTask, isProjectLead, ProjectActor } from '../lib/policy';

/** T.33 — small pure pieces: pool sizing, voice metadata, content sniffing, task policy matrix. */
describe('database pool sizing (T.33)', () => {
  const url = 'postgresql://app:p%40ss@db.example.com:5432/main?sslmode=require';
  it('adds connection_limit / pool_timeout only when configured and not already in the URL', () => {
    expect(databaseUrlWithPool(url, {})).toBe(url);
    const sized = new URL(databaseUrlWithPool(url, { DATABASE_CONNECTION_LIMIT: '10', DATABASE_POOL_TIMEOUT: '15' })!);
    expect(sized.searchParams.get('connection_limit')).toBe('10');
    expect(sized.searchParams.get('pool_timeout')).toBe('15');
    expect(sized.searchParams.get('sslmode')).toBe('require');
    expect(sized.password).toBe('p%40ss'); // credentials untouched
    const explicit = `${url}&connection_limit=3`;
    expect(new URL(databaseUrlWithPool(explicit, { DATABASE_CONNECTION_LIMIT: '10' })!).searchParams.get('connection_limit')).toBe('3');
    expect(new URL(databaseUrlWithPool(url, { DATABASE_CONNECTION_LIMIT: 'lots' })!).searchParams.has('connection_limit')).toBe(false);
    expect(databaseUrlWithPool(undefined, { DATABASE_CONNECTION_LIMIT: '10' })).toBeUndefined();
  });
});

describe('voice metadata parsing (T.33)', () => {
  it('accepts sane values and drops anything else', () => {
    expect(parseVoiceMetadata({ durationMs: '1500', waveform: '0,50,100' })).toEqual({ durationMs: 1500, waveform: '0,50,100' });
    expect(parseVoiceMetadata({ durationMs: '1.5', waveform: '0,50,101' })).toEqual({ durationMs: null, waveform: null });
    expect(parseVoiceMetadata({ durationMs: '3600001' })).toEqual({ durationMs: null, waveform: null });
    expect(parseVoiceMetadata({ waveform: 'a,b' })).toEqual({ durationMs: null, waveform: null });
    expect(parseVoiceMetadata(undefined)).toEqual({ durationMs: null, waveform: null });
  });
});

describe('content sniffing (T.33)', () => {
  it('matches declared types by their first bytes and ignores codec parameters', () => {
    expect(baseMimeType('Audio/WebM; codecs=opus')).toBe('audio/webm');
    expect(contentMismatch('audio/webm;codecs=opus', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]))).toBeNull();
    expect(contentMismatch('image/gif', Buffer.from('GIF89a....'))).toBeNull();
    expect(contentMismatch('image/gif', Buffer.from('PNG?'))).toMatch(/does not match/);
    expect(contentMismatch('application/x-msdownload', Buffer.from('hello'))).toMatch(/not allowed/);
    expect(contentMismatch('image/png', Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toMatch(/Programs/); // ELF
  });
  it('refuses active SVG content in any letter case', () => {
    expect(svgProblem(Buffer.from('<svg><SCRIPT>x</SCRIPT></svg>'))).toMatch(/scripts/);
    expect(svgProblem(Buffer.from('<svg ONLOAD = "x"></svg>'))).toMatch(/scripts/);
    expect(svgProblem(Buffer.from('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'))).toBeNull();
  });
});

describe('task policy matrix (T.33)', () => {
  const actor = (projectRole: 'OWNER' | 'MEMBER' | null, workspaceRole: 'OWNER' | 'ADMIN' | 'MEMBER' | null = 'MEMBER', extra: Partial<ProjectActor> = {}): ProjectActor => ({
    userId: 'me',
    projectId: 'p',
    visibility: 'PUBLIC',
    archived: false,
    projectRole,
    workspace: { userId: 'me', workspaceId: 'w', organizationId: null, isDefaultWorkspace: false, channelCreationPolicy: 'MEMBERS', workspaceRole: workspaceRole as never, organizationRole: null },
    ...extra,
  });
  const mine = { creatorId: 'me', assigneeId: null };
  const theirs = { creatorId: 'other', assigneeId: 'other' };
  const assignedToMe = { creatorId: 'other', assigneeId: 'me' };

  it('leads manage everything; members only their own work; outsiders read public projects only', () => {
    const lead = actor('OWNER');
    const member = actor('MEMBER');
    const viewer = actor(null);
    expect(isProjectLead(lead)).toBe(true);
    expect(isProjectLead(actor(null, 'ADMIN'))).toBe(true);
    for (const action of ['task.update', 'task.changeStatus', 'task.assignOthers', 'task.delete'] as const) expect(canTask(lead, action, theirs)).toBe(true);
    expect(canTask(member, 'task.create')).toBe(true);
    expect(canTask(member, 'task.update', mine)).toBe(true);
    expect(canTask(member, 'task.update', theirs)).toBe(false);
    expect(canTask(member, 'task.changeStatus', assignedToMe)).toBe(true);
    expect(canTask(member, 'task.changeStatus', { creatorId: 'me', assigneeId: 'other' })).toBe(false);
    expect(canTask(member, 'task.assignOthers', mine)).toBe(false);
    expect(canTask(member, 'task.assignSelf', mine)).toBe(true);
    expect(canTask(member, 'task.assignSelf', theirs)).toBe(false);
    expect(canTask(member, 'task.delete', mine)).toBe(true);
    expect(canTask(member, 'task.delete', assignedToMe)).toBe(false);
    expect(canTask(viewer, 'task.view')).toBe(true);
    expect(canTask(viewer, 'task.create')).toBe(false);
    expect(canTask(viewer, 'task.update', { creatorId: 'me', assigneeId: 'me' })).toBe(false); // removed from the project
  });

  it('review rule, archive and private visibility', () => {
    expect(canTask(actor('MEMBER'), 'task.complete', assignedToMe, { requireReview: true })).toBe(false);
    expect(canTask(actor('OWNER'), 'task.complete', assignedToMe, { requireReview: true })).toBe(true);
    expect(canTask(actor('OWNER', 'MEMBER', { archived: true }), 'task.update', mine)).toBe(false);
    expect(canTask(actor('OWNER', 'MEMBER', { archived: true }), 'task.view')).toBe(true);
    expect(canTask(actor(null, 'MEMBER', { visibility: 'PRIVATE' }), 'task.view')).toBe(false);
    expect(canTask(actor(null, null), 'task.view')).toBe(false);
  });
});
