import { Command, LogOut, Mail, Menu, ShieldCheck, User as UserIcon, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { requestMessageFocusAfterNavigation } from '../../lib/messageFocus';
import { getThemePreference, setThemePreference, ThemePreference } from '../../lib/theme';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../pages/workspace/WorkspaceContext';
import { useWorkspaces } from '../../pages/workspace/WorkspacesProvider';
import { ChannelSearch, SearchScope } from './ChannelSearch';
import { InviteMemberModal } from './InviteMemberModal';
import { ProfileSettingsModal } from '../profile/ProfileSettingsModal';
import { SecuritySettingsModal } from '../profile/SecuritySettingsModal';
import { Avatar } from '../ui/Avatar';
import { BrandMark } from '../ui/Brand';
import { TABLET_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';

export const Header = ({
  onMenuClick,
  searchScope = null,
  hideOnPhone = false,
  sidebarHidden = false,
}: {
  onMenuClick?: () => void;
  searchScope?: SearchScope | null;
  /** T.39: a full-screen conversation on a phone has its own top bar. */
  hideOnPhone?: boolean;
  /** T.39: tablet only — whether the collapsible sidebar is currently hidden. */
  sidebarHidden?: boolean;
}) => {
  const isTablet = useMediaQuery(TABLET_QUERY);
  const { user, logout } = useAuth();
  // Shares WorkspaceLayout's already-established socket via context instead
  // of calling useSocket(token) again — Header only ever renders inside
  // WorkspaceLayout, and useSocket isn't a singleton: each independent call
  // opens its own real Socket.IO connection. Before this fix, every regular
  // user session was opening two full duplicate connections for no reason.
  const { workspaceId, socket } = useWorkspace();
  // F1: invite only when the server says so (lib/policy 'workspace.manageInvitations').
  const currentWorkspace = useWorkspaces().getWorkspace(workspaceId);
  const canInvite = !!currentWorkspace?.capabilities?.canManageInvitations;
  const navigate = useNavigate();
  // P2 Phase J: light / dark / follow the system (per browser).
  const [themePref, setThemePref] = useState<ThemePreference>(() => getThemePreference());
  const chooseTheme = (preference: ThemePreference) => {
    setThemePreference(preference);
    setThemePref(preference);
  };
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showProfileSettings, setShowProfileSettings] = useState(false);
  const [showSecurity, setShowSecurity] = useState(false);
  const [userStatus, setUserStatus] = useState<'active' | 'away' | 'in_meeting'>('active');
  const [statusEmoji, setStatusEmoji] = useState('🟢');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Click outside hone pe dropdown band karne ka logic
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleStatusChange = (status: 'active' | 'away' | 'in_meeting') => {
    setUserStatus(status);
    
    let emoji = '🟢';
    if (status === 'away') emoji = '🟡';
    if (status === 'in_meeting') emoji = '🔴';
    
    setStatusEmoji(emoji);
    
    // Send status update to backend via Socket.IO
    if (socket) {
      socket.emit('user:status', { status, emoji });
    }
  };

  // T.32: Escape closes the account menu and returns focus to its button.
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!isDropdownOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsDropdownOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isDropdownOpen]);

  const STATUS_OPTIONS = [
    { id: 'active', label: 'Active', dot: 'bg-presence-online' },
    { id: 'away', label: 'Away', dot: 'bg-presence-away' },
    { id: 'in_meeting', label: 'In a meeting', dot: 'bg-danger' },
  ] as const;
  const currentStatus = STATUS_OPTIONS.find((o) => o.id === userStatus) ?? STATUS_OPTIONS[0];
  void statusEmoji;

  return (
    // T.39: below the status bar of an installed app (safe area; 48px tall when there is none).
    <header className={`relative z-[100] flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center justify-between gap-3 bg-sidebar px-3 pt-[env(safe-area-inset-top)] sm:px-4 ${hideOnPhone ? 'max-md:hidden' : ''}`}>
      {/* T.32: the side groups never shrink below their content on phones (the
          search field used to slide over the menu button at 390px). */}
      <div className="flex shrink-0 items-center gap-2 md:min-w-0 md:flex-1">
        <button
          type="button"
          onClick={onMenuClick}
          // T.39: phones open the navigation drawer; tablets show/hide the sidebar.
          aria-label={isTablet ? (sidebarHidden ? 'Show sidebar' : 'Hide sidebar') : 'Open navigation'}
          aria-expanded={isTablet ? !sidebarHidden : undefined}
          className="rounded-lg p-2 text-sidebar-fg-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-fg lg:hidden"
        >
          <Menu size={18} aria-hidden="true" />
        </button>
        <span className="hidden items-center gap-2 md:flex">
          <BrandMark size={22} />
          <span className="text-[13px] font-semibold tracking-[-0.01em] text-sidebar-fg">SmartConnect</span>
        </span>
      </div>

      {/* In-channel / workspace message search (F1) — scoped to the open conversation. */}
      <ChannelSearch
        scope={searchScope}
        workspace={workspaceId && currentWorkspace ? { id: workspaceId, name: currentWorkspace.name } : null}
        onOpenResult={(target) => {
          requestMessageFocusAfterNavigation(target);
          navigate(`/${workspaceId}/c/${target.channelId}`);
        }}
      />

      <div className="relative flex shrink-0 items-center justify-end gap-1.5 md:flex-1" ref={dropdownRef}>
        {/* T.33: the command palette (also ⌘K / Ctrl+K). */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('smartconnect:open-palette'))}
          className="flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[13px] font-medium text-sidebar-fg-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-fg"
          title="Search and jump to anything (Ctrl+K)"
          aria-label="Search and jump to anything (Ctrl+K)"
        >
          <Command size={15} aria-hidden="true" />
          <span className="hidden lg:inline">Jump to</span>
        </button>
        {canInvite && (
          <button
            onClick={() => setShowInviteModal(true)}
            type="button"
            className="hidden items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-sidebar-fg-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-fg sm:flex"
            title="Invite people to this workspace"
            aria-label="Invite People"
          >
            <UserPlus size={15} aria-hidden="true" />
            <span className="hidden lg:inline">Invite people</span>
          </button>
        )}

        {/* Account menu */}
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setIsDropdownOpen(!isDropdownOpen)}
          aria-label="Account menu"
          aria-haspopup="true"
          aria-expanded={isDropdownOpen}
          className="rounded-lg p-1 transition-colors hover:bg-sidebar-hover"
        >
          <span className="relative block">
            <Avatar name={user?.username} size="sm" initials={2} />
            <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-sidebar ${currentStatus.dot}`} aria-hidden="true" />
          </span>
        </button>

        {isDropdownOpen && (
          <div className="absolute right-0 top-11 z-50 w-[300px] overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-xl animate-pop-in origin-top-right" role="menu" aria-label="Account">
            <div className="flex items-center gap-3 border-b border-line p-4">
              <Avatar name={user?.username} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{user?.username}</p>
                {user?.email && (
                  <p className="flex items-center gap-1 truncate text-xs text-fg-subtle">
                    <Mail size={11} aria-hidden="true" />
                    <span className="truncate">{user.email}</span>
                  </p>
                )}
              </div>
            </div>

            <div className="border-b border-line p-2">
              <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium text-fg-subtle">Status</p>
              {STATUS_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={userStatus === option.id}
                  onClick={() => handleStatusChange(option.id)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-surface-tertiary ${userStatus === option.id ? 'font-medium text-fg' : 'text-fg-muted'}`}
                >
                  <span className={`h-2 w-2 rounded-full ${option.dot}`} aria-hidden="true" />
                  {option.label}
                  {userStatus === option.id && <span className="ml-auto text-xs text-brand">Current</span>}
                </button>
              ))}
            </div>

            <div className="border-b border-line p-2">
              <button
                type="button"
                role="menuitem"
                onClick={() => { setShowProfileSettings(true); setIsDropdownOpen(false); }}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-fg-muted transition-colors hover:bg-surface-tertiary hover:text-fg"
              >
                <UserIcon size={15} aria-hidden="true" /> Profile & preferences
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => { setShowSecurity(true); setIsDropdownOpen(false); }}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-fg-muted transition-colors hover:bg-surface-tertiary hover:text-fg"
              >
                <ShieldCheck size={15} aria-hidden="true" /> Password & security
              </button>
              <div className="px-2 pt-2">
                <p id="theme-label" className="mb-1.5 text-[11px] font-medium text-fg-subtle">Theme</p>
                <div role="group" aria-labelledby="theme-label" className="grid grid-cols-3 gap-1 rounded-lg bg-surface-tertiary p-1">
                  {(['light', 'dark', 'system'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={themePref === option}
                      onClick={() => chooseTheme(option)}
                      className={`rounded-md py-1 text-xs font-medium capitalize transition-colors ${
                        themePref === option ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg'
                      }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="p-2">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (logout) logout();
                  setIsDropdownOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium text-danger transition-colors hover:bg-danger-soft"
              >
                <LogOut size={15} aria-hidden="true" />
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>

      {showProfileSettings && <ProfileSettingsModal onClose={() => setShowProfileSettings(false)} />}
      {showSecurity && <SecuritySettingsModal onClose={() => setShowSecurity(false)} />}

      <InviteMemberModal
        isOpen={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        workspaceId={workspaceId}
      />
    </header>
  );
};