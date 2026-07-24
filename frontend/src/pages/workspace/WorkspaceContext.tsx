import { createContext, useContext } from 'react';
import { Socket } from 'socket.io-client';
import { Channel, User } from '../../types';

export interface WorkspaceContextValue {
  // The active tenant, read from the `/:workspaceId` URL param by
  // WorkspaceLayout — every fetch/action below is scoped to this workspace.
  workspaceId: string;
  socket: Socket | null;
  channels: Channel[];
  // True while `channels` is being (re)fetched for `workspaceId` — including
  // the instant right after switching workspaces, before the new workspace's
  // channels have arrived. WorkspaceIndex relies on this rather than
  // `channels.length === 0` to know whether it's safe to redirect: a switch
  // between two non-empty workspaces briefly leaves the *previous*
  // workspace's channels in state, which is non-empty but wrong.
  channelsLoading: boolean;
  onlineUsers: User[];
  users: User[];
  unreadCounts: Record<string, number>;
  clearUnread: (channelId: string) => void;
  fetchChannels: (onComplete?: (chans: Channel[]) => void) => void;
  // Appends a freshly created channel straight into local state — used right
  // after POST /api/channels succeeds, so the sidebar updates instantly
  // without waiting on a full fetchChannels round-trip.
  addChannel: (channel: Channel) => void;
  startDM: (userId: string) => Promise<void>;
  startCall: (channelId: string, callType: 'audio' | 'video') => void;
  // A call is tied to whichever workspace it was started in (see
  // CallOverlay.tsx's workspaceId prop) — WorkspaceSwitcher checks this
  // before letting a switch happen, prompting to end the call first rather
  // than silently leaving it running against a workspace the user has
  // navigated away from.
  hasActiveCall: boolean;
  endActiveCall: () => void;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

export const useWorkspace = () => {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceLayout');
  return ctx;
};
