import { prisma } from '../../lib/prisma';
import { logAuditEvent } from '../../lib/auditLog';
import { isUuid } from '../../lib/messageInput';
import {
  assertCanCreateWorkspace,
  assertOrganization,
  assertWorkspace,
  canManageWorkspace,
  canWorkspace,
  loadHierarchyActor,
  loadOrganizationActor,
  loadWorkspaceActor,
  OrganizationRoleName,
  visibleChannelsWhere,
  WorkspaceActor,
} from '../../lib/policy';
import { ensureSharedWorkspaceMembership } from '../../lib/sharedWorkspace';
import { addWorkspacePresence } from '../../sockets/presence.handlers';
import { emitToWorkspace, subscribeUserToChannel } from '../../sockets/registry';
import { emailDeliveryConfigured } from '../../lib/emailDelivery';
import { ensureOrganizationsForUser, uniqueOrganizationSlug } from '../organizations/organizations.service';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The workspace every pre-existing user/channel/invitation was backfilled
// into when workspaces were introduced (see migration 20260721085550) — new
// self-serve signups (auth.service.ts) and legacy invitation flows still
// default here until a real "pick or create a workspace" onboarding step
// exists.
export const DEFAULT_WORKSPACE_SLUG = 'default';

const slugify = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

// Creates the workspace, makes the creator its ADMIN member, and seeds a
// default "General" channel (with the creator as its channel-level admin
// too) — all inside one transaction, so a workspace can never exist without
// both someone able to administer it and somewhere to actually talk.
export const createWorkspace = async (ownerId: string, name: string, organizationId?: unknown, description?: unknown) => {
  // Stage 1 (T.19): only Company Admins and Team Leads create workspaces —
  // decided from the database before anything else, whatever the body says.
  // (The SmartConnect Collab bootstrap, lib/sharedWorkspace.ts, does not come
  // through here and is unaffected.)
  assertCanCreateWorkspace(await loadHierarchyActor(ownerId));
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName) {
    throw new HttpError(400, 'Workspace name is required');
  }
  if (trimmedName.length > 80) {
    throw new HttpError(400, 'Workspace name must be 80 characters or fewer');
  }
  // Stage 3 (T.22): optional description at creation (same limit as settings).
  let trimmedDescription: string | null = null;
  if (description !== undefined && description !== null && description !== '') {
    if (typeof description !== 'string' || description.trim().length > 500) {
      throw new HttpError(400, 'Workspace description must be text of 500 characters or fewer');
    }
    trimmedDescription = description.trim() || null;
  }

  // Optional target organization (Batch 3): creating a workspace inside an
  // existing organization needs organization OWNER/ADMIN. Without one, the
  // workspace gets its own new organization with the creator as OWNER —
  // exactly the previous "anyone can create a workspace" behaviour.
  let targetOrganizationId: string | null = null;
  if (organizationId !== undefined && organizationId !== null && organizationId !== '') {
    if (!isUuid(organizationId)) throw new HttpError(400, 'Invalid organizationId.');
    assertOrganization(await loadOrganizationActor(ownerId, organizationId), 'organization.createWorkspace');
    targetOrganizationId = organizationId;
  }

  const baseSlug = slugify(trimmedName) || 'workspace';
  let slug = baseSlug;
  let suffix = 1;
  // Two different customers both naming their workspace "Acme" is an
  // ordinary thing to happen — append -2, -3, ... on collision rather than
  // rejecting the request outright.
  while (await prisma.workspace.findUnique({ where: { slug } })) {
    suffix += 1;
    slug = `${baseSlug}-${suffix}`;
  }

  return prisma.$transaction(async (tx) => {
    let organizationIdForWorkspace = targetOrganizationId;
    if (!organizationIdForWorkspace) {
      const organization = await tx.organization.create({
        data: { name: trimmedName, slug: await uniqueOrganizationSlug(tx, trimmedName) },
      });
      await tx.organizationMember.create({ data: { organizationId: organization.id, userId: ownerId, role: 'OWNER' } });
      organizationIdForWorkspace = organization.id;
    }

    const workspace = await tx.workspace.create({
      data: { name: trimmedName, slug, ownerId, organizationId: organizationIdForWorkspace, description: trimmedDescription },
    });

    await tx.workspaceMember.create({
      data: { userId: ownerId, workspaceId: workspace.id, role: 'ADMIN' },
    });

    const generalChannel = await tx.channel.create({
      data: {
        name: 'General',
        isDM: false,
        createdBy: ownerId,
        workspaceId: workspace.id,
      },
    });

    await tx.channelMember.create({
      data: { userId: ownerId, channelId: generalChannel.id, role: 'admin' },
    });

    return { workspace, generalChannel };
  });
};

// `members` here is deliberately filtered to *just* the caller's own row
// (not the full roster — that's wasteful for a workspace-switcher list) so
// the frontend can tell whether to offer owner/admin-only actions like
// deleting the workspace, without a second round-trip.
//
// The OR clause is what makes the Default Workspace show up for literally
// every authenticated user (Rule 2), even one with no WorkspaceMember row
// there at all — matching requireWorkspaceAccess's isDefault bypass below,
// so a workspace visible in this list is always one the user can actually
// open. Private workspaces (isDefault: false) still require real membership.
// Server-computed UI hints (Batch 3/E) — every action is re-checked on use.
const capabilitiesFor = (actor: WorkspaceActor) => ({
  canManage: canManageWorkspace(actor),
  canManageInvitations: canWorkspace(actor, 'workspace.manageInvitations'),
  canDelete: canWorkspace(actor, 'workspace.delete'),
  // T.32 (audit FE-2): lets the sidebar hide "Create channel" when the
  // workspace's channel-creation policy does not allow this member.
  canCreateChannel: canWorkspace(actor, 'workspace.createChannel'),
});

export const listWorkspacesForUser = async (userId: string) => {
  await ensureOrganizationsForUser(userId);
  // P2: first-time access to SmartConnect Collab for any active account that
  // doesn't have it yet (e.g. created before it existed); live sockets join
  // its default channels at once.
  const shared = await ensureSharedWorkspaceMembership(userId);
  if (shared && shared.joinedChannelIds.length > 0) {
    addWorkspacePresence(userId, shared.workspaceId);
    for (const channelId of shared.joinedChannelIds) subscribeUserToChannel(userId, channelId);
  }
  const workspaces = await prisma.workspace.findMany({
    where: {
      OR: [{ isDefault: true }, { members: { some: { userId } } }],
    },
    include: {
      // Batch 3/C+D: only channels the caller can see are counted — not private
      // channels or private-project channels they aren't in (the count would
      // otherwise hint at hidden channels), and not other people's DMs.
      _count: { select: { members: true, channels: { where: visibleChannelsWhere(userId) } } },
      // A user with no membership row (the Default Workspace, reached via
      // the isDefault branch above) gets an empty array here, not an error —
      // members[0] below is simply undefined for them.
      members: { where: { userId }, select: { role: true } },
      organization: {
        select: { id: true, name: true, isDefault: true, members: { where: { userId }, select: { role: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return workspaces.map(({ members, organization, ...workspace }) => {
    const isOwner = workspace.ownerId === userId;
    const organizationRole = (organization?.members[0]?.role as OrganizationRoleName | undefined) ?? null;
    return {
      ...workspace,
      myRole: members[0]?.role ?? null,
      isOwner,
      organization: organization ? { id: organization.id, name: organization.name, isDefault: organization.isDefault } : null,
      organizationRole,
      capabilities: capabilitiesFor({
        userId,
        workspaceId: workspace.id,
        organizationId: organization?.id ?? null,
        isDefaultWorkspace: workspace.isDefault,
        channelCreationPolicy: workspace.channelCreationPolicy,
        workspaceRole: isOwner ? 'OWNER' : members[0]?.role ?? (workspace.isDefault ? 'MEMBER' : null),
        organizationRole,
      }),
    };
  });
};

const DESCRIPTION_MAX = 500;
const CHANNEL_POLICIES = ['MEMBERS', 'ADMINS'] as const;

/** Workspace settings (Batch 3/B). Visible to members and organization managers. */
export const getWorkspaceSettings = async (userId: string, workspaceId: string) => {
  const actor = await loadWorkspaceActor(userId, workspaceId);
  assertWorkspace(actor, 'workspace.viewSettings');
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      isDefault: true,
      channelCreationPolicy: true,
      createdAt: true,
      owner: { select: { id: true, username: true } },
      organization: { select: { id: true, name: true, isDefault: true } },
      _count: { select: { members: true } },
    },
  });
  return {
    ...workspace!,
    myRole: actor.workspaceRole,
    organizationRole: actor.organizationRole,
    // T.36: lets the Invitations tab say up front that no e-mail can be sent.
    emailInvitationsAvailable: emailDeliveryConfigured(),
    capabilities: {
      canUpdateSettings: canWorkspace(actor, 'workspace.updateSettings'),
      canChangeRoles: canWorkspace(actor, 'workspace.changeMemberRole'),
      canRemoveMembers: canWorkspace(actor, 'workspace.removeMember') && !actor.isDefaultWorkspace,
      canCreateChannel: canWorkspace(actor, 'workspace.createChannel'),
    },
  };
};

export const updateWorkspaceSettings = async (userId: string, workspaceId: string, body: unknown) => {
  const actor = await loadWorkspaceActor(userId, workspaceId);
  assertWorkspace(actor, 'workspace.updateSettings');
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const data: { name?: string; description?: string | null; channelCreationPolicy?: 'MEMBERS' | 'ADMINS' } = {};

  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new HttpError(400, 'Workspace name is required');
    if (name.length > 80) throw new HttpError(400, 'Workspace name must be 80 characters or fewer');
    data.name = name;
  }
  if (input.description !== undefined) {
    if (input.description !== null && typeof input.description !== 'string') throw new HttpError(400, 'Description must be text.');
    const description = (input.description ?? '').trim();
    if (description.length > DESCRIPTION_MAX) throw new HttpError(400, `Description must be ${DESCRIPTION_MAX} characters or fewer.`);
    data.description = description || null;
  }
  if (input.channelCreationPolicy !== undefined) {
    if (!CHANNEL_POLICIES.includes(input.channelCreationPolicy as 'MEMBERS')) {
      throw new HttpError(400, 'channelCreationPolicy must be MEMBERS or ADMINS.');
    }
    data.channelCreationPolicy = input.channelCreationPolicy as 'MEMBERS' | 'ADMINS';
  }
  if (Object.keys(data).length === 0) throw new HttpError(400, 'Nothing to update.');

  const updated = await prisma.workspace.update({
    where: { id: workspaceId },
    data,
    select: { id: true, name: true, description: true, channelCreationPolicy: true, organizationId: true },
  });
  await logAuditEvent(userId, 'UPDATE_WORKSPACE_SETTINGS', 'WORKSPACE', workspaceId, `Updated: ${Object.keys(data).join(', ')}`);
  emitToWorkspace(workspaceId, 'workspace:updated', updated);
  return getWorkspaceSettings(userId, workspaceId);
};

// Deleting a Workspace cascades (schema.prisma) through every Channel,
// Message, WorkspaceMember, and Invitation scoped to it — verified live
// against a real throwaway workspace when Message.workspaceId was added
// (migration 20260721115337). Nothing here needs its own cleanup logic; the
// job of this function is entirely about *who's allowed* to trigger it.
export const deleteWorkspace = async (userId: string, workspaceId: string) => {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) {
    throw new HttpError(404, 'Workspace not found');
  }

  // The Default Workspace is what every pre-existing user and every new
  // self-serve signup (auth.service.ts's joinGeneralChannel) still falls
  // back to — deleting it would silently break signup for as long as no
  // "choose a workspace" onboarding step exists. Same category of guard as
  // channels.service.ts protecting the literal "General" channel from deletion.
  if (workspace.slug === DEFAULT_WORKSPACE_SLUG) {
    throw new HttpError(403, 'The default workspace cannot be deleted.');
  }

  // Batch 3/E: lib/policy 'workspace.delete' — owner-level only (workspace
  // OWNER or organization OWNER/ADMIN). Previously any workspace ADMIN could
  // delete the whole tenant, although admins can't even remove each other.
  assertWorkspace(await loadWorkspaceActor(userId, workspaceId), 'workspace.delete');

  // Captured before the cascade so live sockets can be revoked afterwards.
  const [members, channels] = await Promise.all([
    prisma.workspaceMember.findMany({ where: { workspaceId }, select: { userId: true } }),
    prisma.channel.findMany({ where: { workspaceId }, select: { id: true } }),
  ]);

  await prisma.workspace.delete({ where: { id: workspaceId } });
  await logAuditEvent(userId, 'DELETE_WORKSPACE', 'WORKSPACE', workspaceId, `Deleted workspace "${workspace.name}"`);

  return {
    message: 'Workspace deleted successfully',
    memberIds: members.map((m) => m.userId),
    channelIds: channels.map((c) => c.id),
  };
};

export { HttpError };
