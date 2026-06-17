import { Calendar, Clock, HelpCircle, LogOut, Mail, Menu, Phone, Search, Settings, User as UserIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../hooks/useSocket';

export const Header = ({ onMenuClick }: { onMenuClick?: () => void }) => {
  const { user, logout } = useAuth();
  const { token } = useAuth();
  const socket = useSocket(token);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
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
          className="md:hidden p-2 hover:bg-white/10 rounded-lg text-gray-200 hover:text-white transition-all active:scale-95"
        >
          <Menu size={20} />
        </button>
        <div className="hidden md:flex flex-1 justify-end pr-4">
          <button className="p-2 text-gray-200 hover:text-white hover:bg-white/10 rounded-lg transition-all" title="Recent activity">
            <Clock size={18} />
          </button>
        </div>
      </div>
      
      <div className="w-full max-w-2xl px-2 md:px-4 relative group">
        <div className="absolute left-6 md:left-8 top-1/2 -translate-y-1/2 text-gray-300 group-focus-within:text-white pointer-events-none transition-all z-10">
          <Search size={16} />
        </div>
        <input 
          type="text" 
          placeholder="Search messages, files, or people..." 
          className="w-full bg-white/10 backdrop-blur-sm border border-white/20 focus:border-white/40 focus:bg-white/20 rounded-xl py-2.5 pl-10 md:pl-12 pr-4 text-sm text-white placeholder-gray-300 outline-none transition-all placeholder:font-normal shadow-inner"
        />
      </div>

      <div className="flex-1 flex justify-end items-center gap-2 relative" ref={dropdownRef}>
        <button className="hidden sm:flex p-2 text-gray-200 hover:text-white hover:bg-white/10 rounded-lg transition-all items-center justify-center" title="Help & Support">
          <HelpCircle size={18} />
        </button>
        
        {/* Profile Button (Avatar) */}
        <div 
          onClick={() => setIsDropdownOpen(!isDropdownOpen)}
          className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#e8912d] to-[#ff9c00] border-2 border-white/30 hover:border-white/60 flex items-center justify-center text-sm font-bold text-white cursor-pointer active:scale-95 transition-all shrink-0 select-none shadow-lg hover:shadow-xl"
        >
          {user?.username?.substring(0, 2).toUpperCase() || '??'}
        </div>

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

            {/* Info Section */}
            <div className="p-3">
              <div className="flex items-center gap-3 px-3 py-2.5 text-sm text-gray-700 rounded-lg hover:bg-gray-50 transition-all">
                <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                  <Mail size={16} className="text-blue-600" />
                </div>
                <span className="truncate font-medium">{user?.email || 'samarth@example.com'}</span>
              </div>
              
              {/* Fake Data / Coming Soon from backend */}
              <div className="flex items-center gap-3 px-3 py-2.5 text-sm text-gray-500 rounded-lg hover:bg-gray-50 transition-all cursor-pointer">
                <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center shrink-0">
                  <Calendar size={16} className="text-purple-600" />
                </div>
                <span className="truncate">Add Birthdate...</span>
              </div>
              
              <div className="flex items-center gap-3 px-3 py-2.5 text-sm text-gray-500 rounded-lg hover:bg-gray-50 transition-all cursor-pointer">
                <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center shrink-0">
                  <Phone size={16} className="text-green-600" />
                </div>
                <span className="truncate">Add Phone Number...</span>
              </div>
            </div>

            <div className="h-px bg-gray-200 mx-3"></div>

            {/* Action Buttons */}
            <div className="p-3">
              <button className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-100 rounded-xl transition-all font-medium group">
                <UserIcon size={18} className="text-gray-400 group-hover:text-gray-600 transition-colors" />
                Profile Settings
              </button>
              <button className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-100 rounded-xl transition-all font-medium group">
                <Settings size={18} className="text-gray-400 group-hover:text-gray-600 transition-colors" />
                Preferences
              </button>
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
    </header>
  );
};