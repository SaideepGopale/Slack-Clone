import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { addToWorkspace, createWorkspace, TestUser } from './collab-helpers';
import { authHeader, createAndLoginUser } from './helpers';

/**
 * T.33 — command-palette search (GET /api/workspaces/:id/search/all): every
 * result type is limited to what the caller may open — no private channels
 * they are not in, no private projects or their tasks, no files from
 * conversations they are not part of, no e-mail addresses, nothing from
 * another workspace.
 */
const search = (user: TestUser, workspaceId: string, q: string) =>
  request(app).get(`/api/workspaces/${workspaceId}/search/all`).query({ q }).set(authHeader(user.token));

describe('workspace search (T.33)', () => {
  it('finds channels, people, projects, tasks and files the caller can open — and nothing else', async () => {
    const tag = `zq${Date.now().toString(36)}`;
    const lead = await createAndLoginUser();
    const { workspaceId, generalChannelId } = await createWorkspace(lead);
    const member = await createAndLoginUser();
    await addToWorkspace(member, workspaceId, [generalChannelId]);
    await prisma.user.update({ where: { id: member.user.id }, data: { username: `${tag}_member` } });

    // Visible to the member: a public channel, a public project + task, a file in #general.
    const publicChannel = await prisma.channel.create({ data: { name: `${tag}-public`, workspaceId, createdBy: lead.user.id } });
    const publicProject = await request(app).post(`/api/workspaces/${workspaceId}/projects`).set(authHeader(lead.token)).send({ name: `${tag} Public`, key: 'PUB' });
    const publicTask = await request(app).post(`/api/projects/${publicProject.body.id}/tasks`).set(authHeader(lead.token)).send({ title: `${tag} public task` });
    const message = await prisma.message.create({ data: { channelId: generalChannelId, workspaceId, senderId: lead.user.id, content: 'see file' } });
    await prisma.attachment.create({ data: { publicId: `x/${tag}1`, resourceType: 'raw', originalName: `${tag}-visible.pdf`, mimeType: 'application/pdf', size: 3, uploaderId: lead.user.id, messageId: message.id } });

    // Hidden from the member: a private channel they are not in, a private project and its task,
    // a file in a conversation they are not part of, and everything in another workspace.
    const secretChannel = await prisma.channel.create({ data: { name: `${tag}-secret`, workspaceId, createdBy: lead.user.id, visibility: 'PRIVATE', members: { create: { userId: lead.user.id, role: 'owner' } } } });
    const privateProject = await request(app).post(`/api/workspaces/${workspaceId}/projects`).set(authHeader(lead.token)).send({ name: `${tag} Private`, visibility: 'PRIVATE' });
    await request(app).post(`/api/projects/${privateProject.body.id}/tasks`).set(authHeader(lead.token)).send({ title: `${tag} private task` });
    const secretMessage = await prisma.message.create({ data: { channelId: secretChannel.id, workspaceId, senderId: lead.user.id, content: 'secret file' } });
    await prisma.attachment.create({ data: { publicId: `x/${tag}2`, resourceType: 'raw', originalName: `${tag}-hidden.pdf`, mimeType: 'application/pdf', size: 3, uploaderId: lead.user.id, messageId: secretMessage.id } });
    const otherLead = await createAndLoginUser();
    const other = await createWorkspace(otherLead);
    await prisma.channel.create({ data: { name: `${tag}-elsewhere`, workspaceId: other.workspaceId, createdBy: otherLead.user.id } });

    const res = await search(member, workspaceId, tag);
    expect(res.status).toBe(200);
    expect(res.body.channels.map((c: { id: string }) => c.id)).toEqual([publicChannel.id]);
    expect(res.body.projects.map((p: { id: string }) => p.id)).toEqual([publicProject.body.id]);
    expect(res.body.tasks.map((t: { id: string }) => t.id)).toEqual([publicTask.body.task.id]);
    expect(res.body.tasks[0]).toMatchObject({ identifier: 'PUB-1', project: { name: `${tag} Public` } });
    expect(res.body.files.map((f: { name: string }) => f.name)).toEqual([`${tag}-visible.pdf`]);
    expect(res.body.people).toEqual([{ id: member.user.id, username: `${tag}_member`, displayName: null, title: null }]);
    expect(JSON.stringify(res.body)).not.toContain('@example.com');

    // The lead sees their own private channel, project and file too.
    const leadRes = await search(lead, workspaceId, tag);
    expect(leadRes.body.channels.map((c: { name: string }) => c.name).sort()).toEqual([`${tag}-public`, `${tag}-secret`]);
    expect(leadRes.body.projects).toHaveLength(2);
    expect(leadRes.body.files).toHaveLength(2);
    // A task can be found by its identifier.
    expect((await search(lead, workspaceId, 'PUB-1')).body.tasks.map((t: { id: string }) => t.id)).toContain(publicTask.body.task.id);
  });

  it('refuses outsiders and bad queries', async () => {
    const lead = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(lead);
    const outsider = await createAndLoginUser();
    expect((await search(outsider, workspaceId, 'anything')).status).toBe(404);
    expect((await search(lead, workspaceId, 'a')).status).toBe(400);
    expect((await search(lead, workspaceId, 'x'.repeat(101))).status).toBe(400);
    expect((await search(lead, 'not-a-uuid', 'abc')).status).toBe(404);
    expect((await request(app).get(`/api/workspaces/${workspaceId}/search/all?q=abc`)).status).toBe(401);
  });
});
