import { LogOut, Mail, Menu, Settings, User as UserIcon, UserPlus } from 'lucide-react';
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

export const Header = ({ onMenuClick, searchScope = null }: { onMenuClick?: () => void; searchScope?: SearchScope | null }) => {
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

  return (
    <header className="h-12 bg-gradient-to-r from-[#350d36] to-[#4a154b] flex items-center justify-between px-5 shrink-0 z-[100] relative shadow-lg">
      <div className="flex-1 flex items-center gap-3">
        <button 
          onClick={onMenuClick}
          aria-label="Open navigation"
          className="md:hidden p-2 hover:bg-white/10 rounded-lg text-gray-200 hover:text-white transition-all active:scale-95"
        >
          <Menu size={20} />
        </button>
      </div>
      
      {/* In-channel message search (F1) — scoped to the open conversation. */}
      <ChannelSearch
        scope={searchScope}
        workspace={workspaceId && currentWorkspace ? { id: workspaceId, name: currentWorkspace.name } : null}
        onOpenResult={(target) => {
          requestMessageFocusAfterNavigation(target);
          navigate(`/${workspaceId}/c/${target.channelId}`);
        }}
      />

      <div className="flex-1 flex justify-end items-center gap-2 relative" ref={dropdownRef}>
        {canInvite && (
          <button
            onClick={() => setShowInviteModal(true)}
            type="button"
            className="hidden sm:flex items-center gap-2 px-2.5 lg:px-3.5 py-2 whitespace-nowrap bg-white/10 hover:bg-white/20 border border-white/20 hover:border-white/30 rounded-xl text-sm font-semibold text-gray-100 hover:text-white transition-colors"
            title="Invite people to this workspace"
            aria-label="Invite People"
          >
            <UserPlus size={16} aria-hidden="true" />
            <span className="hidden lg:inline">Invite People</span>
          </button>
        )}
        
        {/* Profile Button (Avatar) */}
        <button
          type="button"
          onClick={() => setIsDropdownOpen(!isDropdownOpen)}
          aria-label="Account menu"
          aria-haspopup="true"
          aria-expanded={isDropdownOpen}
          className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#e8912d] to-[#ff9c00] border-2 border-white/30 hover:border-white/60 flex items-center justify-center text-sm font-bold text-white cursor-pointer active:scale-95 transition-all shrink-0 select-none shadow-lg hover:shadow-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
        >
          {user?.username?.substring(0, 2).toUpperCase() || '??'}
        </button>

        {/* Dropdown Menu */}
        {isDropdownOpen && (
          <div className="absolute top-12 right-0 w-[320px] bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden animate-scale-in z-50 elevation-4">
            
            {/* Header Section */}
            <div className="p-5 flex items-center gap-4 border-b border-gray-100 bg-gradient-to-br from-gray-50 to-white">
              <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-[#e8912d] to-[#ff9c00] flex items-center justify-center text-xl font-black text-white shrink-0 shadow-md">
                {user?.username?.substring(0, 2).toUpperCase() || '??'}
              </div>
              <div className="overflow-hidden flex-1">
                <h3 className="font-bold text-gray-900 truncate text-base">{user?.username}</h3>
                <div className="flex items-center gap-2 mt-1">
                  <div className={`w-2 h-2 rounded-full shrink-0 animate-pulse shadow-sm ${userStatus === 'active' ? 'bg-green-500 shadow-green-500/50' : userStatus === 'away' ? 'bg-yellow-500 shadow-yellow-500/50' : 'bg-red-500 shadow-red-500/50'}`}></div>
                  <p className={`text-xs font-semibold truncate ${userStatus === 'active' ? 'text-green-600' : userStatus === 'away' ? 'text-yellow-600' : 'text-red-600'}`}>
                    {userStatus === 'active' ? 'Active now' : userStatus === 'away' ? 'Away' : 'In Meeting'}
                  </p>
                </div>
              </div>
            </div>

            {/* Status Selector */}
            <div className="p-3 border-b border-gray-100">
              <div className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2 px-2">Set Status</div>
              <div className="space-y-2">
                <button
                  onClick={() => handleStatusChange('active')}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm rounded-lg transition-all ${
                    userStatus === 'active'
                      ? 'bg-green-100 border border-green-300 text-green-700 font-semibold'
                      : 'bg-gray-50 border border-gray-200 text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <span className="text-lg">🟢</span>
                  <span>Active</span>
                </button>
                <button
                  onClick={() => handleStatusChange('away')}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm rounded-lg transition-all ${
                    userStatus === 'away'
                      ? 'bg-yellow-100 border border-yellow-300 text-yellow-700 font-semibold'
                      : 'bg-gray-50 border border-gray-200 text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <span className="text-lg">🟡</span>
                  <span>Away</span>
                </button>
                <button
                  onClick={() => handleStatusChange('in_meeting')}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm rounded-lg transition-all ${
                    userStatus === 'in_meeting'
                      ? 'bg-red-100 border border-red-300 text-red-700 font-semibold'
                      : 'bg-gray-50 border border-gray-200 text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <span className="text-lg">🔴</span>
                  <span>In Meeting</span>
                </button>
              </div>
            </div>

            {/* Info Section — real account data only (F1 removed placeholder rows). */}
            {user?.email && (
              <div className="p-3">
                <div className="flex items-center gap-3 px-3 py-2.5 text-sm text-gray-700 rounded-lg">
                  <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                    <Mail size={16} className="text-blue-600" />
                  </div>
                  <span className="truncate font-medium">{user.email}</span>
                </div>
              </div>
            )}

            <div className="h-px bg-gray-200 mx-3"></div>

            {/* Action Buttons */}
            <div className="p-3">
              <button
                onClick={() => { setShowProfileSettings(true); setIsDropdownOpen(false); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-100 rounded-xl transition-all font-medium group"
              >
                <UserIcon size={18} className="text-gray-400 group-hover:text-gray-600 transition-colors" />
                Profile Settings
              </button>
              <button
                onClick={() => { setShowProfileSettings(true); setIsDropdownOpen(false); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-100 rounded-xl transition-all font-medium group"
              >
                <Settings size={18} className="text-gray-400 group-hover:text-gray-600 transition-colors" />
                Preferences
              </button>
              <div className="mt-2 px-4">
                <p id="theme-label" className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle mb-1.5">Theme</p>
                <div role="group" aria-labelledby="theme-label" className="grid grid-cols-3 gap-1 rounded-lg bg-surface-tertiary p-1">
                  {(['light', 'dark', 'system'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={themePref === option}
                      onClick={() => chooseTheme(option)}
                      className={`rounded-md py-1.5 text-xs font-semibold capitalize transition-colors ${
                        themePref === option ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg'
                      }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="h-px bg-gray-200 mx-3"></div>

            {/* Logout Button */}
            <div className="p-3">
              <button 
                onClick={() => {
                  if(logout) logout();
                  setIsDropdownOpen(false);
                }} 
                className="w-full flex items-center gap-3 px-4 py-3 text-sm text-red-600 hover:bg-red-50 hover:text-red-700 rounded-xl transition-all font-semibold group shadow-sm hover:shadow-md"
              >
                <LogOut size={18} className="group-hover:translate-x-0.5 transition-transform" />
                Sign out of Workspace
              </button>
            </div>

          </div>
        )}
      </div>

      {showProfileSettings && <ProfileSettingsModal onClose={() => setShowProfileSettings(false)} />}

      <InviteMemberModal
        isOpen={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        workspaceId={workspaceId}
      />
    </header>
  );
};