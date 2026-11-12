import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../app';
import { prisma } from '../lib/prisma';
import { addToWorkspace, createWorkspace, invitationFor, TestUser } from './collab-helpers';
import { authHeader, createAndLoginUser, uniqueEmail, uniqueUsername } from './helpers';

/**
 * P1-D — FA-SEC-03: other people's e-mail addresses are management data.
 * Every directory endpoint returns them only to the people who manage those
 * members — workspace OWNER/ADMIN (and organization OWNER/ADMIN, by
 * inheritance) in workspace directories; explicit organization OWNER/ADMIN in
 * the organization directory — and to the member themselves. Everyone else,
 * including a brand-new account in the Default Workspace/Organization, gets
 * names only and cannot search by e-mail. Real app, disposable test database.
 *
 *   GET /api/workspaces/:workspaceId/members            (list + ?q= search)
 *   GET /api/workspaces/:workspaceId/members/:userId    (profile)
 *   GET /api/organizations/:organizationId/members      (list + ?q= search)
 *   GET /api/channels/:channelId/addable-members        (add-member picker)
 */

type Viewer = { token: string };
const get = (viewer: Viewer, path: string) => request(app).get(path).set(authHeader(viewer.token));

/** A workspace with an owner, an admin and two ordinary members, all in General. */
const setup = async () => {
  const owner = await createAndLoginUser();
  const [admin, member, colleague] = [await createAndLoginUser(), await createAndLoginUser(), await createAndLoginUser()];
  const { workspaceId, generalChannelId } = await createWorkspace(owner);
  for (const u of [admin, member, colleague]) await addToWorkspace(u, workspaceId, [generalChannelId]);
  await prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: admin.user.id, workspaceId } }, data: { role: 'ADMIN' } });
  const { organizationId } = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { organizationId: true } });
  return { owner, admin, member, colleague, everyone: [owner, admin, member, colleague], workspaceId, generalChannelId, organizationId: organizationId! };
};

/** Registers through the real signup endpoint, exactly like a new user. */
const register = async () => {
  const email = uniqueEmail();
  const inviteToken = await invitationFor(email); // T.21: sign-up is invitation-only
  const res = await request(app).post('/api/auth/signup').send({ username: uniqueUsername(), email, password: 'Password123!', inviteToken });
  expect(res.status).toBe(201);
  return { user: res.body.user as { id: string; email: string }, token: res.body.token as string };
};

type Listed = { id: string; email?: string };

/** No one's e-mail but `self`'s appears anywhere in the response — not just under an `email` key. */
const expectOnlyOwnEmail = (body: unknown, self: { id: string; email: string } | null, others: TestUser[]) => {
  const text = JSON.stringify(body);
  for (const other of others) if (other.user.id !== self?.id) expect(text).not.toContain(other.user.email);
};

const expectEmailsFor = (rows: Listed[], users: TestUser[]) => {
  for (const u of users) expect(rows.find((r) => r.id === u.user.id)?.email, u.user.username).toBe(u.user.email);
};

describe('workspace member directory (FA-SEC-03)', () => {
  it('an ordinary member gets every name but no one else’s e-mail — only their own', async () => {
    const w = await setup();
    const res = await get(w.member, `/api/workspaces/${w.workspaceId}/members`);
    expect(res.status).toBe(200);
    const rows: Listed[] = res.body.members;
    expect(rows.map((r) => r.id).sort()).toEqual(w.everyone.map((u) => u.user.id).sort());
    for (const row of rows) {
      if (row.id === w.member.user.id) expect(row.email).toBe(w.member.user.email);
      else expect(row).not.toHaveProperty('email');
    }
    expectOnlyOwnEmail(res.body, w.member.user, w.everyone);
  });

  it('an ordinary member cannot search by e-mail (no existence oracle); name search still works', async () => {
    const w = await setup();
    for (const q of [w.colleague.user.email, w.colleague.user.email.split('@')[0], 'example.com']) {
      const res = await get(w.member, `/api/workspaces/${w.workspaceId}/members?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      expect(res.body.members, q).toEqual([]);
    }
    const byName = await get(w.member, `/api/workspaces/${w.workspaceId}/members?q=${w.colleague.user.username}`);
    expect(byName.body.members.map((r: Listed) => r.id)).toEqual([w.colleague.user.id]);
    expect(byName.body.members[0]).not.toHaveProperty('email');
  });

  it('workspace owners and admins still see e-mails and can search by e-mail', async () => {
    const w = await setup();
    for (const manager of [w.owner, w.admin]) {
      const res = await get(manager, `/api/workspaces/${w.workspaceId}/members`);
      expect(res.status).toBe(200);
      expectEmailsFor(res.body.members, w.everyone);
      const found = await get(manager, `/api/workspaces/${w.workspaceId}/members?q=${encodeURIComponent(w.colleague.user.email)}`);
      expect(found.body.members.map((r: Listed) => r.id)).toEqual([w.colleague.user.id]);
    }
  });

  it('organization managers who manage the workspace without belonging to it see e-mails', async () => {
    const w = await setup();
    const orgAdmin = await createAndLoginUser();
    await prisma.organizationMember.create({ data: { organizationId: w.organizationId, userId: orgAdmin.user.id, role: 'ADMIN' } });
    const res = await get(orgAdmin, `/api/workspaces/${w.workspaceId}/members`);
    expect(res.status).toBe(200);
    expectEmailsFor(res.body.members, w.everyone);
  });

  it('pagination still works and stays e-mail-free for ordinary members', async () => {
    const w = await setup();
    const first = await get(w.member, `/api/workspaces/${w.workspaceId}/members?limit=2`);
    const second = await get(w.member, `/api/workspaces/${w.workspaceId}/members?limit=2&cursor=${first.body.nextCursor}`);
    const ids = [...first.body.members, ...second.body.members].map((r: Listed) => r.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids.sort()).toEqual(w.everyone.map((u) => u.user.id).sort());
    expectOnlyOwnEmail([first.body, second.body], w.member.user, w.everyone);
  });
});

describe('member profile (FA-SEC-03)', () => {
  it('an ordinary member sees someone else’s profile without the e-mail, and their own with it', async () => {
    const w = await setup();
    const other = await get(w.member, `/api/workspaces/${w.workspaceId}/members/${w.colleague.user.id}`);
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ id: w.colleague.user.id, username: w.colleague.user.username, role: 'MEMBER' });
    expect(other.body).not.toHaveProperty('email');
    expectOnlyOwnEmail(other.body, w.member.user, w.everyone);

    const own = await get(w.member, `/api/workspaces/${w.workspaceId}/members/${w.member.user.id}`);
    expect(own.body.email).toBe(w.member.user.email);
  });

  it('owners and admins see the e-mail on profiles', async () => {
    const w = await setup();
    for (const manager of [w.owner, w.admin]) {
      const res = await get(manager, `/api/workspaces/${w.workspaceId}/members/${w.colleague.user.id}`);
      expect(res.body.email).toBe(w.colleague.user.email);
    }
  });
});

describe('organization directory (FA-SEC-03)', () => {
  it('members get names only and no e-mail search; organization owners and admins get e-mails', async () => {
    const w = await setup();
    const path = `/api/organizations/${w.organizationId}/members`;
    const plain = await get(w.member, path);
    expect(plain.status).toBe(200);
    expect(plain.body.members.map((r: Listed) => r.id).sort()).toEqual(w.everyone.map((u) => u.user.id).sort());
    expectOnlyOwnEmail(plain.body, w.member.user, w.everyone);
    expect((await get(w.member, `${path}?q=${encodeURIComponent(w.colleague.user.email)}`)).body.members).toEqual([]);

    const orgAdmin = await createAndLoginUser();
    await prisma.organizationMember.create({ data: { organizationId: w.organizationId, userId: orgAdmin.user.id, role: 'ADMIN' } });
    for (const manager of [w.owner, orgAdmin]) {
      const res = await get(manager, path);
      expectEmailsFor(res.body.members, w.everyone);
      const found = await get(manager, `${path}?q=${encodeURIComponent(w.colleague.user.email)}`);
      expect(found.body.members.map((r: Listed) => r.id)).toEqual([w.colleague.user.id]);
    }
  });
});

describe('channel add-member picker (FA-SEC-03)', () => {
  it('ordinary channel members get names only; workspace managers also get e-mails', async () => {
    const w = await setup();
    const created = await request(app).post('/api/channels').set(authHeader(w.member.token)).send({ workspaceId: w.workspaceId, name: `public-${Date.now()}` });
    expect(created.status).toBe(201);
    const path = `/api/channels/${created.body.id}/addable-members`;

    const asMember = await get(w.member, path);
    expect(asMember.status).toBe(200);
    expect(asMember.body.map((r: Listed) => r.id).sort()).toEqual([w.owner, w.admin, w.colleague].map((u) => u.user.id).sort());
    for (const row of asMember.body) expect(row).not.toHaveProperty('email');
    expectOnlyOwnEmail(asMember.body, w.member.user, w.everyone);

    const asOwner = await get(w.owner, path);
    expectEmailsFor(asOwner.body, [w.admin, w.colleague]);
  });
});

describe('newly registered accounts in the Default Workspace / Organization (FA-SEC-03)', () => {
  it('cannot harvest anyone’s e-mail from any directory', async () => {
    const w = await setup();
    await prisma.workspace.update({ where: { id: w.workspaceId }, data: { isDefault: true } });
    await prisma.organization.update({ where: { id: w.organizationId }, data: { isDefault: true } });
    try {
      // Joined the way signup joins the Default Workspace (MEMBER + General)...
      const joined = await register();
      await addToWorkspace(joined as unknown as TestUser, w.workspaceId, [w.generalChannelId]);
      // ...and one with no rows at all, relying on the defaults' implicit membership.
      const bare = await register();

      for (const newcomer of [joined, bare]) {
        const list = await get(newcomer, `/api/workspaces/${w.workspaceId}/members`);
        expect(list.status).toBe(200);
        expectOnlyOwnEmail(list.body, newcomer.user, w.everyone);
        expect((await get(newcomer, `/api/workspaces/${w.workspaceId}/members?q=example.com`)).body.members).toEqual([]);

        const profile = await get(newcomer, `/api/workspaces/${w.workspaceId}/members/${w.owner.user.id}`);
        expect(profile.status).toBe(200);
        expect(profile.body).not.toHaveProperty('email');

        const org = await get(newcomer, `/api/organizations/${w.organizationId}/members`);
        expect(org.status).toBe(200);
        expectOnlyOwnEmail(org.body, newcomer.user, w.everyone);
        expect((await get(newcomer, `/api/organizations/${w.organizationId}/members?q=example.com`)).body.members).toEqual([]);
      }

      // The quickest harvest path: create your own public channel, then list who could be added.
      const channel = await request(app).post('/api/channels').set(authHeader(joined.token)).send({ workspaceId: w.workspaceId, name: `mine-${Date.now()}` });
      expect(channel.status).toBe(201);
      const addable = await get(joined, `/api/channels/${channel.body.id}/addable-members`);
      expect(addable.status).toBe(200);
      expect(addable.body.length).toBeGreaterThanOrEqual(4);
      expectOnlyOwnEmail(addable.body, joined.user, w.everyone);
    } finally {
      await prisma.workspace.update({ where: { id: w.workspaceId }, data: { isDefault: false } });
      await prisma.organization.update({ where: { id: w.organizationId }, data: { isDefault: false } });
    }
  });
});
