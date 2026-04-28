import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { 
  Hash, 
  Plus, 
  LogOut, 
  Circle, 
  Home, 
  MessageSquare, 
  Bell, 
  MoreHorizontal, 
  ChevronDown, 
  ChevronRight,
  Search,
  Users
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import axios from 'axios';
import { Channel } from '../../types';

export const Sidebar = ({ 
  channels, 
  currentChannel, 
  onSelectChannel, 
  unreadCounts = {},
  onlineUsers, 
  allUsers = [],
  activeView,
  onViewChange,
  onStartDM
}: any) => {
  const { user, logout } = useAuth();
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [collapsedChannels, setCollapsedChannels] = useState(false);
  const [collapsedDMs, setCollapsedDMs] = useState(false);

  const totalUnreads = Object.values(unreadCounts).reduce((acc: number, val) => acc + (val as number), 0) as number;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChannelName.trim()) return;
    try {
      await axios.post('/api/channels', { name: newChannelName }, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      });
      setNewChannelName('');
      setShowAddChannel(false);
    } catch (err) { console.error(err); }
  };

  const navItems: { id: string, label: string, icon: any, badge: number }[] = [
    { id: 'home', label: 'Home', icon: Home, badge: 0 },
    { id: 'dms', label: 'DMs', icon: MessageSquare, badge: 0 },
    { id: 'activity', label: 'Activity', icon: Bell, badge: totalUnreads },
    { id: 'directory', label: 'People', icon: Users, badge: 0 },
    { id: 'more', label: 'More', icon: MoreHorizontal, badge: 0 },
  ];

  return (
    <div className="w-full h-full bg-slack-sidebar text-gray-400 flex flex-col shrink-0 overflow-hidden">
      {/* Workspace Header */}
      <div className="h-[49px] flex items-center justify-between px-4 hover:bg-slack-sidebar-hover cursor-pointer transition-colors group border-b border-white/5">
        <div className="flex items-center gap-2 text-white overflow-hidden">
          <div className="w-7 h-7 bg-white/10 rounded-md flex items-center justify-center shrink-0 border border-white/10 group-hover:bg-white/20 transition-colors">
            <span className="font-black text-sm tracking-tighter">S</span>
          </div>
          <span className="font-black text-[15px] truncate tracking-tight">Slick Workspace</span>
          <ChevronDown size={14} className="text-white/40 group-hover:text-white transition-colors" />
        </div>
        <button onClick={logout} className="p-1.5 hover:bg-white/10 rounded-md transition-all text-white/40 hover:text-white">
          <LogOut size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto sidebar-scrollbar py-2">
        {/* Main Menu Items */}
        <div className="px-3 space-y-0.5 mb-6">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md transition-all text-[14px] font-medium relative group ${
                activeView === item.id ? 'bg-slack-sidebar-active text-white' : 'hover:bg-white/10 text-[#d1d2d3]'
              }`}
            >
              <item.icon size={18} className={activeView === item.id ? 'text-white' : 'text-white/50 group-hover:text-white/80'} />
              <span>{item.label}</span>
              {(item.badge ?? 0) > 0 && (
                <span className="absolute right-2 min-w-[18px] h-[18px] bg-[#e01e5a] text-white text-[10px] font-black rounded-full flex items-center justify-center px-1 shadow-sm border border-slack-sidebar">
                  {item.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Channels Section */}
        <div className="mb-4">
          <div className="flex items-center group px-3 mb-1 h-8">
            <button 
              onClick={() => setCollapsedChannels(!collapsedChannels)}
              className="p-1 hover:bg-white/10 rounded transition-colors"
            >
              <ChevronDown size={12} className={`text-white/40 transition-transform ${collapsedChannels ? '-rotate-90' : ''}`} />
            </button>
            <span className="text-[13px] font-medium text-white/50 flex-1 px-1 cursor-default">Channels</span>
            <button 
              onClick={() => setShowAddChannel(true)}
              className="p-1 opacity-0 group-hover:opacity-100 hover:bg-white/10 rounded transition-all text-white/50 hover:text-white"
            >
              <Plus size={16} />
            </button>
          </div>
          
          {!collapsedChannels && (
            <div className="px-3 space-y-0.5">
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
                    className={`w-full text-left flex items-center gap-2 px-3 py-1 rounded-md transition-all text-[14px] relative group ${
                      isActive 
                        ? 'bg-slack-sidebar-active text-white font-medium shadow-sm' 
                        : unreadCount > 0 
                          ? 'text-white font-black'
                          : 'hover:bg-white/10 text-[#d1d2d3]'
                    }`}
                  >
                    <Hash size={16} className={isActive ? 'text-white' : unreadCount > 0 ? 'text-white' : 'text-white/30 group-hover:text-white/60'} />
                    <span className="truncate flex-1">{ch.name}</span>
                    {unreadCount > 0 && !isActive && (
                      <span className="w-5 h-[18px] bg-[#e01e5a] text-white text-[10px] font-black rounded-full flex items-center justify-center border border-slack-sidebar shadow-sm">
                        {unreadCount}
                      </span>
                    )}
                  </button>
                );
              })}
              <button 
                onClick={() => setShowAddChannel(true)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[14px] text-white/50 hover:bg-white/10 rounded-md transition-all group"
              >
                <div className="w-7 h-7 bg-white/5 rounded-md flex items-center justify-center group-hover:bg-white/10 border border-transparent group-hover:border-white/10 transition-all">
                  <Plus size={16} />
                </div>
                <span className="font-medium">Add channels</span>
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
                const isOnline = onlineUsers.some((ou: any) => ou.id === u.id);
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
                      <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slack-sidebar ${isOnline ? 'bg-slack-green' : 'bg-transparent border-white/20'}`} />
                    </div>
                    <span className={`truncate font-medium flex-1 ${isOnline ? 'text-white' : 'text-white/50'}`}>{u.username}</span>
                  </div>
                );
              })}
              <button className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[14px] text-white/50 hover:bg-white/10 rounded-md transition-all group">
                <div className="w-7 h-7 bg-white/5 rounded-md flex items-center justify-center group-hover:bg-white/10 border border-transparent group-hover:border-white/10 transition-all">
                  <Plus size={16} />
                </div>
                <span className="font-medium">Add teammates</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* User Footer */}
      <div className="p-3 bg-white/5 transition-all group mt-auto border-t border-white/5">
        <div className="flex items-center gap-3">
          <div className="relative shrink-0 group-hover:scale-105 transition-transform cursor-pointer">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#e8912d] to-[#ffcc00] flex items-center justify-center font-black text-white text-base shadow-lg border border-white/10">
              {user?.username?.[0]?.toUpperCase() || '?'}
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-slack-sidebar rounded-full flex items-center justify-center">
              <div className="w-2.5 h-2.5 bg-slack-green rounded-full shadow-[0_0_8px_rgba(43,181,115,0.4)]" />
            </div>
          </div>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[14px] font-black text-white truncate leading-tight tracking-tight">{user?.username || 'Guest'}</span>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 bg-slack-green rounded-full" />
              <span className="text-[10px] text-white/50 font-bold uppercase tracking-widest leading-none">Active</span>
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showAddChannel && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[100]">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} className="bg-white rounded-xl p-8 w-full max-w-md shadow-2xl">
              <h3 className="text-2xl font-black text-gray-900 mb-2 tracking-tight">Create a channel</h3>
              <p className="text-gray-500 text-sm mb-6">Channels are where your team communicates. They’re best when organized around a topic.</p>
              <form onSubmit={handleCreate}>
                <div className="mb-6">
                  <label className="block text-xs font-bold uppercase tracking-widest text-gray-400 mb-2">Channel Name</label>
                  <div className="flex items-center border-2 border-gray-100 rounded-lg focus-within:border-slack-active transition-all group">
                    <span className="px-3 text-gray-400 font-bold group-focus-within:text-slack-active tracking-tighter">#</span>
                    <input autoFocus type="text" placeholder="e.g. general" className="w-full py-3 pr-3 bg-transparent outline-none text-gray-800 font-medium" value={newChannelName} onChange={e => setNewChannelName(e.target.value)} />
                  </div>
                </div>
                <div className="flex justify-end gap-3">
                  <button type="button" onClick={() => setShowAddChannel(false)} className="px-5 py-2.5 font-bold text-gray-500 hover:text-gray-900 transition-colors">Cancel</button>
                  <button type="submit" className="px-6 py-2.5 bg-[#4a154b] text-white font-black rounded-lg hover:bg-[#350d36] transition-transform active:scale-95 shadow-lg shadow-purple-900/20">Create</button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

