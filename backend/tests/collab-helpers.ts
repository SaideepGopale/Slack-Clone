import request from 'supertest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { authHeader, createAndLoginUser } from './helpers';

export type TestUser = Awaited<ReturnType<typeof createAndLoginUser>>;

/**
 * Creates a private workspace owned by `owner`; returns its id and General channel id.
 * Stage 1: only Team Leads (and Company Admins) may create workspaces, so the
 * owner is made a Team Lead first — unless the test already gave them an
 * explicit tier, which is left alone (update: {}).
 */
export const createWorkspace = async (owner: TestUser, name = `WS ${Date.now()}-${Math.random()}`) => {
  // (Some suites pass admin-provisioned accounts cast to TestUser, which carry
  // `id` rather than `user.id`; those grant the tier themselves.)
  const ownerId = owner.user?.id;
  if (ownerId) await prisma.accountTierGrant.upsert({ where: { userId: ownerId }, update: {}, create: { userId: ownerId, tier: 'TEAM_LEAD' } });
  const res = await request(app).post('/api/workspaces').set(authHeader(owner.token)).send({ name });
  if (res.status !== 201) throw new Error(`createWorkspace failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { workspaceId: res.body.workspace.id as string, generalChannelId: res.body.generalChannel.id as string };
};

/**
 * T.21: public sign-up is invitation-only. A real pending e-mail invitation
 * for `email`, issued by the owner (a Team Lead) of one workspace shared by
 * the calling test file. Pass the token as `inviteToken` on sign-up.
 */
let inviter: Promise<{ ownerId: string; workspaceId: string }> | null = null;
export const invitationFor = async (email: string) => {
  inviter ??= (async () => {
    const owner = await createAndLoginUser();
    const { workspaceId } = await createWorkspace(owner); // makes the owner a Team Lead
    return { ownerId: owner.user.id, workspaceId };
  })();
  const { ownerId, workspaceId } = await inviter;
  return (await prisma.invitation.create({ data: { email: email.trim().toLowerCase(), inviterId: ownerId, workspaceId } })).token;
};

/** Adds `user` to the workspace (MEMBER) and, optionally, to channels — directly via Prisma. */
export const addToWorkspace = async (user: TestUser, workspaceId: string, channelIds: string[] = []) => {
  await prisma.workspaceMember.create({ data: { userId: user.user.id, workspaceId, role: 'MEMBER' } });
  for (const channelId of channelIds) {
    await prisma.channelMember.create({ data: { userId: user.user.id, channelId, role: 'member' } });
  }
};

/** Starts (or returns) a DM between `a` and `b` through the real REST endpoint. */
export const createDM = async (a: TestUser, b: TestUser, workspaceId?: string) => {
  const res = await request(app)
    .post('/api/channels/dm')
    .set(authHeader(a.token))
    .send({ targetUserId: b.user.id, workspaceId });
  if (res.status !== 200) throw new Error(`createDM failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string; otherUserId: string };
};

export const seedMessage = (channelId: string, workspaceId: string, senderId: string, content: string, extra: object = {}) =>
  prisma.message.create({ data: { channelId, workspaceId, senderId, content, ...extra } });

export const trustedUploadUrl = (name = 'file.pdf') =>
  `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/raw/upload/v1/workspace-uploads/${name}`;
