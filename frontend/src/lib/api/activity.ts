import { http, seg } from './http';

// P2 Phase I — the Activity feed (mentions and thread replies) and workspace
// search. Both are workspace-scoped; the server only returns messages from
// conversations the caller currently belongs to (backend lib/notifications.ts).

export interface ConversationRef {
  id: string;
  name: string | null;
  isDM: boolean;
  isGroupDM: boolean;
  /** "#name" material for channels; the other people for DMs. */
  label: string;
}

export interface ActivityNotification {
  id: string;
  type: 'MENTION' | 'REPLY';
  isRead: boolean;
  createdAt: string;
  workspaceId: string;
  channel: ConversationRef;
  message: { id: string; parentId: string | null; createdAt: string; preview: string; sender: { id: string; username: string } };
}

export interface WorkspaceSearchResult {
  id: string;
  parentId: string | null;
  createdAt: string;
  preview: string;
  sender: { id: string; username: string };
  channel: ConversationRef;
}

/** GET /api/workspaces/:id/notifications — newest 50 plus the unread count. */
export const listNotifications = (workspaceId: string) =>
  http.get<{ notifications: ActivityNotification[]; unreadCount: number }>(`/api/workspaces/${seg(workspaceId)}/notifications`);

/** POST /api/workspaces/:id/notifications/read — all of the caller's, or only `ids`. */
export const markNotificationsRead = (workspaceId: string, ids?: string[]) =>
  http.post<{ updated: number }>(`/api/workspaces/${seg(workspaceId)}/notifications/read`, ids ? { ids } : {});

/** GET /api/workspaces/:id/search?q= — 2–200 characters, newest 30 matches. */
export const searchWorkspace = (workspaceId: string, q: string) =>
  http.get<{ results: WorkspaceSearchResult[] }>(`/api/workspaces/${seg(workspaceId)}/search`, { q });

/** Where a conversation appears in lists: "#general", or the DM partner names. */
export const conversationLabel = (c: ConversationRef) => (c.isDM ? c.label : `#${c.label}`);
