import { createContext, useContext } from 'react';
import { Socket } from 'socket.io-client';
import type { ConnectionStatus } from '../../hooks/useSocket';
import type { ReadStateMap } from '../../lib/unread';
import { Channel, User } from '../../types';

export interface WorkspaceContextValue {
  // The active tenant, read from the `/:workspaceId` URL param by
  // WorkspaceLayout — every fetch/action below is scoped to this workspace.
  workspaceId: string;
  socket: Socket | null;
  connectionStatus: ConnectionStatus;
  channels: Channel[];
  // True while `channels` is being (re)fetched for `workspaceId` — including
  // the instant right after switching workspaces, before the new workspace's
  // channels have arrived. WorkspaceIndex relies on this rather than
  // `channels.length === 0` to know whether it's safe to redirect.
  channelsLoading: boolean;
  // The caller's DM conversations in this workspace, most recently active
  // first. Kept separate from `channels` (the backend excludes DMs there).
  dms: Channel[];
  dmsLoading: boolean;
  onlineUsers: User[];
  users: User[];
  // Server-persisted read positions (+ optimistic live increments), keyed by
  // channel/DM id; unreadCounts is derived from it.
  readState: ReadStateMap;
  unreadCounts: Record<string, number>;
  // P3: unread @mentions/replies in this workspace (the Activity badge); the
  // Activity feed keeps it in sync as items are read.
  activityUnread?: number;
  setActivityUnread?: (count: number) => void;
  clearUnread: (channelId: string) => void;
  // Advance the read position on the server (monotonic); defaults to latest.
  markChannelRead: (channelId: string, messageId?: string) => void;
  fetchChannels: (onComplete?: (chans: Channel[]) => void) => void;
  fetchDMs: () => void;
  // Inserts/replaces a DM or group DM in the sidebar list (sorted by activity).
  upsertDM: (dm: Channel) => void;
  // Drops a conversation locally after leaving it / being removed.
  removeConversation: (channelId: string) => void;
  // Appends a freshly created channel straight into local state — used right
  // after POST /api/channels succeeds, so the sidebar updates instantly.
  addChannel: (channel: Channel) => void;
  startDM: (userId: string) => Promise<void>;
  startCall: (channelId: string, callType: 'audio' | 'video') => void;
  // A call is tied to whichever workspace it was started in (see
  // CallOverlay.tsx's workspaceId prop).
  hasActiveCall: boolean;
  endActiveCall: () => void;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

export const useWorkspace = () => {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceLayout');
  return ctx;
};

/** Resolves a channel id against both public channels and DMs. */
export const findConversation = (channels: Channel[], dms: Channel[], id?: string | null) =>
  id ? channels.find((c) => c.id === id) ?? dms.find((d) => d.id === id) ?? null : null;
