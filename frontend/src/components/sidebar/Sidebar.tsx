import { Bell, Building2, ChevronDown, ClipboardList, FolderKanban, Hash, Home, LayoutGrid, ListChecks, Lock, LogOut, MessageSquare, MoreHorizontal, Plus, Settings, Trash2, UserRoundX, Users } from 'lucide-react';
import { useHierarchy } from '../../hooks/useHierarchy';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NewConversationModal } from '../conversations/NewConversationModal';
import { formatUnread } from '../../lib/unread';
import { isSidebarVisible } from '../../lib/channels';
import { useAuth } from '../../contexts/AuthContext';
import { Avatar } from '../ui/Avatar';
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
    // T.33
    { id: 'projects', label: 'Projects', icon: FolderKanban, badge: 0 },
    { id: 'tasks', label: 'My Tasks', icon: ListChecks, badge: 0 },
    // T.38: the Team Lead dashboard, in workspaces the user manages (never Collab).
    ...(workspace && !workspace.isDefault && workspace.capabilities?.canManage ? [{ id: 'team-tasks', label: 'Team Tasks', icon: ClipboardList, badge: 0 }] : []),
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
    <div className="w-full h-full bg-sidebar text-sidebar-fg flex flex-col shrink-0 overflow-hidden">
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
          className={`mx-2 mt-2 h-12 flex items-center justify-between px-2.5 rounded-lg transition-colors group ${hasWorkspaceActions ? 'hover:bg-sidebar-hover cursor-pointer' : ''}`}
        >
          <div className="flex items-center gap-2.5 text-white overflow-hidden min-w-0">
            <div className="min-w-0 flex flex-col">
              <span className="font-semibold text-[14px] truncate tracking-[-0.01em]">{workspace?.name || 'Workspace'}</span>
              <span className="text-[11px] text-sidebar-fg-muted tabular-nums">
                {workspace?._count?.members ?? 0} members
              </span>
            </div>
            {hasWorkspaceActions && (
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={`text-sidebar-fg-muted group-hover:text-sidebar-fg transition-transform shrink-0 ${showWorkspaceMenu ? 'rotate-180' : ''}`}
              />
            )}
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); logout(); }}
            className="p-1.5 rounded-md transition-colors text-sidebar-fg-muted hover:bg-sidebar-hover hover:text-sidebar-fg"
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut size={15} aria-hidden="true" />
          </button>
        </div>

        {showWorkspaceMenu && hasWorkspaceActions && (
          <div className="absolute top-full left-2 right-2 mt-1 bg-surface text-fg rounded-xl shadow-xl border border-line overflow-hidden z-50 animate-pop-in">
            <div className="px-4 py-3 border-b border-gray-100">
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Workspace</div>
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

      <div className="flex-1 overflow-y-auto sidebar-scrollbar py-3 px-2">
        {/* Main Menu Items */}
        <div className="space-y-1 mb-6">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={activeView === item.id ? 'page' : undefined}
              onClick={() => onViewChange(item.view ?? item.id)}
              className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 max-lg:min-h-11 max-lg:text-sm rounded-md transition-colors text-[13px] font-medium relative group ${
                activeView === item.id
                  ? 'bg-sidebar-active text-white'
                  : 'hover:bg-sidebar-hover text-sidebar-fg-muted hover:text-sidebar-fg'
              }`}
            >
              <item.icon
                size={16}
                aria-hidden="true"
                className={`${activeView === item.id ? 'text-accent-200' : 'text-sidebar-fg-muted group-hover:text-sidebar-fg'} transition-colors`}
              />
              <span>{item.label}</span>
              {(item.badge ?? 0) > 0 && (
                <span className="absolute right-2 min-w-[18px] h-[18px] bg-danger text-white text-[10px] font-semibold tabular-nums rounded-full flex items-center justify-center px-1.5">
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
              className="p-1.5 hover:bg-sidebar-hover rounded-lg transition-all"
            >
              <ChevronDown
                size={14}
                className={`text-sidebar-fg-muted transition-transform ${collapsedChannels ? '-rotate-90' : ''}`}
              />
            </button>
            <span className="text-[12px] font-medium text-sidebar-fg-muted flex-1 px-1.5 cursor-default">Channels</span>
            {/* T.32 (audit FE-2): only when the workspace policy lets this member
                create channels (the server enforces it either way). Visible on
                keyboard focus and on touch screens, not just on hover. */}
            {workspace?.capabilities?.canCreateChannel !== false && (
              <button
                type="button"
                onClick={() => setShowCreateChannel(true)}
                className="p-1.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 hover:bg-sidebar-hover rounded-lg transition-all text-sidebar-fg-muted hover:text-white active:scale-95"
                title="Create a channel"
                aria-label="Create a channel"
              >
                <Plus size={16} aria-hidden="true" />
              </button>
            )}
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
                    aria-current={isActive ? 'page' : undefined}
                    className={`w-full text-left flex items-center gap-2 px-2.5 py-1.5 max-lg:min-h-11 max-lg:text-sm rounded-md transition-colors text-[13px] relative group ${
                      isActive
                        ? 'bg-sidebar-active text-white font-medium'
                        : unreadCount > 0
                          ? 'text-white font-semibold hover:bg-sidebar-hover'
                          : 'hover:bg-sidebar-hover text-sidebar-fg-muted hover:text-sidebar-fg'
                    }`}
                  >
                    <span className="w-[18px] h-[18px] shrink-0 flex items-center justify-center text-[15px] leading-none">
                      {ch.icon && ch.icon !== 'hash' ? (
                        <span>{ch.icon}</span>
                      ) : ch.visibility === 'PRIVATE' ? (
                        <Lock size={14} className="text-sidebar-fg-muted" aria-label="Private channel" />
                      ) : (
                        <Hash size={15} className="text-sidebar-fg-muted" aria-hidden="true" />
                      )}
                    </span>
                    <span className="truncate flex-1">{ch.name}</span>



                    {unreadCount > 0 && !isActive && (
                      <span className="min-w-[18px] px-1 h-[18px] bg-danger text-white text-[10px] font-semibold tabular-nums rounded-full flex items-center justify-center ml-1">
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
              className="p-1 hover:bg-sidebar-hover rounded transition-colors"
            >
              <ChevronDown size={12} className={`text-sidebar-fg-muted transition-transform ${collapsedDMs ? '-rotate-90' : ''}`} />
            </button>
            <span className="text-[12px] font-medium text-sidebar-fg-muted flex-1 px-1 cursor-default">Direct Messages</span>
            <button
              onClick={() => setComposing(true)}
              className="p-1 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-sidebar-hover rounded transition-all text-sidebar-fg-muted hover:text-white"
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
                  // T.32: a real button (keyboard and screen readers), with presence as text too.
                  <button
                    type="button"
                    key={dm.id}
                    onClick={() => {
                      onViewChange('chat');
                      onSelectChannel(dm);
                    }}
                    aria-current={isActive ? 'page' : undefined}
                    className={`w-full text-left flex items-center gap-2 px-2.5 py-1 max-lg:min-h-11 max-lg:text-sm text-[13px] rounded-md transition-colors group/dm ${
                      isActive ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover'
                    }`}
                  >
                    <div className="relative shrink-0">
                      {isGroup ? (
                        <div className="w-5 h-5 rounded-md bg-white/[0.08] flex items-center justify-center text-sidebar-fg shrink-0" aria-hidden="true">
                          <Users size={12} />
                        </div>
                      ) : (
                        <Avatar name={dm.name} size="xs" />
                      )}
                      {!isGroup && (
                        <span
                          aria-hidden="true"
                          className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-sidebar ${
                            isBusy ? 'bg-danger' : isOnline ? 'bg-presence-online' : 'bg-sidebar border border-white/30'
                          }`}
                        />
                      )}
                      {!isGroup && <span className="sr-only">{isBusy ? '(in a meeting)' : isOnline ? '(online)' : '(offline)'}</span>}
                    </div>
                    <span className={`truncate flex-1 ${unreadCount > 0 ? 'font-semibold text-white' : isActive ? 'font-medium text-white' : 'text-sidebar-fg-muted group-hover/dm:text-sidebar-fg'}`}>{dm.name}</span>
                    {unreadCount > 0 && !isActive && (
                      <span className="min-w-[18px] px-1 h-[18px] bg-danger text-white text-[10px] font-semibold tabular-nums rounded-full flex items-center justify-center ml-1 shrink-0">
                        {formatUnread(unreadCount)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* User Footer */}
      <div className="mt-auto border-t border-white/[0.06] px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="relative shrink-0">
            <Avatar name={user?.username} size="sm" />
            <span aria-hidden="true" className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-sidebar ${currentUserBusy ? 'bg-danger' : 'bg-presence-online'}`} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-medium leading-tight text-sidebar-fg">{user?.username || 'Guest'}</span>
            <span className="mt-0.5 text-[11px] leading-none text-sidebar-fg-muted">{currentUserBusy ? 'In a meeting' : 'Active'}</span>
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
