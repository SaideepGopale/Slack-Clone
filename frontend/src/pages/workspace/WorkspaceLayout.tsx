import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation, useMatch, useNavigate, useParams } from 'react-router-dom';
import { CallOverlay, IncomingCallBanner } from '../../components/chat/CallOverlay';
import { Header } from '../../components/layout/Header';
import { Sidebar } from '../../components/sidebar/Sidebar';
import { WorkspaceSwitcher } from '../../components/sidebar/WorkspaceSwitcher';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../hooks/useSocket';
import { Channel, User } from '../../types';
import { WorkspaceContext, WorkspaceContextValue } from './WorkspaceContext';

const LoadingScreen = () => (
  <div className="h-screen w-screen flex flex-col items-center justify-center bg-gradient-to-br from-white via-gray-50 to-blue-50 dark:from-[#111215] dark:via-[#1A1D21] dark:to-[#0f1419] transition-colors">
    <div className="relative">
      <div className="w-20 h-20 bg-gradient-to-br from-blue-600 to-purple-600 rounded-2xl flex items-center justify-center text-white font-black text-3xl shadow-2xl mb-6 animate-pulse">
        S
      </div>
      <div className="absolute -inset-2 bg-gradient-to-r from-blue-600 to-purple-600 rounded-2xl blur-xl opacity-30 animate-pulse"></div>
    </div>
    <div className="flex flex-col items-center gap-3">
      <p className="text-gray-600 dark:text-gray-400 font-bold text-base tracking-wide">Loading Workspace...</p>
      <div className="flex gap-1.5">
        <div className="w-2 h-2 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
        <div className="w-2 h-2 bg-purple-600 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
        <div className="w-2 h-2 bg-pink-600 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
      </div>
    </div>
  </div>
);

// The 5 sidebar nav items live at their own routes; anything else (a channel
// or DM at /:workspaceId/c/:id) maps to the 'chat' sentinel so none of them
// highlight. Strips the leading /:workspaceId segment first since it's
// always present now.
const activeViewFromPath = (pathname: string, workspaceId: string) => {
  const rest = pathname.slice(`/${workspaceId}`.length) || '/';
  if (rest.startsWith('/home')) return 'home';
  if (rest.startsWith('/dms')) return 'dms';
  if (rest.startsWith('/activity')) return 'activity';
  if (rest.startsWith('/directory')) return 'directory';
  if (rest.startsWith('/more')) return 'more';
  return 'chat';
};

export const WorkspaceLayout = () => {
  const { user, token } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const channelMatch = useMatch('/:workspaceId/c/:channelId');
  const socket = useSocket(token);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(true);
  // Real, already-started 1:1 conversations — kept entirely separate from
  // `channels` now that the backend excludes DMs from that list (see
  // channels.service.ts's isDM fix). Sidebar renders these under "Direct
  // Messages" instead of the old (buggy) "every workspace user" list.
  const [dms, setDMs] = useState<Channel[]>([]);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [onlineUsers, setOnlineUsers] = useState<User[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [incomingCall, setIncomingCall] = useState<{ channelId: string; callerName: string; callType: 'audio' | 'video' } | null>(null);
  const [activeCall, setActiveCall] = useState<{ channelId: string; callType: 'audio' | 'video' } | null>(null);
  const activeCallRef = useRef(activeCall);

  const currentChannelId = channelMatch?.params.channelId;

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  const fetchChannels = useCallback((onComplete?: (chans: Channel[]) => void) => {
    if (!token || !workspaceId) return;
    axios.get<Channel[]>(`/api/workspaces/${workspaceId}/channels`)
      .then(res => {
        setChannels(res.data);
        onComplete?.(res.data);
      })
      .catch(err => {
        console.error('fetchChannels error:', err);
        // Still resolve onComplete on failure — callers (notably the
        // channelsLoading reset below) need to know the fetch settled one
        // way or the other, not just on success.
        onComplete?.([]);
      });
  }, [token, workspaceId]);

  const addChannel = useCallback((channel: Channel) => {
    setChannels(prev => (prev.some(c => c.id === channel.id) ? prev : [...prev, channel]));
  }, []);

  const fetchDMs = useCallback(() => {
    if (!token || !workspaceId) return;
    axios.get<Channel[]>(`/api/workspaces/${workspaceId}/dms`)
      .then(res => setDMs(res.data))
      .catch(err => console.error('fetchDMs error:', err));
  }, [token, workspaceId]);

  const startDM = useCallback(async (userId: string) => {
    try {
      // Navigates straight off the API response now — this DM won't be in
      // `channels` at all anymore (it never was a public channel), so there's
      // nothing to look up there. fetchDMs() just refreshes the sidebar list
      // so this conversation shows up under Direct Messages going forward.
      const res = await axios.post<Channel>('/api/channels/dm', { targetUserId: userId });
      navigate(`/${workspaceId}/c/${res.data.id}`);
      fetchDMs();
    } catch (err) {
      console.error('Failed to start DM:', err);
    }
  }, [fetchDMs, navigate, workspaceId]);

  const startCall = useCallback((channelId: string, callType: 'audio' | 'video') => {
    setActiveCall({ channelId, callType });
    socket?.emit('call:initiate', { channelId, callerName: user?.username || 'User', callType });
  }, [socket, user]);

  // Properly tears down a call rather than just clearing local state — tells
  // the backend this socket left the call room (so other participants get
  // webrtc:peer-left promptly instead of waiting for a disconnect timeout).
  // Used both by CallOverlay's own "end call" button (via onEndCall) and by
  // WorkspaceSwitcher when a workspace switch requires ending the call first.
  const endActiveCall = useCallback(() => {
    setActiveCall((current) => {
      if (current) socket?.emit('webrtc:leave', { channelId: current.channelId });
      return null;
    });
  }, [socket]);

  const clearUnread = useCallback((channelId: string) => {
    setUnreadCounts(prev => {
      if (!prev[channelId]) return prev;
      const next = { ...prev };
      delete next[channelId];
      return next;
    });
  }, []);

  // Switching workspaces (via WorkspaceSwitcher) changes `workspaceId`,
  // which recreates `fetchChannels` — clear the previous workspace's
  // channels/unread state here rather than leaving stale entries visible
  // for the instant before the new workspace's data arrives.
  //
  // channelsLoading exists because "channels.length === 0" is NOT a safe
  // proxy for "still loading, don't navigate yet": right after switching
  // from a non-empty workspace to another non-empty workspace, there's a
  // render where `channels` still holds the *previous* workspace's (non-
  // empty!) list, since this effect runs after that render commits. Without
  // an explicit loading flag, WorkspaceIndex would find a "General" match in
  // the stale list and redirect into a channel that belongs to the wrong
  // workspace entirely — confirmed happening in manual testing before this
  // flag was added.
  useEffect(() => {
    setChannelsLoading(true);
    setChannels([]);
    setDMs([]);
    setUnreadCounts({});
    fetchChannels(() => setChannelsLoading(false));
    fetchDMs();
    if (token) {
      axios.get<User[]>('/api/users').then(res => setUsers(res.data));
    }
  }, [token, fetchChannels, fetchDMs]);

  // Fire-and-forget: keeps User.lastActiveWorkspaceId in sync so a future
  // login/signup lands the user back here instead of always defaulting to
  // their first workspace (see WorkspaceRedirect.tsx). Not critical-path —
  // a failure here shouldn't block or error out the workspace switch itself.
  useEffect(() => {
    if (!token || !workspaceId) return;
    axios.patch('/api/users/me/active-workspace', { workspaceId }).catch(() => {});
  }, [token, workspaceId]);

  useEffect(() => {
    if (!socket) return;

    const handleChannelCreated = (c: Channel) => setChannels(p => [...p, c]);

    // Someone added this user to a channel via AddMemberModal — they aren't
    // in that channel's Socket.IO room (channels.controller.ts reaches them
    // through their personal user:<id> room instead), so this is the only
    // way their sidebar picks it up without a manual refresh. Only add it if
    // it belongs to the workspace currently open here — if the user's
    // browsing a different workspace right now, that workspace's own
    // WorkspaceLayout instance (if/when they switch to it) will pick it up
    // via its own fetchChannels instead.
    const handleChannelMemberAdded = (c: Channel) => {
      if (c.workspaceId && c.workspaceId !== workspaceId) return;
      addChannel(c);
    };

    // Bootstraps this client's presence state — sent once, only to this
    // socket, right after connecting (see presence.handlers.ts).
    const handlePresenceInit = (data: { users: User[] }) => setOnlineUsers(data.users);
    // Delta: one user came online or changed status — upsert them in place
    // rather than expecting (or requesting) a full-array replacement.
    const handleUserOnline = (delta: User) => {
      setOnlineUsers(prev => {
        const index = prev.findIndex(u => u.id === delta.id);
        if (index === -1) return [...prev, delta];
        const next = [...prev];
        next[index] = delta;
        return next;
      });
    };
    // Delta: one user fully disconnected — remove just that entry.
    const handleUserOffline = ({ id }: { id: string }) => {
      setOnlineUsers(prev => prev.filter(u => u.id !== id));
    };

    const handleIncomingCall = (data: { channelId: string; callerName: string; callType: 'audio' | 'video' }) => {
      if (!activeCallRef.current) {
        setIncomingCall(data);
      }
    };
    const handleNewMessage = (msg: { senderId: string; channelId: string }) => {
      if (msg.senderId !== user?.id) {
        if (!currentChannelId || currentChannelId !== msg.channelId) {
          setUnreadCounts(prev => ({ ...prev, [msg.channelId]: (prev[msg.channelId] || 0) + 1 }));
        }
      }
    };

    socket.on('channel:created', handleChannelCreated);
    socket.on('channel:member_added', handleChannelMemberAdded);
    socket.on('presence:init', handlePresenceInit);
    socket.on('user:online', handleUserOnline);
    socket.on('user:offline', handleUserOffline);
    socket.on('call:incoming', handleIncomingCall);
    socket.on('message:received', handleNewMessage);

    return () => {
      socket.off('channel:created', handleChannelCreated);
      socket.off('channel:member_added', handleChannelMemberAdded);
      socket.off('presence:init', handlePresenceInit);
      socket.off('user:online', handleUserOnline);
      socket.off('user:offline', handleUserOffline);
      socket.off('call:incoming', handleIncomingCall);
      socket.off('message:received', handleNewMessage);
    };
  }, [socket, currentChannelId, user, workspaceId, addChannel]);

  // Only reachable if someone hand-types a malformed URL — the router always
  // supplies :workspaceId for anything mounted under this layout.
  if (!workspaceId) {
    return <Navigate to="/" replace />;
  }

  if (!socket) {
    return (
      <div className="h-screen flex items-center justify-center font-bold text-slate-400 dark:bg-[#111215] transition-colors">
        Initialising real-time...
      </div>
    );
  }

  const contextValue: WorkspaceContextValue = {
    workspaceId,
    socket,
    channels,
    channelsLoading,
    onlineUsers,
    users,
    unreadCounts,
    clearUnread,
    fetchChannels,
    addChannel,
    startDM,
    startCall,
    hasActiveCall: !!activeCall,
    endActiveCall,
  };

  const currentChannel = channels.find(c => c.id === currentChannelId) ?? null;
  const activeView = activeViewFromPath(location.pathname, workspaceId);

  return (
    <WorkspaceContext.Provider value={contextValue}>
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-gradient-to-br from-gray-50 via-white to-gray-100 dark:bg-[#1A1D21] transition-all duration-300 text-gray-900 dark:text-gray-100 font-sans">
        {incomingCall && (
          <IncomingCallBanner
            callerName={incomingCall.callerName}
            callType={incomingCall.callType}
            onAccept={() => {
              setActiveCall({ channelId: incomingCall.channelId, callType: incomingCall.callType });
              setIncomingCall(null);
            }}
            onDecline={() => setIncomingCall(null)}
          />
        )}

        {activeCall && (
          <CallOverlay
            channelId={activeCall.channelId}
            callType={activeCall.callType}
            socket={socket}
            onEndCall={endActiveCall}
            workspaceId={workspaceId}
          />
        )}

        <Header onMenuClick={() => setIsSidebarOpen(!isSidebarOpen)} />

        <div className="flex flex-1 overflow-hidden relative">
          {isSidebarOpen && (
            <div
              className="fixed inset-0 bg-black/40 z-40 md:hidden backdrop-blur-sm animate-fade-in"
              onClick={() => setIsSidebarOpen(false)}
            />
          )}

          <WorkspaceSwitcher />

          <div className={`
            fixed md:relative inset-y-0 left-0 z-50 md:z-0
            transition-all duration-300 ease-out
            ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
            w-[280px] md:w-auto bg-slack-sidebar shadow-2xl md:shadow-none
          `}>
            <Sidebar
              channels={channels}
              dms={dms}
              currentChannel={currentChannel}
              unreadCounts={unreadCounts}
              onSelectChannel={(ch: Channel) => {
                navigate(`/${workspaceId}/c/${ch.id}`);
                setIsSidebarOpen(false);
              }}
              onlineUsers={onlineUsers}
              activeView={activeView}
              onViewChange={(view: string) => {
                // 'chat' fires alongside onSelectChannel right after it — the
                // channel selection itself does the navigating.
                if (view !== 'chat') navigate(`/${workspaceId}/${view}`);
                setIsSidebarOpen(false);
              }}
            />
          </div>

          <main className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-[#111215] md:rounded-tl-3xl shadow-professional-xl dark:shadow-[-10px_0_30px_rgba(0,0,0,0.5)] relative z-10 transition-all duration-300 border-l border-gray-200 dark:border-gray-800">
            <Outlet />
          </main>
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
};

export { LoadingScreen };
