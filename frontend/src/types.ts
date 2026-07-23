export interface User {
  id: string;
  username: string;
  email?: string;
  role?: string;
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
  parentId?: string;
  parent?: Message;
  createdAt: string;
}
