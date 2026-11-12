import { HttpError } from '../httpError';
import { canManageWorkspace, WorkspaceActor } from './policy';

/**
 * Channel policy (Batch 3 / Sub-batch D). Pure functions, same shape as the
 * organization/workspace/project rules in policy.ts.
 *
 * Channel roles live in the legacy ChannelMember.role text column
 * (decision 3): 'admin' = Channel Owner, 'moderator', 'member'. Any other
 * stored value is treated as 'member'.
 *
 * "Managers" are the workspace's managers (workspace OWNER/ADMIN,
 * organization OWNER/ADMIN). They manage channel settings, membership and
 * roles — including private channels — but never gain content access
 * (decision 5): reading and posting always require channel membership.
 *
 * A channel role only counts while the user belongs to the workspace and the
 * channel's project (if private) admits them — a stale row grants nothing.
 */

export type ChannelRoleName = 'admin' | 'moderator' | 'member';
export type ChannelVisibilityName = 'PUBLIC' | 'PRIVATE';
export const CHANNEL_ROLES: readonly ChannelRoleName[] = ['admin', 'moderator', 'member'];

export const normalizeChannelRole = (raw: string | null | undefined): ChannelRoleName | null => {
  if (raw === null || raw === undefined) return null;
  return raw === 'admin' || raw === 'moderator' ? raw : 'member';
};

/** "General" is looked up by name by the frozen signup flow; it never changes type, name or archive state. */
export const isGeneralChannelName = (name: string | null | undefined) => name?.trim().toLowerCase() === 'general';

export interface ChannelActor {
  userId: string;
  channelId: string;
  workspace: WorkspaceActor;
  kind: 'channel' | 'dm' | 'groupDm';
  isGeneral: boolean;
  visibility: ChannelVisibilityName;
  isAnnouncement: boolean;
  archived: boolean;
  // lib/policy projectAllowsChannelAccess for this user (true when the channel
  // has no project, a public project, or the user is a project member).
  projectAdmits: boolean;
  channelRole: ChannelRoleName | null;
}

/** Builds a ChannelActor from an already-resolved workspace actor (listings, name checks). */
export const toChannelActor = (
  workspace: WorkspaceActor,
  channel: {
    id: string;
    name: string | null;
    isDM: boolean;
    isGroupDM: boolean;
    visibility: ChannelVisibilityName;
    isAnnouncement: boolean;
    archivedAt: Date | null;
  },
  storedRole: string | null | undefined,
  projectAdmits: boolean
): ChannelActor => ({
  userId: workspace.userId,
  channelId: channel.id,
  workspace,
  kind: channel.isGroupDM ? 'groupDm' : channel.isDM ? 'dm' : 'channel',
  isGeneral: !channel.isDM && isGeneralChannelName(channel.name),
  visibility: channel.visibility,
  isAnnouncement: channel.isAnnouncement,
  archived: channel.archivedAt !== null,
  projectAdmits,
  channelRole: normalizeChannelRole(storedRole),
});

export type ChannelAction =
  | 'channel.view' // metadata: name, topic, type, member list
  | 'channel.read' // message content
  | 'channel.join'
  | 'channel.leave'
  | 'channel.updateInfo' // topic, description, icon
  | 'channel.updateSettings' // name, visibility, announcement mode
  | 'channel.archive' // archive and restore
  | 'channel.addMembers'
  | 'channel.removeMembers'
  | 'channel.changeRoles'
  | 'channel.post' // top-level messages
  | 'channel.reply' // thread replies
  | 'channel.react';

/** The caller's channel role, honoured only while workspace + project membership hold. */
export const effectiveChannelRole = (actor: ChannelActor): ChannelRoleName | null =>
  actor.workspace.workspaceRole !== null && actor.projectAdmits ? actor.channelRole : null;

// ---- content (shared with the socket hot path) ----------------------------

export type ChannelContentAction = 'post' | 'reply' | 'react' | 'edit' | 'delete' | 'pin' | 'vote';

export interface ChannelContentContext {
  role: ChannelRoleName | null; // effective role (null = no content access)
  archived: boolean;
  isAnnouncement: boolean;
  isManager: boolean;
}

/**
 * Content rules: members only; archived channels are read-only; announcement
 * channels take top-level posts only from owners, moderators and workspace
 * managers who are members — everyone else may still reply and react.
 */
export const canChannelContent = (ctx: ChannelContentContext, action: ChannelContentAction): boolean => {
  if (ctx.role === null || ctx.archived) return false;
  if (action === 'post' && ctx.isAnnouncement) return ctx.role === 'admin' || ctx.role === 'moderator' || ctx.isManager;
  return true;
};

export const CHANNEL_CONTENT_DENIALS = {
  archived: 'This channel is archived and read-only.',
  announcement: 'Only channel owners, moderators and workspace admins can post in this announcement channel.',
  notMember: 'You are not a member of this channel.',
} as const;

/** Error message for a refused content action (callers already know the member has access). */
export const channelContentDenial = (ctx: ChannelContentContext) =>
  ctx.role === null ? CHANNEL_CONTENT_DENIALS.notMember : ctx.archived ? CHANNEL_CONTENT_DENIALS.archived : CHANNEL_CONTENT_DENIALS.announcement;

// ---- management ------------------------------------------------------------

export const canChannel = (actor: ChannelActor, action: ChannelAction): boolean => {
  const role = effectiveChannelRole(actor);
  const isChannel = actor.kind === 'channel';
  const inWorkspace = actor.workspace.workspaceRole !== null;
  const manager = canManageWorkspace(actor.workspace);
  const owner = role === 'admin';
  const ownerOrManager = owner || manager;
  const staff = owner || role === 'moderator' || manager;
  const content = (a: ChannelContentAction) =>
    canChannelContent({ role, archived: actor.archived, isAnnouncement: actor.isAnnouncement, isManager: manager }, a);

  switch (action) {
    case 'channel.view':
      if (!isChannel) return role !== null;
      return role !== null || manager || (actor.visibility === 'PUBLIC' && inWorkspace && actor.projectAdmits);
    case 'channel.read':
      return role !== null;
    case 'channel.join':
      return isChannel && !actor.archived && actor.visibility === 'PUBLIC' && inWorkspace && actor.projectAdmits;
    case 'channel.leave':
      return isChannel && !actor.isGeneral && role !== null;
    case 'channel.updateInfo':
      return isChannel && !actor.archived && staff;
    case 'channel.updateSettings':
      return isChannel && !actor.archived && ownerOrManager;
    case 'channel.archive':
      return isChannel && !actor.isGeneral && ownerOrManager;
    case 'channel.addMembers':
      if (!isChannel || actor.archived) return false;
      return actor.visibility === 'PUBLIC' ? role !== null || manager : staff;
    case 'channel.removeMembers':
      return isChannel && !actor.isGeneral && staff;
    case 'channel.changeRoles':
      return isChannel && !actor.archived && ownerOrManager;
    case 'channel.post':
      return content('post');
    case 'channel.reply':
      return content('reply');
    case 'channel.react':
      return content('react');
    default:
      return false;
  }
};

const CHANNEL_DENIALS: Record<ChannelAction, string> = {
  'channel.view': 'Channel not found.',
  'channel.read': 'You are not a member of this channel.',
  'channel.join': 'This channel can only be joined by invitation.',
  'channel.leave': 'You cannot leave this channel.',
  'channel.updateInfo': 'Only the channel owner, moderators or workspace admins can change the topic and description.',
  'channel.updateSettings': 'Only the channel owner or workspace admins can change channel settings.',
  'channel.archive': 'Only the channel owner or workspace admins can archive or restore this channel.',
  'channel.addMembers': 'Only the channel owner, moderators or workspace admins can add people to this channel.',
  'channel.removeMembers': 'Only the channel owner, moderators or workspace admins can remove people from this channel.',
  'channel.changeRoles': 'Only the channel owner or workspace admins can change channel roles.',
  'channel.post': CHANNEL_CONTENT_DENIALS.announcement,
  'channel.reply': CHANNEL_CONTENT_DENIALS.notMember,
  'channel.react': CHANNEL_CONTENT_DENIALS.notMember,
};

export const CHANNEL_ARCHIVED_MESSAGE = CHANNEL_CONTENT_DENIALS.archived;

/**
 * 404 when the caller may not see the channel (private channels never leak
 * their existence), 409 when only the archived state blocks the action,
 * 403 otherwise.
 */
export const assertChannel = (actor: ChannelActor, action: ChannelAction) => {
  if (canChannel(actor, action)) return;
  if (!canChannel(actor, 'channel.view')) throw new HttpError(404, CHANNEL_DENIALS['channel.view']);
  if (actor.archived && canChannel({ ...actor, archived: false }, action)) throw new HttpError(409, CHANNEL_ARCHIVED_MESSAGE);
  throw new HttpError(403, CHANNEL_DENIALS[action]);
};

// ---- target rules ------------------------------------------------------------

export interface ChannelTarget {
  userId: string;
  role: ChannelRoleName;
}

const isOwnerOrManager = (actor: ChannelActor) =>
  effectiveChannelRole(actor) === 'admin' || canManageWorkspace(actor.workspace);

/**
 * Removal: never yourself (leave instead), never the owner (transfer first);
 * moderators may remove plain members only.
 */
export const canRemoveChannelMember = (actor: ChannelActor, target: ChannelTarget): boolean => {
  if (target.userId === actor.userId || target.role === 'admin') return false;
  if (!canChannel(actor, 'channel.removeMembers')) return false;
  return target.role === 'member' || isOwnerOrManager(actor);
};

/**
 * Role changes: owner or managers only; never your own role (no
 * self-escalation, no accidental self-demotion); the owner's role only
 * changes through a transfer to someone else (next = 'admin').
 */
export const canChangeChannelRole = (actor: ChannelActor, target: ChannelTarget, next: ChannelRoleName): boolean => {
  if (target.userId === actor.userId || target.role === 'admin') return false;
  if (!CHANNEL_ROLES.includes(next)) return false;
  return canChannel(actor, 'channel.changeRoles');
};

/** Adding: managers can't add themselves to a private channel (management never implies content). */
export const canAddChannelMember = (actor: ChannelActor, targetUserId: string): boolean =>
  canChannel(actor, 'channel.addMembers') && (actor.visibility === 'PUBLIC' || targetUserId !== actor.userId);

/** Leaving: the owner transfers ownership first unless nobody else is left. */
export const canLeaveChannel = (actor: ChannelActor, otherMembers: number): boolean =>
  canChannel(actor, 'channel.leave') && (effectiveChannelRole(actor) !== 'admin' || otherMembers === 0);

/** Group DMs (Sub-batch E): anyone may leave; only the conversation's creator removes others. */
export const canRemoveGroupDMParticipant = (actorId: string, targetId: string, creatorId: string) =>
  targetId === actorId || creatorId === actorId;
