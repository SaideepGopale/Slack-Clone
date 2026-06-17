import axios from 'axios';
import {
    Bell,
    ChevronDown,
    Hash,
    Home,
    LogOut,
    MessageSquare,
    MoreHorizontal,
    Plus,
    Trash2,
    Users,
    X
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { Channel } from '../../types';

export const Sidebar = ({ 
  channels, 
  currentChannel, 
  onSelectChannel, 
  unreadCounts = {},
  onlineUsers = [], 
  allUsers = [],
  activeView,
  onViewChange,
  onStartDM
}: any) => {
  const { user, logout } = useAuth();
  const [showAddChannel, setShowAddChannel] = useState(false);
  
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelDesc, setNewChannelDesc] = useState(''); 
  
  const [collapsedChannels, setCollapsedChannels] = useState(false);
  const [collapsedDMs, setCollapsedDMs] = useState(false);

  const totalUnreads = Object.values(unreadCounts).reduce((acc: number, val) => acc + (val as number), 0) as number;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChannelName.trim()) return;
    try {
      await axios.post('/api/channels', { 
        name: newChannelName,
        description: newChannelDesc 
      }, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      });
      setNewChannelName('');
      setNewChannelDesc('');
      setShowAddChannel(false);
      window.location.reload(); 
    } catch (err) { console.error(err); }
  };

  const handleDelete = async (e: React.MouseEvent, channelId: string, channelName: string) => {
    e.stopPropagation(); 
    if (channelName.toLowerCase() === 'general') {
      alert("Cannot delete the general channel!");
      return;
    }
    if (!confirm(`Are you sure you want to delete #${channelName}? This action cannot be undone.`)) return;
    
    try {
      await axios.delete(`/api/channels/${channelId}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      });
      window.location.reload(); 
    } catch (err) { 
      alert("Only admins can delete channels or something went wrong!");
      console.error(err); 
    }
  };

  const navItems: { id: string, label: string, icon: any, badge: number }[] = [
    { id: 'home', label: 'Home', icon: Home, badge: 0 },
    { id: 'dms', label: 'DMs', icon: MessageSquare, badge: 0 },
    { id: 'activity', label: 'Activity', icon: Bell, badge: totalUnreads },
    { id: 'directory', label: 'People', icon: Users, badge: 0 },
    { id: 'more', label: 'More', icon: MoreHorizontal, badge: 0 },
  ];

  const currentUserOnlineData = onlineUsers.find((ou: any) => ou.id === user?.id);
  const currentUserBusy = currentUserOnlineData?.status === 'busy';

  return (
    <div className="w-full h-full bg-gradient-to-b from-slack-sidebar to-[#2d0a2e] text-gray-300 flex flex-col shrink-0 overflow-hidden shadow-2xl">
      {/* Workspace Header */}
      <div className="h-[60px] flex items-center justify-between px-5 hover:bg-white/5 cursor-pointer transition-all group border-b border-white/10 shadow-md">
        <div className="flex items-center gap-3 text-white overflow-hidden">
          <div className="w-9 h-9 bg-white/10 rounded-xl flex items-center justify-center shrink-0 border border-white/20 group-hover:bg-white/20 transition-all shadow-md backdrop-blur-sm">
            <span className="font-black text-base tracking-tighter">S</span>
          </div>
          <div className="flex flex-col">
            <span className="font-black text-[16px] truncate tracking-tight">Workspace</span>
            <span className="text-[10px] text-white/50 font-medium uppercase tracking-wider">Pro Plan</span>
          </div>
          <ChevronDown size={16} className="text-white/40 group-hover:text-white transition-colors ml-auto" />
        </div>
        <button 
          onClick={logout} 
          className="p-2 hover:bg-red-500/20 rounded-lg transition-all text-white/40 hover:text-red-400 hover:scale-110 active:scale-95"
          title="Sign out"
        >
          <LogOut size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto sidebar-scrollbar py-3 px-3">
        {/* Main Menu Items */}
        <div className="space-y-1 mb-6">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all text-[15px] font-semibold relative group ${
                activeView === item.id 
                  ? 'bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-lg shadow-blue-900/30' 
                  : 'hover:bg-white/10 text-[#d1d2d3] hover:text-white'
              }`}
            >
              <item.icon 
                size={20} 
                className={`${activeView === item.id ? 'text-white' : 'text-white/60 group-hover:text-white/90'} transition-colors`} 
              />
              <span>{item.label}</span>
              {(item.badge ?? 0) > 0 && (
                <span className="absolute right-3 min-w-[20px] h-[20px] bg-gradient-to-r from-red-500 to-pink-600 text-white text-[10px] font-black rounded-full flex items-center justify-center px-1.5 shadow-md border border-white/10">
                  {item.badge}
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
                className={`text-white/50 transition-transform ${collapsedChannels ? '-rotate-90' : ''}`} 
              />
            </button>
            <span className="text-[13px] font-bold text-white/60 flex-1 px-2 cursor-default tracking-wide uppercase">Channels</span>
            <button 
              onClick={() => setShowAddChannel(true)}
              className="p-1.5 opacity-0 group-hover:opacity-100 hover:bg-white/10 rounded-lg transition-all text-white/60 hover:text-white hover:scale-110 active:scale-95"
              title="Create channel"
            >
              <Plus size={18} />
            </button>
          </div>
          
          {!collapsedChannels && (
            <div className="space-y-0.5">
              {channels.map((ch: Channel) => {
                const unreadCount = unreadCounts[ch.id] || 0;
                const isActive = activeView === 'chat' && currentChannel?.id === ch.id;

                return (
                  <button 
                    key={ch.id} 
                    onClick={() => {
                      onViewChange('chat');
                      onSelectChannel(ch);
                    }} 
                    className={`w-full text-left flex items-center gap-2.5 px-4 py-2 rounded-xl transition-all text-[14px] relative group ${
                      isActive 
                        ? 'bg-gradient-to-r from-blue-600 to-blue-700 text-white font-bold shadow-lg shadow-blue-900/30' 
                        : unreadCount > 0 
                          ? 'text-white font-bold bg-white/5'
                          : 'hover:bg-white/10 text-[#d1d2d3] hover:text-white'
                    }`}
                  >
                    <Hash size={18} className={isActive ? 'text-white' : unreadCount > 0 ? 'text-white' : 'text-white/40 group-hover:text-white/70'} />
                    <span className="truncate flex-1">{ch.name}</span>
                    
                    <div 
                      onClick={(e) => handleDelete(e, ch.id, ch.name)}
                      className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-500/20 text-white/50 hover:text-red-400 rounded-lg transition-all z-10 hover:scale-110 active:scale-95"
                      title="Delete Project"
                    >
                      <Trash2 size={15} />
                    </div>

                    {unreadCount > 0 && !isActive && (
                      <span className="w-6 h-[20px] bg-gradient-to-r from-red-500 to-pink-600 text-white text-[10px] font-black rounded-full flex items-center justify-center border border-white/10 shadow-md ml-1">
                        {unreadCount}
                      </span>
                    )}
                  </button>
                );
              })}
              <button 
                onClick={() => setShowAddChannel(true)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-[14px] text-white/60 hover:text-white hover:bg-white/10 rounded-xl transition-all group font-semibold"
              >
                <div className="w-8 h-8 bg-white/5 rounded-xl flex items-center justify-center group-hover:bg-white/10 border border-white/10 group-hover:border-white/20 transition-all shadow-sm">
                  <Plus size={18} />
                </div>
                <span>Create Channel</span>
              </button>
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
              <ChevronDown size={12} className={`text-white/40 transition-transform ${collapsedDMs ? '-rotate-90' : ''}`} />
            </button>
            <span className="text-[13px] font-medium text-white/50 flex-1 px-1 cursor-default">Direct Messages</span>
            <button className="p-1 opacity-0 group-hover:opacity-100 hover:bg-white/10 rounded transition-all text-white/50 hover:text-white">
              <Plus size={16} />
            </button>
          </div>

          {!collapsedDMs && (
            <div className="px-3 space-y-0.5">
              {allUsers.filter((u: any) => u.id !== user?.id).map((u: any) => {
                const userOnlineData = onlineUsers.find((ou: any) => ou.id === u.id);
                const isOnline = !!userOnlineData;
                const isBusy = userOnlineData?.status === 'busy';

                return (
                  <div 
                    key={u.id} 
                    onClick={() => onStartDM(u.id)}
                    className="flex items-center gap-2.5 px-3 py-1.5 text-[14px] hover:bg-white/10 rounded-md cursor-pointer transition-all group/dm"
                  >
                    <div className="relative shrink-0">
                      <div className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center text-[11px] font-black text-white shrink-0 group-hover/dm:bg-white/20 transition-colors border border-white/5">
                        {u.username?.[0]?.toUpperCase()}
                      </div>
                      <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slack-sidebar ${
                        isBusy ? 'bg-red-500' : 
                        isOnline ? 'bg-slack-green' : 
                        'bg-transparent border-white/20'
                      }`} />
                    </div>
                    <span className={`truncate font-medium flex-1 ${isOnline || isBusy ? 'text-white' : 'text-white/50'}`}>{u.username}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* User Footer */}
      <div className="p-4 bg-gradient-to-r from-white/5 to-white/10 backdrop-blur-sm transition-all group mt-auto border-t border-white/10 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="relative shrink-0 group-hover:scale-105 transition-transform cursor-pointer">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-[#e8912d] via-[#ffcc00] to-[#ff9c00] flex items-center justify-center font-black text-white text-lg shadow-lg border-2 border-white/20">
              {user?.username?.[0]?.toUpperCase() || '?'}
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-slack-sidebar rounded-full flex items-center justify-center ring-2 ring-white/10">
              <div className={`w-2.5 h-2.5 rounded-full ${currentUserBusy ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.6)]' : 'bg-slack-green shadow-[0_0_10px_rgba(43,181,115,0.6)]'} animate-pulse`} />
            </div>
          </div>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[15px] font-black text-white truncate leading-tight tracking-tight">{user?.username || 'Guest'}</span>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`w-2 h-2 rounded-full ${currentUserBusy ? 'bg-red-500' : 'bg-slack-green'} shadow-sm`} />
              <span className="text-[10px] text-white/60 font-bold uppercase tracking-widest leading-none">
                {currentUserBusy ? 'In a meeting' : 'Active'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Project Creation Modal */}
      <AnimatePresence>
        {showAddChannel && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center p-4 z-[100]">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0, y: 20 }} 
              animate={{ scale: 1, opacity: 1, y: 0 }} 
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              transition={{ type: "spring", duration: 0.3 }}
              className="bg-white rounded-3xl p-8 w-full max-w-lg shadow-2xl border border-gray-100 relative overflow-hidden"
            >
              {/* Decorative gradient */}
              <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-br from-blue-100 to-purple-100 rounded-full blur-3xl opacity-30 -z-10"></div>
              
              <div className="flex justify-between items-start mb-6">
                <div>
                  <h3 className="text-3xl font-black text-gray-900 tracking-tight">Create Channel</h3>
                  <p className="text-gray-500 text-sm mt-2 font-medium">Set up a dedicated space for your team</p>
                </div>
                <button 
                  onClick={() => setShowAddChannel(false)} 
                  className="p-2.5 bg-gray-100 hover:bg-gray-200 rounded-xl text-gray-500 hover:text-gray-700 transition-all hover:rotate-90"
                >
                  <X size={20} />
                </button>
              </div>

              <form onSubmit={handleCreate}>
                
                {/* 1. Project Name */}
                <div className="mb-6">
                  <label className="block text-[11px] font-black uppercase tracking-widest text-gray-600 mb-3">
                    Channel Name <span className="text-red-500">*</span>
                  </label>
                  <div className="flex items-center border-2 border-gray-200 rounded-xl focus-within:border-blue-500 focus-within:ring-4 focus-within:ring-blue-50 transition-all bg-gray-50/50 shadow-sm">
                    <span className="px-4 text-gray-400 font-black text-lg">#</span>
                    <input 
                      autoFocus 
                      required 
                      type="text" 
                      placeholder="e.g. team-updates" 
                      className="w-full py-3.5 pr-4 bg-transparent outline-none text-gray-900 font-semibold placeholder-gray-400 text-base" 
                      value={newChannelName} 
                      onChange={e => setNewChannelName(e.target.value)} 
                    />
                  </div>
                </div>

                {/* 2. Description */}
                <div className="mb-6">
                  <label className="block text-[11px] font-black uppercase tracking-widest text-gray-600 mb-3">
                    Description (Optional)
                  </label>
                  <textarea 
                    rows={3} 
                    placeholder="What's this channel about?" 
                    className="w-full px-4 py-3.5 border-2 border-gray-200 rounded-xl focus:border-blue-500 focus:ring-4 focus:ring-blue-50 outline-none text-gray-900 font-medium bg-gray-50/50 resize-none transition-all placeholder-gray-400 shadow-sm" 
                    value={newChannelDesc} 
                    onChange={e => setNewChannelDesc(e.target.value)} 
                  />
                </div>

                {/* 3. Admin Name (Read-Only) */}
                <div className="mb-8">
                  <label className="block text-[11px] font-black uppercase tracking-widest text-gray-600 mb-3">
                    Channel Admin
                  </label>
                  <div className="flex items-center gap-3 px-4 py-3.5 border-2 border-gray-100 rounded-xl bg-gradient-to-br from-gray-50 to-white shadow-sm">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-600 to-purple-600 text-white flex items-center justify-center text-sm font-bold shadow-md">
                      {user?.username?.[0]?.toUpperCase()}
                    </div>
                    <span className="text-gray-900 font-bold">{user?.username}</span>
                  </div>
                  <p className="text-[11px] text-gray-500 mt-3 font-medium leading-relaxed">
                    As the creator, you're automatically assigned as the channel admin with full permissions.
                  </p>
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
                  <button 
                    type="button" 
                    onClick={() => setShowAddChannel(false)} 
                    className="px-6 py-3 font-bold text-gray-600 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 rounded-xl transition-all hover:scale-105 active:scale-95"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit" 
                    disabled={!newChannelName.trim()} 
                    className="px-8 py-3 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-bold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-blue-600/30 hover:shadow-xl hover:scale-105 active:scale-95 disabled:hover:scale-100"
                  >
                    Create Channel
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};