import { prisma } from '../../lib/prisma';
import { logAuditEvent } from '../../lib/auditLog';

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
export const createWorkspace = async (ownerId: string, name: string) => {
  const trimmedName = name?.trim();
  if (!trimmedName) {
    throw new HttpError(400, 'Workspace name is required');
  }
  if (trimmedName.length > 80) {
    throw new HttpError(400, 'Workspace name must be 80 characters or fewer');
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
    const workspace = await tx.workspace.create({
      data: { name: trimmedName, slug, ownerId },
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
export const listWorkspacesForUser = async (userId: string) => {
  const workspaces = await prisma.workspace.findMany({
    where: {
      OR: [{ isDefault: true }, { members: { some: { userId } } }],
    },
    include: {
      _count: { select: { members: true, channels: true } },
      // A user with no membership row (the Default Workspace, reached via
      // the isDefault branch above) gets an empty array here, not an error —
      // members[0] below is simply undefined for them.
      members: { where: { userId }, select: { role: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return workspaces.map(({ members, ...workspace }) => ({
    ...workspace,
    myRole: members[0]?.role ?? null,
  }));
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

  const isOwner = workspace.ownerId === userId;
  if (!isOwner) {
    const membership = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    if (!membership || membership.role !== 'ADMIN') {
      throw new HttpError(403, 'Only the workspace owner or an admin can delete this workspace.');
    }
  }

  await prisma.workspace.delete({ where: { id: workspaceId } });
  await logAuditEvent(userId, 'DELETE_WORKSPACE', 'WORKSPACE', workspaceId, `Deleted workspace "${workspace.name}"`);

  return { message: 'Workspace deleted successfully' };
};

export { HttpError };
