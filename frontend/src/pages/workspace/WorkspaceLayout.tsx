import { LoadingScreen } from '../../components/ui/LoadingScreen';
import axios from 'axios';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBoundary } from '../../components/ui/ErrorBoundary';
import { toast } from 'react-toastify';
import { Navigate, Outlet, useLocation, useMatch, useNavigate, useParams } from 'react-router-dom';
import { CallOverlay, IncomingCallBanner } from '../../components/chat/CallOverlay';
import { Header } from '../../components/layout/Header';
import { Sidebar } from '../../components/sidebar/Sidebar';
import { WorkspaceSwitcher } from '../../components/sidebar/WorkspaceSwitcher';
import { useAuth } from '../../contexts/AuthContext';
import { useConnectionStatus, useSocket } from '../../hooks/useSocket';
import { activityApi } from '../../lib/api';
import { IncomingCall, parseCallDeclined, parseIncomingCall, parseRingEnded } from '../../lib/callSignalling';
import { htmlToText, truncate } from '../../lib/messages';
import { applyIncomingMessage, applyReadState, ReadStateMap, toReadStateMap, unreadCountsOf } from '../../lib/unread';
import { Channel, ReadState, User } from '../../types';
import { findConversation, WorkspaceContext, WorkspaceContextValue } from './WorkspaceContext';
import { useWorkspaceLiveUpdates, useWorkspaces } from './WorkspacesProvider';
import { CommandPalette } from '../../components/palette/CommandPalette';
import { CallLobby } from '../../components/chat/CallLobby';
import { MobileTabBar } from '../../components/mobile/MobileTabBar';
import { useAppHeight } from '../../hooks/useAppHeight';
import { isTabletWidth } from '../../hooks/useMediaQuery';
import type { CallMediaChoice } from '../../components/chat/CallOverlay';


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
  if (rest.startsWith('/projects')) return 'projects';
  if (rest.startsWith('/tasks')) return 'tasks';
  if (rest.startsWith('/team-tasks')) return 'team-tasks';
  if (rest.startsWith('/chats')) return 'chats';
  if (rest.startsWith('/calls')) return 'calls';
  if (rest.startsWith('/settings') || rest.startsWith('/organization')) return 'other';
  return 'chat';
};

export const WorkspaceLayout = () => {
  const { user, token } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const channelMatch = useMatch('/:workspaceId/c/:channelId');
  const socket = useSocket(token);
  const connectionStatus = useConnectionStatus(socket);
  // Shared workspace list (F1): live renames/role changes, one source of truth.
  const { getWorkspace, loading: workspacesLoading, refresh: refreshWorkspaces } = useWorkspaces();
  useWorkspaceLiveUpdates(socket, user?.id);
  // A workspace just created or joined may not be in the list yet — fetch it
  // once per workspace id (never in a loop).
  const refreshedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workspaceId || workspacesLoading || getWorkspace(workspaceId) || refreshedForRef.current === workspaceId) return;
    refreshedForRef.current = workspaceId;
    refreshWorkspaces()
      .then((list) => {
        // F2: still not there after an authoritative refresh — a stale link to
        // a workspace that was deleted/left, or one the user never belonged to
        // (e.g. an organization admin managing it from the organization page).
        // Same message either way, so nothing about it is revealed.
        if (!list.some((w) => w.id === workspaceId)) {
          toast.info("You don't have access to that workspace.");
          navigate('/', { replace: true });
        }
      })
      .catch(() => undefined);
  }, [workspaceId, workspacesLoading, getWorkspace, refreshWorkspaces, navigate]);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(true);
  // P2: which workspace the loaded `channels` / `dms` belong to. On a switch,
  // the first render still holds the previous workspace's lists — and child
  // effects (WorkspaceIndex's <Navigate>) run before the reset effect below,
  // so a loading flag set in an effect is too late. Comparing during render
  // closes that window: a list for another workspace counts as loading.
  const [channelsFor, setChannelsFor] = useState<string | null>(null);
  const [dmsFor, setDMsFor] = useState<string | null>(null);
  // Real, already-started 1:1 conversations — kept entirely separate from
  // `channels` now that the backend excludes DMs from that list (see
  // channels.service.ts's isDM fix). Sidebar renders these under "Direct
  // Messages" instead of the old (buggy) "every workspace user" list.
  const [dms, setDMs] = useState<Channel[]>([]);
  const [dmsLoading, setDMsLoading] = useState(true);
  // Latest lists for socket listeners, without re-registering them per render.
  const channelsRef = useRef<Channel[]>([]);
  const dmsRef = useRef<Channel[]>([]);
  channelsRef.current = channels;
  dmsRef.current = dms;
  // Counts server "subscriptions:ready" events for this socket. Kept outside
  // the listener effect, which re-registers on every channel switch.
  const subscriptionsReadyCountRef = useRef(0);
  // Server-persisted read state (GET /api/workspaces/:id/unread, `read:updated`)
  // plus optimistic live increments; unread badges are derived from it.
  const [readState, setReadState] = useState<ReadStateMap>({});
  const unreadCounts = useMemo(() => unreadCountsOf(readState), [readState]);
  const [onlineUsers, setOnlineUsers] = useState<User[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  // P3: unread @mentions/replies in this workspace — the Activity badge
  // (it used to total every unread message, which is what channel badges show).
  const [activityUnread, setActivityUnread] = useState(0);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  // T.39: tablets (768–1023px) can hide the sidebar for a full-width view; remembered per device.
  const [tabletSidebarHidden, setTabletSidebarHidden] = useState(() => {
    try {
      return localStorage.getItem('smartconnect:tablet-sidebar') === 'hidden';
    } catch {
      return false;
    }
  });
  const toggleTabletSidebar = () =>
    setTabletSidebarHidden((hidden) => {
      try {
        localStorage.setItem('smartconnect:tablet-sidebar', hidden ? 'shown' : 'hidden');
      } catch {
        // storage unavailable: the choice lasts for this page only
      }
      return !hidden;
    });
  // T.39: the shell follows the visible viewport (on-screen keyboards) below the desktop breakpoint.
  useAppHeight();
  // T.39: screens without the header's menu button (the phone's Chats tab) open the navigation drawer.
  useEffect(() => {
    const open = () => {
      setIsSidebarOpen(true);
      setTabletSidebarHidden(false);
    };
    window.addEventListener('smartconnect:open-navigation', open);
    return () => window.removeEventListener('smartconnect:open-navigation', open);
  }, []);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  // `outgoing`: this user started the call (rang the conversation), so ending
  // it also cancels the ring and a timeout/decline ends it (P2 Phase H).
  // T.33: a call opens in the pre-join lobby (stage 'lobby'), then goes live.
  const [activeCall, setActiveCall] = useState<{ channelId: string; callType: 'audio' | 'video'; outgoing?: boolean; stage: 'lobby' | 'live'; media?: CallMediaChoice } | null>(null);
  const activeCallRef = useRef(activeCall);

  const currentChannelId = channelMatch?.params.channelId;

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  // T.32 (audit FE-6): responses for a workspace the user has already left
  // (fast switching) are ignored instead of overwriting the current lists.
  const currentWorkspaceRef = useRef(workspaceId);
  currentWorkspaceRef.current = workspaceId;
  const fetchChannels = useCallback((onComplete?: (chans: Channel[]) => void) => {
    if (!token || !workspaceId) return;
    const forWorkspace = workspaceId;
    axios.get<Channel[]>(`/api/workspaces/${workspaceId}/channels`)
      .then(res => {
        if (currentWorkspaceRef.current !== forWorkspace) return;
        setChannels(res.data);
        setChannelsFor(forWorkspace);
        onComplete?.(res.data);
      })
      .catch(err => {
        if (currentWorkspaceRef.current !== forWorkspace) return;
        console.error('fetchChannels error:', err);
        // Still resolve onComplete on failure — callers (notably the
        // channelsLoading reset below) need to know the fetch settled one
        // way or the other, not just on success.
        setChannelsFor(forWorkspace);
        onComplete?.([]);
      });
  }, [token, workspaceId]);

  const addChannel = useCallback((channel: Channel) => {
    setChannels(prev => (prev.some(c => c.id === channel.id) ? prev : [...prev, channel]));
  }, []);

  const fetchDMs = useCallback(() => {
    if (!token || !workspaceId) return;
    const forWorkspace = workspaceId;
    axios.get<Channel[]>(`/api/workspaces/${workspaceId}/dms`)
      .then(res => {
        if (currentWorkspaceRef.current === forWorkspace) setDMs(res.data);
      })
      .catch(err => console.error('fetchDMs error:', err))
      .finally(() => {
        if (currentWorkspaceRef.current !== forWorkspace) return;
        setDMsFor(forWorkspace);
        setDMsLoading(false);
      });
  }, [token, workspaceId]);

  // Inserts/replaces a DM and keeps the list ordered by recent activity.
  const upsertDM = useCallback((dm: Channel) => {
    setDMs(prev => {
      const existing = prev.find(d => d.id === dm.id);
      const merged = existing ? { ...existing, ...dm } : dm;
      const next = [merged, ...prev.filter(d => d.id !== dm.id)];
      return next.sort((a, b) =>
        new Date(b.lastActivityAt ?? b.createdAt ?? 0).getTime() - new Date(a.lastActivityAt ?? a.createdAt ?? 0).getTime()
      );
    });
  }, []);

  const startDM = useCallback(async (userId: string) => {
    try {
      // Added to local state before navigating so ChannelPage can resolve the
      // conversation immediately (it looks in both channels and DMs).
      const res = await axios.post<Channel>('/api/channels/dm', { targetUserId: userId, workspaceId });
      upsertDM({ ...res.data, isDM: true, lastActivityAt: res.data.lastActivityAt ?? new Date().toISOString() });
      navigate(`/${workspaceId}/c/${res.data.id}`);
      fetchDMs();
    } catch (err) {
      console.error('Failed to start DM:', err);
      toast.error((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not open that conversation.');
    }
  }, [fetchDMs, navigate, upsertDM, workspaceId]);

  // FA-RT-02: the server derives the caller's name from the authenticated
  // socket, so only the channel and call type are sent.
  // T.33: ringing starts when the caller leaves the lobby (joinActiveCall).
  const startCall = useCallback((channelId: string, callType: 'audio' | 'video') => {
    setActiveCall({ channelId, callType, outgoing: true, stage: 'lobby' });
  }, []);

  const joinActiveCall = useCallback((media: CallMediaChoice) => {
    setActiveCall((current) => {
      if (!current || current.stage !== 'lobby') return current;
      if (current.outgoing) socket?.emit('call:initiate', { channelId: current.channelId, callType: current.callType });
      return { ...current, stage: 'live', media };
    });
  }, [socket]);

  // Properly tears down a call rather than just clearing local state — tells
  // the backend this socket left the call room (so other participants get
  // webrtc:peer-left promptly instead of waiting for a disconnect timeout).
  // Used both by CallOverlay's own "end call" button (via onEndCall) and by
  // WorkspaceSwitcher when a workspace switch requires ending the call first.
  const endActiveCall = useCallback(() => {
    setActiveCall((current) => {
      if (current?.stage === 'live') {
        socket?.emit('webrtc:leave', { channelId: current.channelId });
        // Stop ringing everyone else (the server ignores this if the ring
        // already ended or wasn't ours).
        if (current.outgoing) socket?.emit('call:cancel', { channelId: current.channelId });
      } else if (current && !current.outgoing) {
        // Answered, then backed out of the lobby: that is a decline.
        socket?.emit('call:decline', { channelId: current.channelId });
      }
      return null;
    });
  }, [socket]);

  // P2 Phase H: ringing lifecycle. A ring that ends (cancelled, timed out,
  // declined in a 1:1 DM, answered on another device) dismisses the banner;
  // the caller's own call ends when nobody answered or the DM was declined.
  useEffect(() => {
    if (!socket) return;
    const onRingEnded = (data: unknown) => {
      const ended = parseRingEnded(data);
      if (!ended) return;
      setIncomingCall((current) => (current?.channelId === ended.channelId ? null : current));
      const call = activeCallRef.current;
      if (call?.outgoing && call.channelId === ended.channelId && (ended.reason === 'timeout' || ended.reason === 'declined')) {
        if (ended.reason === 'timeout') toast.info('No one answered the call.');
        endActiveCall();
      }
      // T.33: the caller hung up while this person was still in the lobby.
      if (call && !call.outgoing && call.stage === 'lobby' && call.channelId === ended.channelId && (ended.reason === 'cancelled' || ended.reason === 'timeout')) {
        toast.info('The call ended before you joined.');
        setActiveCall(null);
      }
    };
    const onDeclined = (data: unknown) => {
      const declined = parseCallDeclined(data);
      if (declined && activeCallRef.current?.channelId === declined.channelId) toast.info(`${declined.username} declined the call.`);
    };
    socket.on('call:ring_ended', onRingEnded);
    socket.on('call:declined', onDeclined);
    return () => {
      socket.off('call:ring_ended', onRingEnded);
      socket.off('call:declined', onDeclined);
    };
  }, [socket, endActiveCall]);

  // Fallback: never leave a banner ringing forever if the server's
  // ring-ended event is lost (e.g. a reconnect mid-ring).
  useEffect(() => {
    if (!incomingCall) return;
    const timer = setTimeout(() => setIncomingCall(null), 60_000);
    return () => clearTimeout(timer);
  }, [incomingCall]);

  const fetchReadState = useCallback(() => {
    if (!token || !workspaceId) return;
    axios.get<{ channels: ReadState[] }>(`/api/workspaces/${workspaceId}/unread`)
      .then(res => setReadState(toReadStateMap(res.data.channels)))
      .catch(err => console.error('fetchReadState error:', err));
  }, [token, workspaceId]);

  // Optimistic local zero (e.g. the instant a conversation is opened).
  const clearUnread = useCallback((channelId: string) => {
    setReadState(prev => (prev[channelId]?.unreadCount ? { ...prev, [channelId]: { ...prev[channelId], unreadCount: 0 } } : prev));
  }, []);

  // Persists the read position on the server; the response (and the
  // `read:updated` event every other tab/device receives) is authoritative.
  const markChannelRead = useCallback((channelId: string, messageId?: string) => {
    clearUnread(channelId);
    axios.post<ReadState>(`/api/channels/${channelId}/read`, messageId ? { messageId } : {})
      .then(res => setReadState(prev => applyReadState(prev, res.data)))
      .catch(err => console.warn('markChannelRead failed:', err));
  }, [clearUnread]);

  const removeConversation = useCallback((channelId: string) => {
    setChannels(prev => prev.filter(c => c.id !== channelId));
    setDMs(prev => prev.filter(d => d.id !== channelId));
    setReadState(prev => {
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
    setDMsLoading(true);
    setChannels([]);
    setDMs([]);
    setReadState({});
    fetchChannels(() => setChannelsLoading(false));
    fetchDMs();
    fetchReadState();
    if (token) {
      axios.get<User[]>('/api/users').then(res => setUsers(res.data)).catch(() => undefined); // T.32: a failed directory load must not surface as an unhandled rejection
    }
  }, [token, fetchChannels, fetchDMs, fetchReadState]);

  // Coming back to the tab: re-sync read state (other devices may have read
  // conversations meanwhile; live increments may have drifted while hidden).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchReadState();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchReadState]);

  // Fire-and-forget: keeps User.lastActiveWorkspaceId in sync so a future
  // login/signup lands the user back here instead of always defaulting to
  // their first workspace (see WorkspaceRedirect.tsx). Not critical-path —
  // a failure here shouldn't block or error out the workspace switch itself.
  const { setLastActiveWorkspace } = useAuth();
  useEffect(() => {
    if (!token || !workspaceId) return;
    axios.patch('/api/users/me/active-workspace', { workspaceId }).catch(() => {});
    // P2: and the in-session copy, so "/" (e.g. after this workspace is
    // deleted) lands on the right fallback instead of a login-time value.
    setLastActiveWorkspace?.(workspaceId);
  }, [token, workspaceId, setLastActiveWorkspace]);

  useEffect(() => {
    if (!socket) return;

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

    // FA-RT-02: a malformed ring (no valid channel or call type) is ignored
    // instead of reaching the banner or, on Accept, the call overlay.
    const handleIncomingCall = (data: unknown) => {
      const call = parseIncomingCall(data);
      if (call && !activeCallRef.current) {
        setIncomingCall(call);
      }
    };
    // Every authorized channel room is subscribed server-side now, so this
    // fires for all of the user's conversations, not just the open one.
    const requestedUnknown = new Set<string>();
    const handleNewMessage = (msg: {
      id: string;
      senderId: string;
      channelId: string;
      workspaceId?: string;
      parentId?: string | null;
      content?: string | null;
      fileName?: string | null;
      createdAt: string;
    }) => {
      // P3: rooms of the user's OTHER workspaces are subscribed too; their
      // traffic must neither refetch here nor count toward this workspace's
      // unread badges.
      if (msg.workspaceId && msg.workspaceId !== workspaceId) return;
      const knownChannel = channelsRef.current.some(c => c.id === msg.channelId);
      const knownDM = dmsRef.current.find(d => d.id === msg.channelId);
      if (!knownChannel && !knownDM && !requestedUnknown.has(msg.channelId)) {
        // A conversation we haven't loaded yet (e.g. someone just DMed us) —
        // loaded once, not once per message.
        requestedUnknown.add(msg.channelId);
        fetchDMs();
      }
      if (msg.parentId) return; // thread replies don't bump channel unread counts
      if (knownDM) {
        const text = htmlToText(msg.content);
        upsertDM({
          ...knownDM,
          lastMessage: {
            id: msg.id,
            preview: text ? truncate(text, 140) : msg.fileName ? `Attachment: ${msg.fileName}` : 'Message',
            senderId: msg.senderId,
            createdAt: msg.createdAt,
          },
          lastActivityAt: msg.createdAt,
        });
      }
      setReadState(prev =>
        applyIncomingMessage(prev, msg, {
          currentUserId: user?.id,
          activeChannelId: currentChannelId,
          isViewing: document.visibilityState === 'visible',
        })
      );
    };
    // Another tab/device (or this one) advanced a read position.
    const handleReadUpdated = (state: ReadState) => setReadState(prev => applyReadState(prev, state));
    // Group DM renamed / participants changed.
    const handleConversationUpdated = (conversation: Channel) => {
      if (conversation.workspaceId && conversation.workspaceId !== workspaceId) return;
      if (conversation.isDM) upsertDM(conversation);
    };
    // Left, or removed from, a channel or group DM — access is already gone.
    const handleConversationRemoved = ({ channelId }: { channelId: string }) => {
      const wasOpen = currentChannelId === channelId;
      removeConversation(channelId);
      if (wasOpen) {
        toast.info('You no longer have access to that conversation.');
        navigate(`/${workspaceId}`, { replace: true });
      }
    };
    const handleWorkspaceRemoved = ({ workspaceId: removedId, reason }: { workspaceId: string; reason: string }) => {
      if (removedId !== workspaceId) return;
      toast.info(
        reason === 'deleted' ? 'This workspace was deleted.' : reason === 'left' ? 'You left the workspace.' : 'You were removed from this workspace.'
      );
      navigate('/', { replace: true });
    };
    // Batch 3/D: settings/type/archive changes for a channel in this list.
    const handleChannelUpdated = ({ channel: updated }: { channel: Channel & { archived?: boolean } }) => {
      if (updated.workspaceId && updated.workspaceId !== workspaceId) return;
      setChannels(prev =>
        prev.map(c =>
          c.id === updated.id
            ? {
                ...c,
                name: updated.name,
                description: updated.description,
                topic: updated.topic,
                icon: updated.icon,
                visibility: updated.visibility,
                isAnnouncement: updated.isAnnouncement,
                archivedAt: updated.archivedAt ?? null,
                projectId: updated.projectId ?? null,
              }
            : c
        )
      );
    };
    const handleDMCreated = (dm: Channel) => {
      if (dm.workspaceId && dm.workspaceId !== workspaceId) return;
      upsertDM({ ...dm, isDM: true });
    };
    // Fires after every (re)connection once the server has re-subscribed the
    // socket. On reconnects, catch up on membership changes made meanwhile.
    const handleSubscriptionsReady = () => {
      subscriptionsReadyCountRef.current += 1;
      if (subscriptionsReadyCountRef.current > 1) {
        fetchChannels();
        fetchDMs();
        fetchReadState();
        refreshWorkspaces().catch(() => undefined);
      }
    };

    socket.on('channel:member_added', handleChannelMemberAdded);
    socket.on('presence:init', handlePresenceInit);
    socket.on('user:online', handleUserOnline);
    socket.on('user:offline', handleUserOffline);
    socket.on('call:incoming', handleIncomingCall);
    socket.on('message:received', handleNewMessage);
    socket.on('dm:created', handleDMCreated);
    socket.on('subscriptions:ready', handleSubscriptionsReady);
    socket.on('read:updated', handleReadUpdated);
    socket.on('conversation:updated', handleConversationUpdated);
    socket.on('conversation:removed', handleConversationRemoved);
    socket.on('workspace:removed', handleWorkspaceRemoved);
    socket.on('channel:updated', handleChannelUpdated);

    return () => {
      socket.off('channel:member_added', handleChannelMemberAdded);
      socket.off('presence:init', handlePresenceInit);
      socket.off('user:online', handleUserOnline);
      socket.off('user:offline', handleUserOffline);
      socket.off('call:incoming', handleIncomingCall);
      socket.off('message:received', handleNewMessage);
      socket.off('dm:created', handleDMCreated);
      socket.off('subscriptions:ready', handleSubscriptionsReady);
      socket.off('read:updated', handleReadUpdated);
      socket.off('conversation:updated', handleConversationUpdated);
      socket.off('conversation:removed', handleConversationRemoved);
      socket.off('workspace:removed', handleWorkspaceRemoved);
      socket.off('channel:updated', handleChannelUpdated);
    };
  }, [socket, currentChannelId, user, workspaceId, addChannel, fetchChannels, fetchDMs, fetchReadState, upsertDM, removeConversation, navigate, refreshWorkspaces]);

  useEffect(() => {
    if (!workspaceId || !token) return;
    let cancelled = false;
    setActivityUnread(0);
    const load = () =>
      activityApi
        .listNotifications(workspaceId)
        .then((res) => {
          if (!cancelled) setActivityUnread(res.unreadCount);
        })
        .catch(() => undefined);
    void load();
    if (!socket) return () => { cancelled = true; };
    const onNew = (n: { workspaceId?: string; isRead?: boolean } | null) => {
      if (n?.workspaceId === workspaceId && !n.isRead) setActivityUnread((count) => count + 1);
    };
    // After a reconnect, catch up on anything that arrived while offline.
    const onReady = () => void load();
    socket.on('notification:new', onNew);
    socket.on('subscriptions:ready', onReady);
    return () => {
      cancelled = true;
      socket.off('notification:new', onNew);
      socket.off('subscriptions:ready', onReady);
    };
  }, [workspaceId, token, socket]);

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
    connectionStatus,
    channels,
    channelsLoading: channelsLoading || channelsFor !== workspaceId,
    dms,
    dmsLoading: dmsLoading || dmsFor !== workspaceId,
    onlineUsers,
    users,
    readState,
    unreadCounts,
    activityUnread,
    setActivityUnread,
    clearUnread,
    markChannelRead,
    fetchChannels,
    fetchDMs,
    upsertDM,
    removeConversation,
    addChannel,
    startDM,
    startCall,
    hasActiveCall: !!activeCall,
    endActiveCall,
  };

  const currentChannel = findConversation(channels, dms, currentChannelId);
  const activeView = activeViewFromPath(location.pathname, workspaceId);
  // T.39: a conversation fills a phone's screen (no app header, no tab bar).
  const isConversation = location.pathname.startsWith(`/${workspaceId}/c/`);
  const chatsUnread = [...channels, ...dms].reduce((sum, c) => sum + (unreadCounts[c.id] ?? 0), 0);

  return (
    <WorkspaceContext.Provider value={contextValue}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-sidebar font-sans text-fg max-lg:h-[var(--app-height,100dvh)]">
        {incomingCall && (
          <IncomingCallBanner
            callerName={incomingCall.callerName}
            callType={incomingCall.callType}
            onAccept={() => {
              setActiveCall({ channelId: incomingCall.channelId, callType: incomingCall.callType, outgoing: false, stage: 'lobby' });
              setIncomingCall(null);
            }}
            onDecline={() => {
              socket?.emit('call:decline', { channelId: incomingCall.channelId });
              setIncomingCall(null);
            }}
          />
        )}

        {activeCall?.stage === 'lobby' && (
          <CallLobby
            callType={activeCall.callType}
            title={`${activeCall.callType === 'video' ? 'Video' : 'Audio'} call · ${findConversation(channels, dms, activeCall.channelId)?.name ?? 'conversation'}`}
            joinLabel={activeCall.outgoing ? 'Start call' : 'Join call'}
            onJoin={joinActiveCall}
            onCancel={endActiveCall}
          />
        )}

        {activeCall?.stage === 'live' && (
          <CallOverlay
            channelId={activeCall.channelId}
            callType={activeCall.callType}
            socket={socket}
            onEndCall={endActiveCall}
            workspaceId={workspaceId}
            initialMedia={activeCall.media}
          />
        )}

        {/* T.33: ⌘K command palette — search and jump anywhere in the workspace. */}
        {workspaceId && <CommandPalette workspaceId={workspaceId} onMessagePerson={startDM} />}

        <Header
          onMenuClick={() => (isTabletWidth() ? toggleTabletSidebar() : setIsSidebarOpen(!isSidebarOpen))}
          hideOnPhone={isConversation}
          sidebarHidden={tabletSidebarHidden}
          searchScope={currentChannel ? { id: currentChannel.id, name: currentChannel.name, isDM: !!currentChannel.isDM } : null}
        />

        {connectionStatus !== 'connected' && (
          <div
            role="status"
            aria-live="polite"
            className={`shrink-0 px-4 py-1.5 text-center text-xs font-semibold ${
              connectionStatus === 'offline' ? 'bg-red-600 text-white' : 'bg-amber-100 text-amber-900'
            }`}
          >
            {connectionStatus === 'offline'
              ? "You're offline. Messages you send will be delivered when you reconnect."
              : connectionStatus === 'connecting'
                ? 'Connecting to SmartConnect…'
                : 'Connection lost. Reconnecting…'}
          </div>
        )}

        <div className="flex flex-1 overflow-hidden relative">
          {isSidebarOpen && (
            <div
              className="fixed inset-0 bg-black/40 z-40 md:hidden backdrop-blur-sm animate-fade-in"
              onClick={() => setIsSidebarOpen(false)}
            />
          )}

          {/* P3: on phones the workspace rail lives in the navigation drawer with
              the sidebar instead of permanently taking 68px of the screen. */}
          <div className={`
            fixed md:relative top-[calc(3rem+env(safe-area-inset-top))] bottom-0 md:top-auto md:bottom-auto left-0 z-50 md:z-0 flex
            ${isConversation ? 'max-md:top-0' : ''} ${tabletSidebarHidden ? 'md:max-lg:hidden' : ''}
            transition-transform duration-300 ease-out
            ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
            w-[min(348px,calc(100vw-48px))] md:w-auto bg-sidebar ${isSidebarOpen ? 'shadow-2xl' : 'shadow-none'} md:shadow-none
          `}>
            <WorkspaceSwitcher />
            <div className="flex-1 min-w-0 md:flex-none md:w-60 lg:w-64 xl:w-72">
            <Sidebar
              channels={channels}
              dms={dms}
              currentChannel={currentChannel}
              activityUnread={activityUnread}
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
          </div>

          <main className="relative z-10 flex flex-1 min-w-0 flex-col overflow-hidden bg-surface md:rounded-tl-xl md:border-l md:border-t border-line">
            {/* T.32: a page chunk loading or failing stays inside the content area —
                the sidebar, header and any live call are unaffected. */}
            <ErrorBoundary region="this page" resetKey={location.pathname}>
              <Suspense fallback={<PageSkeleton />}>
                <Outlet />
              </Suspense>
            </ErrorBoundary>
          </main>
        </div>
        {/* T.39: the phone tab bar (hidden on tablets/desktop by its own md:hidden). */}
        {!isConversation && (
          <MobileTabBar
            activeView={activeView}
            chatsUnread={chatsUnread}
            activityUnread={activityUnread}
            onNavigate={(view) => {
              setIsSidebarOpen(false);
              navigate(`/${workspaceId}/${view}`);
            }}
          />
        )}
      </div>
    </WorkspaceContext.Provider>
  );
};

/** Content-area placeholder while a page chunk loads (layout-matched, no spinner). */
const PageSkeleton = () => (
  <div className="flex h-full flex-col" role="status" aria-label="Loading">
    <div className="flex h-14 items-center gap-3 border-b border-line px-5">
      <div className="skeleton h-4 w-40 rounded-md" />
    </div>
    <div className="flex-1 space-y-5 p-5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex gap-3">
          <div className="skeleton h-9 w-9 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3 w-32 rounded" />
            <div className="skeleton h-3 rounded" style={{ width: `${70 - i * 12}%` }} />
          </div>
        </div>
      ))}
    </div>
  </div>
);

// Kept for existing imports; the screen itself lives in components/ui (T.32).
export { LoadingScreen };
