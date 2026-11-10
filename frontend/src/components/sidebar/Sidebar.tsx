import { Bell, Building2, ChevronDown, Hash, Home, LayoutGrid, Lock, LogOut, MessageSquare, MoreHorizontal, Plus, Settings, Trash2, UserRoundX, Users } from 'lucide-react';
import { useHierarchy } from '../../hooks/useHierarchy';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NewConversationModal } from '../conversations/NewConversationModal';
import { formatUnread } from '../../lib/unread';
import { isSidebarVisible } from '../../lib/channels';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../pages/workspace/WorkspaceContext';
import { useWorkspaces } from '../../pages/workspace/WorkspacesProvider';
import { useLeaveWorkspace } from '../../pages/workspace/useWorkspaceActions';
import { Channel, Workspace } from '../../types';
import { CreateChannelModal } from './CreateChannelModal';
import { DeleteWorkspaceModal } from './DeleteWorkspaceModal';

export const Sidebar = ({
  channels,
  dms = [],
  currentChannel,
  onSelectChannel,
  unreadCounts = {},
  activityUnread = 0,
  onlineUsers = [],
  activeView,
  onViewChange,
}: any) => {
  const { user, logout } = useAuth();
  const { workspaceId, startDM, upsertDM } = useWorkspace();
  const navigate = useNavigate();
  const [composing, setComposing] = useState(false);

  const [collapsedChannels, setCollapsedChannels] = useState(false);
  const [collapsedDMs, setCollapsedDMs] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  // Shared, live workspace list (F1) instead of a private GET /api/workspaces.
  const { getWorkspace } = useWorkspaces();
  const workspace: Workspace | null = getWorkspace(workspaceId) ?? null;
  const { leave, dialog: confirmDialog } = useLeaveWorkspace();

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(e.target as Node)) {
        setShowWorkspaceMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // An owner's own membership row is always created with role 'ADMIN' (see
  // workspaces.service.ts's createWorkspace), so checking myRole alone covers
  // both "is the owner" and "is an admin" for this UI-visibility decision —
  // the backend re-verifies the real ownerId-or-admin check independently.
  // Batch 3/E: deletion is owner-level (lib/policy 'workspace.delete'); use the
  // server's answer rather than guessing from the role.
  const canDeleteWorkspace = workspace?.capabilities ? !!workspace.capabilities.canDelete : workspace?.myRole === 'ADMIN';
  // The owner can't leave (delete instead); nobody can leave the default workspace.
  const canLeaveWorkspace = !!workspace && !workspace.isDefault && workspace.ownerId !== user?.id && !!workspace.myRole;

  // F2: every member can open the workspace settings (read-only unless the
  // server says they may edit) and its organization page.
  const hasWorkspaceActions = !!workspace;

  const openPage = (path: string) => {
    setShowWorkspaceMenu(false);
    navigate(`/${workspaceId}/${path}`);
  };

  // Shared flow (F2): confirmation → leave → drop from the shared list → "/".
  const leaveWorkspace = async () => {
    if (!workspace) return;
    setShowWorkspaceMenu(false);
    await leave(workspace);
  };

  // P3: DMs shows unread direct messages; Activity shows unread mentions and
  // replies (what the Activity feed lists). Channels carry their own badges.
  const dmUnreads = (dms as Channel[]).reduce((acc, dm) => acc + (unreadCounts[dm.id] ?? 0), 0);


  // `view` is where the item goes when it differs from its id (P3: "People"
  // opens the directory's People tab, not its default Channels tab).
  const hierarchy = useHierarchy();
  const navItems: { id: string, label: string, icon: any, badge: number, view?: string }[] = [
    { id: 'home', label: 'Home', icon: Home, badge: 0 },
    { id: 'dms', label: 'DMs', icon: MessageSquare, badge: dmUnreads },
    { id: 'activity', label: 'Activity', icon: Bell, badge: activityUnread },
    { id: 'directory', label: 'People', icon: Users, badge: 0, view: 'directory?tab=People' },
    { id: 'more', label: 'More', icon: MoreHorizontal, badge: 0 },
    // Stage 3 (T.22): Team Leads get their workspaces dashboard.
    ...(hierarchy?.role === 'TEAM_LEAD' ? [{ id: 'my-workspaces', label: 'My Workspaces', icon: LayoutGrid, badge: 0 }] : []),
  ];

  const currentUserOnlineData = onlineUsers.find((ou: any) => ou.id === user?.id);
  // Header sends 'active' | 'away' | 'in_meeting' (the old check for 'busy'
  // could never match, so the busy indicator never showed).
  const isBusyStatus = (status?: string) => status === 'in_meeting' || status === 'busy';
  const currentUserBusy = isBusyStatus(currentUserOnlineData?.status);

  return (
    <div className="w-full h-full bg-gradient-to-b from-violet-950 to-violet-900 text-violet-200 flex flex-col shrink-0 overflow-hidden shadow-2xl">
      {/* Workspace Header */}
      <div className="relative" ref={workspaceMenuRef}>
        <div
          onClick={() => hasWorkspaceActions && setShowWorkspaceMenu((v) => !v)}
          onKeyDown={(e) => {
            if (hasWorkspaceActions && (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
              e.preventDefault();
              setShowWorkspaceMenu((v) => !v);
            }
          }}
          role={hasWorkspaceActions ? 'button' : undefined}
          tabIndex={hasWorkspaceActions ? 0 : undefined}
          aria-haspopup={hasWorkspaceActions ? 'menu' : undefined}
          aria-expanded={hasWorkspaceActions ? showWorkspaceMenu : undefined}
          aria-label={hasWorkspaceActions ? `${workspace?.name ?? 'Workspace'} options` : undefined}
          className={`h-[60px] flex items-center justify-between px-5 transition-all group border-b border-white/10 shadow-md ${hasWorkspaceActions ? 'hover:bg-white/5 cursor-pointer' : ''}`}
        >
          <div className="flex items-center gap-3 text-white overflow-hidden">
            <div className="w-9 h-9 bg-white/10 rounded-lg flex items-center justify-center shrink-0 border border-white/15 group-hover:bg-white/15 transition-all shadow-md backdrop-blur-sm">
              <span className="font-black text-base tracking-tighter">{workspace?.name?.[0]?.toUpperCase() || 'S'}</span>
            </div>
            <div className="flex flex-col min-w-0">
              <span className="font-black text-[16px] truncate tracking-tight">{workspace?.name || 'Workspace'}</span>
              <span className="text-[10px] text-violet-300/70 font-medium uppercase tracking-wider">
                {workspace?._count?.members ?? 0} members
              </span>
            </div>
            {hasWorkspaceActions && (
              <ChevronDown
                size={16}
                aria-hidden="true"
                className={`text-violet-300/50 group-hover:text-white transition-all ml-auto shrink-0 ${showWorkspaceMenu ? 'rotate-180' : ''}`}
              />
            )}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); logout(); }}
            className="p-2 hover:bg-red-500/20 rounded-lg transition-all text-violet-300/60 hover:text-red-300 hover:scale-110 active:scale-95"
            title="Sign out"
          >
            <LogOut size={18} />
          </button>
        </div>

        {showWorkspaceMenu && hasWorkspaceActions && (
          <div className="absolute top-full left-3 right-3 mt-1.5 bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-150">
            <div className="px-4 py-3 border-b border-gray-100">
              <div className="text-xs font-black text-gray-400 uppercase tracking-widest">Workspace</div>
              <div className="text-sm font-bold text-gray-900 truncate mt-0.5">{workspace?.name}</div>
            </div>
            <div className="p-1.5">
              <button
                onClick={() => openPage('settings')}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg text-sm font-bold text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <Settings size={15} />
                Workspace settings
              </button>
              {workspace?.organization && (
                <button
                  onClick={() => openPage('organization')}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg text-sm font-bold text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <Building2 size={15} />
                  <span className="truncate">Organization · {workspace.organization.name}</span>
                </button>
              )}
              {canLeaveWorkspace && (
                <button
                  onClick={leaveWorkspace}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg text-sm font-bold text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <UserRoundX size={15} />
                  Leave Workspace
                </button>
              )}
              {canDeleteWorkspace && (
                <button
                  onClick={() => { setShowWorkspaceMenu(false); setShowDeleteConfirm(true); }}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg text-sm font-bold text-red-600 hover:bg-red-50 transition-colors"
                >
                  <Trash2 size={15} />
                  Delete Workspace
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {workspace && (
        <DeleteWorkspaceModal
          isOpen={showDeleteConfirm}
          onClose={() => setShowDeleteConfirm(false)}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
        />
      )}
      {confirmDialog}

      <div className="flex-1 overflow-y-auto sidebar-scrollbar py-3 px-3">
        {/* Main Menu Items */}
        <div className="space-y-1 mb-6">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={activeView === item.id ? 'page' : undefined}
              onClick={() => onViewChange(item.view ?? item.id)}
              className={`w-full flex items-center gap-3 pl-3.5 pr-4 py-2.5 rounded-lg transition-all text-[15px] font-semibold relative group border-l-2 ${
                activeView === item.id
                  ? 'bg-white/10 text-white border-white'
                  : 'border-transparent hover:bg-white/5 text-violet-200/80 hover:text-white'
              }`}
            >
              <item.icon
                size={20}
                className={`${activeView === item.id ? 'text-white' : 'text-violet-300/60 group-hover:text-white/90'} transition-colors`}
              />
              <span>{item.label}</span>
              {(item.badge ?? 0) > 0 && (
                <span className="absolute right-3 min-w-[20px] h-[20px] bg-red-500 text-white text-[10px] font-black rounded-full flex items-center justify-center px-1.5 shadow-md border border-white/10">
                  {formatUnread(item.badge)}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Channels Section */}
        <div className="mb-5">
          <div className="flex items-center group px-2 mb-2 h-9">
            <button
              onClick={() => setCollapsedChannels(!collapsedChannels)}
              className="p-1.5 hover:bg-white/10 rounded-lg transition-all"
            >
              <ChevronDown
                size={14}
                className={`text-violet-300/60 transition-transform ${collapsedChannels ? '-rotate-90' : ''}`}
              />
            </button>
            <span className="text-[13px] font-bold text-violet-300/70 flex-1 px-2 cursor-default tracking-wide uppercase">Channels</span>
            <button
              onClick={() => setShowCreateChannel(true)}
              className="p-1.5 opacity-0 group-hover:opacity-100 hover:bg-white/10 rounded-lg transition-all text-violet-300/60 hover:text-white active:scale-95"
              title="Create a channel"
            >
              <Plus size={16} />
            </button>
          </div>

          {!collapsedChannels && (
            <div className="space-y-0.5" role="group" aria-label="Channels">
              {/* Defensive filter — the backend already excludes DMs from
                  this list (see channels.service.ts), but this section
                  should never render one even if a future caller passes a
                  mixed list. */}
              {channels.filter((ch: Channel) => !ch.isDM && isSidebarVisible(ch, currentChannel?.id)).map((ch: Channel) => {
                const unreadCount = unreadCounts[ch.id] || 0;
                const isActive = activeView === 'chat' && currentChannel?.id === ch.id;

                return (
                  <button
                    key={ch.id}
                    onClick={() => {
                      onViewChange('chat');
                      onSelectChannel(ch);
                    }}
                    className={`w-full text-left flex items-center gap-2.5 pl-3.5 pr-4 py-2 rounded-lg transition-all text-[14px] relative group border-l-2 ${
                      isActive
                        ? 'bg-white/10 text-white font-bold border-white'
                        : unreadCount > 0
                          ? 'text-white font-bold bg-white/5 border-transparent'
                          : 'border-transparent hover:bg-white/5 text-violet-200/80 hover:text-white'
                    }`}
                  >
                    <span className="w-[18px] h-[18px] shrink-0 flex items-center justify-center text-[15px] leading-none">
                      {ch.icon && ch.icon !== 'hash' ? (
                        <span>{ch.icon}</span>
                      ) : ch.visibility === 'PRIVATE' ? (
                        <Lock size={16} className="text-violet-400" aria-label="Private channel" />
                      ) : (
                        <Hash size={18} className="text-violet-400" />
                      )}
                    </span>
                    <span className="truncate flex-1">{ch.name}</span>



                    {unreadCount > 0 && !isActive && (
                      <span className="min-w-6 px-1 h-[20px] bg-red-500 text-white text-[10px] font-black rounded-full flex items-center justify-center border border-white/10 shadow-md ml-1">
                        {formatUnread(unreadCount)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Direct Messages Section */}
        <div className="mb-4">
          <div className="flex items-center group px-3 mb-1 h-8">
            <button
              onClick={() => setCollapsedDMs(!collapsedDMs)}
              className="p-1 hover:bg-white/10 rounded transition-colors"
            >
              <ChevronDown size={12} className={`text-violet-300/50 transition-transform ${collapsedDMs ? '-rotate-90' : ''}`} />
            </button>
            <span className="text-[13px] font-medium text-violet-300/60 flex-1 px-1 cursor-default">Direct Messages</span>
            <button
              onClick={() => setComposing(true)}
              className="p-1 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-white/10 rounded transition-all text-violet-300/60 hover:text-white"
              title="Start a new conversation"
              aria-label="Start a new conversation"
            >
              <Plus size={16} />
            </button>
          </div>

          {!collapsedDMs && (
            <div className="px-3 space-y-0.5" role="group" aria-label="Direct messages">
              {/* Only real, already-started conversations — a DM channel row
                  only ever exists because someone explicitly clicked
                  "Message" on another person (see findOrCreateDM), so there's
                  no "unstarted conversation" clutter to additionally filter
                  out here. Defensively excludes the caller's own id in case a
                  legacy/degenerate self-DM row ever exists. */}
              {dms.filter((dm: Channel) => dm.isGroupDM || (dm.otherUserId && dm.otherUserId !== user?.id)).map((dm: Channel) => {
                const isActive = activeView === 'chat' && currentChannel?.id === dm.id;
                const unreadCount = unreadCounts[dm.id] || 0;
                const isGroup = !!dm.isGroupDM;
                const userOnlineData = isGroup ? undefined : onlineUsers.find((ou: any) => ou.id === dm.otherUserId);
                const isOnline = !!userOnlineData;
                const isBusy = isBusyStatus(userOnlineData?.status);

                return (
                  <div
                    key={dm.id}
                    onClick={() => {
                      onViewChange('chat');
                      onSelectChannel(dm);
                    }}
                    className={`flex items-center gap-2.5 px-3 py-1.5 text-[14px] rounded-md cursor-pointer transition-all group/dm ${
                      isActive ? 'bg-white/10' : 'hover:bg-white/5'
                    }`}
                  >
                    <div className="relative shrink-0">
                      <div className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center text-[11px] font-black text-white shrink-0 group-hover/dm:bg-white/15 transition-colors border border-white/5">
                        {isGroup ? <Users size={13} /> : dm.name?.[0]?.toUpperCase()}
                      </div>
                      {!isGroup && (
                        <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-violet-950 ${
                          isBusy ? 'bg-red-500' :
                          isOnline ? 'bg-emerald-500' :
                          'bg-transparent border-white/20'
                        }`} />
                      )}
                    </div>
                    <span className={`truncate font-medium flex-1 ${isActive || isOnline || isBusy || isGroup || unreadCount > 0 ? 'text-white' : 'text-violet-300/60'}`}>{dm.name}</span>
                    {unreadCount > 0 && !isActive && (
                      <span className="min-w-6 px-1 h-[20px] bg-red-500 text-white text-[10px] font-black rounded-full flex items-center justify-center border border-white/10 shadow-md ml-1 shrink-0">
                        {formatUnread(unreadCount)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* User Footer */}
      <div className="p-4 bg-black/10 backdrop-blur-sm transition-all group mt-auto border-t border-white/10 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="relative shrink-0 group-hover:scale-105 transition-transform cursor-pointer">
            <div className="w-11 h-11 rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center font-black text-white text-lg shadow-lg border-2 border-white/10">
              {user?.username?.[0]?.toUpperCase() || '?'}
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-violet-950 rounded-full flex items-center justify-center ring-2 ring-white/10">
              <div className={`w-2.5 h-2.5 rounded-full ${currentUserBusy ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.6)]' : 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.6)]'} animate-pulse`} />
            </div>
          </div>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[15px] font-black text-white truncate leading-tight tracking-tight">{user?.username || 'Guest'}</span>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`w-2 h-2 rounded-full ${currentUserBusy ? 'bg-red-500' : 'bg-emerald-500'} shadow-sm`} />
              <span className="text-[10px] text-violet-300/70 font-bold uppercase tracking-widest leading-none">
                {currentUserBusy ? 'In a meeting' : 'Active'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <CreateChannelModal isOpen={showCreateChannel} onClose={() => setShowCreateChannel(false)} />
      {composing && user && (
        <NewConversationModal
          workspaceId={workspaceId}
          currentUserId={user.id}
          onClose={() => setComposing(false)}
          onStartDM={startDM}
          onGroupCreated={(conversation) => {
            upsertDM({ ...conversation, isDM: true, lastActivityAt: conversation.lastActivityAt ?? new Date().toISOString() });
            navigate(`/${workspaceId}/c/${conversation.id}`);
          }}
        />
      )}
    </div>
  );
};
