export interface User {
  id: string;
  username: string;
  email?: string;
  role?: string;
  // Where WorkspaceRedirect lands this user — kept in sync by WorkspaceLayout
  // whenever they switch workspaces. Absent/null falls back to whichever
  // workspace is first in their /api/workspaces list.
  lastActiveWorkspaceId?: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt?: string;
  _count?: { members: number; channels: number };
  // The caller's own role in this workspace — used purely for UI decisions
  // (e.g. showing "Delete Workspace" only to owners/admins). The backend
  // re-verifies this independently on the actual delete request.
  myRole?: 'ADMIN' | 'MEMBER' | null;
  // The one workspace every authenticated user can see, regardless of
  // membership (see requireWorkspaceAccess on the backend) — WorkspaceSwitcher
  // pins it to the top and gives it a distinct icon instead of an initial.
  isDefault?: boolean;
  // Server-computed (lib/policy); every action is re-checked by the backend.
  capabilities?: { canManage: boolean; canManageInvitations?: boolean; canDelete?: boolean; canCreateChannel?: boolean };
  // Batch 3 hierarchy (already returned by GET /api/workspaces).
  description?: string | null;
  isOwner?: boolean;
  organizationId?: string | null;
  organization?: { id: string; name: string; isDefault: boolean } | null;
  organizationRole?: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
  channelCreationPolicy?: 'MEMBERS' | 'ADMINS';
}

export interface Channel {
  id: string;
  name: string;
  description?: string;
  icon?: string | null;
  isDM?: boolean;
  workspaceId?: string;
  createdAt?: string;
  // Only present on DM channels (see listDMsForWorkspace) — the other
  // participant's user id, so the sidebar can match this conversation
  // against the online-users list without re-deriving it from `.members`.
  otherUserId?: string | null;
  // DM list only: plain-text preview of the newest message, and the time
  // used to sort conversations by recent activity.
  lastMessage?: { id: string; preview: string; senderId: string; createdAt: string } | null;
  lastActivityAt?: string;
  // Group DMs (3+ people): custom name (if any) and the participant list.
  isGroupDM?: boolean;
  customName?: string | null;
  createdBy?: string;
  participants?: { id: string; username: string }[];
  // Batch 3/D channel type and lifecycle (absent on DMs).
  visibility?: ChannelVisibility;
  isAnnouncement?: boolean;
  topic?: string | null;
  archivedAt?: string | null;
  projectId?: string | null;
}

export type ChannelVisibility = 'PUBLIC' | 'PRIVATE';
/** Stored channel roles: 'admin' is the Channel Owner (legacy name). */
export type ChannelRole = 'admin' | 'moderator' | 'member';

export interface ChannelCapabilities {
  canRead: boolean;
  canPost: boolean;
  canReply: boolean;
  canReact: boolean;
  canJoin: boolean;
  canLeave: boolean;
  canUpdateInfo: boolean;
  canUpdateSettings: boolean;
  canChangeType: boolean;
  canArchive: boolean;
  canAddMembers: boolean;
  canRemoveMembers: boolean;
  canChangeRoles: boolean;
}

/** GET /api/channels/:id/details — the server decides every capability. */
export interface ChannelDetails {
  id: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  description: string | null;
  topic: string | null;
  icon: string | null;
  visibility: ChannelVisibility;
  isAnnouncement: boolean;
  type: 'PUBLIC' | 'PRIVATE' | 'ANNOUNCEMENT';
  archived: boolean;
  archivedAt: string | null;
  isGeneral: boolean;
  memberCount: number;
  owner: { id: string; username: string } | null;
  archivedBy: { id: string; username: string } | null;
  project: { id: string; name: string; visibility: string } | null;
  myRole: ChannelRole | null;
  capabilities: ChannelCapabilities;
}

export interface ChannelMemberInfo {
  userId: string;
  role: ChannelRole;
  joinedAt: string;
  user: { id: string; username: string };
}

/** Persisted read position + unread count for one conversation (server-authoritative). */
export interface ReadState {
  channelId: string;
  unreadCount: number;
  lastReadMessageId: string | null;
  lastReadAt: string;
}

export interface Receipt {
  userId: string;
  username: string;
  lastReadMessageId: string | null;
  lastReadAt: string | null;
}

export interface Presence {
  id: string;
  username: string;
  status: string;
  emoji: string;
}

export interface WorkspaceMember {
  id: string;
  username: string;
  /** Only for workspace managers, and for the member themselves (FA-SEC-03). */
  email?: string;
  title: string | null;
  role: 'ADMIN' | 'MEMBER';
  isOwner: boolean;
  joinedAt: string;
  presence: Presence | null;
}

export interface MemberProfile extends WorkspaceMember {
  bio: string | null;
  timezone: string | null;
  sharedChannels: { id: string; name: string | null }[];
}

export interface UserProfileSettings {
  title: string | null;
  bio: string | null;
  timezone: string | null;
  readReceiptsEnabled: boolean;
}

export interface Message {
  id: string;
  channelId: string;
  senderId: string;
  sender: {
    id: string;
    username: string;
  };
  content?: string;
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  parentId?: string | null;
  // Idempotency key the sender attached (see lib/messages.ts createClientId).
  clientId?: string | null;
  createdAt: string;
  /** P2: set when the author edited the message (drives the "(edited)" label). */
  editedAt?: string | null;
}
