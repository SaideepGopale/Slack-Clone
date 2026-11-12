import { describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { addToWorkspace, createWorkspace } from './collab-helpers';
import { createAndLoginUser } from './helpers';
import { collect, emitAck, nextEvent, useSocketHarness } from './socket-harness';

/**
 * T.33 — message fan-out goes to the personal rooms of members verified in
 * the database (no per-message socket enumeration). Whatever a socket's room
 * subscriptions say, a person who is no longer allowed receives nothing:
 * removed from the channel, suspended, out of the workspace, or not in the
 * private project that owns the channel.
 */
const { connect } = useSocketHarness();

const setup = async () => {
  const owner = await createAndLoginUser();
  const { workspaceId, generalChannelId } = await createWorkspace(owner);
  const member = await createAndLoginUser();
  await addToWorkspace(member, workspaceId, [generalChannelId]);
  return { owner, member, workspaceId, generalChannelId };
};

const send = (socket: Awaited<ReturnType<typeof connect>>['socket'], channelId: string, content: string) =>
  emitAck(socket, 'message:send', { channelId, content });

describe('verified fan-out (T.33)', () => {
  it('members receive; a member removed behind the scenes (no revocation event) does not', async () => {
    const w = await setup();
    const owner = await connect(w.owner);
    const member = await connect(w.member);
    const first = nextEvent<{ content: string }>(member.socket, 'message:received', (m) => m.content.includes('one'));
    expect((await send(owner.socket, w.generalChannelId, 'one')).ok).toBe(true);
    await first;

    // Membership disappears without the normal revocation (still subscribed).
    await prisma.channelMember.deleteMany({ where: { channelId: w.generalChannelId, userId: w.member.user.id } });
    const leaked = collect<{ content: string }>(member.socket, 'message:received', 800);
    expect((await send(owner.socket, w.generalChannelId, 'two')).ok).toBe(true);
    expect((await leaked).map((m) => m.content)).toEqual([]);
  });

  it('suspended accounts and people outside the workspace receive nothing', async () => {
    const w = await setup();
    const owner = await connect(w.owner);
    const member = await connect(w.member);
    await prisma.user.update({ where: { id: w.member.user.id }, data: { status: 'SUSPENDED' } });
    const leaked = collect<{ content: string }>(member.socket, 'message:received', 800);
    expect((await send(owner.socket, w.generalChannelId, 'while suspended')).ok).toBe(true);
    expect(await leaked).toEqual([]);
    await prisma.user.update({ where: { id: w.member.user.id }, data: { status: 'ACTIVE' } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: w.workspaceId, userId: w.member.user.id } });
    const leaked2 = collect<{ content: string }>(member.socket, 'message:received', 800);
    expect((await send(owner.socket, w.generalChannelId, 'after removal')).ok).toBe(true);
    expect(await leaked2).toEqual([]);
  });

  it('a private project channel reaches project members only', async () => {
    const w = await setup();
    const project = await prisma.project.create({ data: { workspaceId: w.workspaceId, name: 'Secret', visibility: 'PRIVATE', members: { create: { userId: w.owner.user.id, role: 'OWNER' } } } });
    const channel = await prisma.channel.create({
      data: { name: 'secret-room', workspaceId: w.workspaceId, createdBy: w.owner.user.id, projectId: project.id, members: { create: [{ userId: w.owner.user.id, role: 'owner' }, { userId: w.member.user.id, role: 'member' }] } },
    });
    const owner = await connect(w.owner);
    const member = await connect(w.member); // a channel row, but no project membership
    const leaked = collect<{ content: string }>(member.socket, 'message:received', 800);
    const self = nextEvent<{ content: string }>(owner.socket, 'message:received', (m) => m.content.includes('classified'));
    expect((await send(owner.socket, channel.id, 'classified')).ok).toBe(true);
    await self;
    expect(await leaked).toEqual([]);
  });
});
