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
  onlineUsers, 
  allUsers = [],
  activeView,
  onViewChange
}: any) => {
  const { user, logout } = useAuth();
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [collapsedChannels, setCollapsedChannels] = useState(false);
  const [collapsedDMs, setCollapsedDMs] = useState(false);

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

  const navItems = [
    { id: 'home', label: 'Home', icon: Home },
    { id: 'dms', label: 'DMs', icon: MessageSquare },
    { id: 'activity', label: 'Activity', icon: Bell },
    { id: 'directory', label: 'People', icon: Users },
    { id: 'more', label: 'More', icon: MoreHorizontal },
  ];

  return (
    <div className="w-full h-full bg-[#3f0e40] text-gray-400 flex flex-col shrink-0">
      {/* Workspace Header */}
      <div className="h-12 flex items-center justify-between px-4 hover:bg-[#522653] cursor-pointer transition-colors group">
        <div className="flex items-center gap-2 text-white overflow-hidden">
          <span className="font-black text-base truncate tracking-tight">Slick Workspace</span>
          <ChevronDown size={14} className="text-gray-400 group-hover:text-white" />
        </div>
        <button onClick={logout} className="p-1.5 hover:bg-white/10 rounded transition-all text-gray-400 hover:text-white opacity-0 group-hover:opacity-100">
          <LogOut size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto slack-scrollbar py-4 px-2">
        {/* Main Menu Items */}
        <div className="space-y-0.5 mb-8">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={`w-full flex items-center gap-2.5 px-4 py-1.5 rounded-md transition-colors text-sm font-medium ${
                activeView === item.id ? 'bg-[#1164a3] text-white' : 'hover:bg-[#350d36]'
              }`}
            >
              <item.icon size={18} className={activeView === item.id ? 'text-white' : 'text-gray-400'} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        {/* Channels Section */}
        <div className="mb-8">
          <div className="flex items-center group px-2 mb-1">
            <button 
              onClick={() => setCollapsedChannels(!collapsedChannels)}
              className="p-1 hover:bg-white/10 rounded transition-colors"
            >
              <ChevronDown size={14} className={`transition-transform ${collapsedChannels ? '-rotate-90' : ''}`} />
            </button>
            <span className="text-xs font-medium px-1 flex-1 cursor-default">Channels</span>
            <button 
              onClick={() => setShowAddChannel(true)}
              className="p-1 opacity-0 group-hover:opacity-100 hover:bg-white/10 rounded transition-all"
            >
              <Plus size={14} />
            </button>
          </div>
          
          {!collapsedChannels && (
            <div className="space-y-0.5">
              {channels.map((ch: Channel) => (
                <button 
                  key={ch.id} 
                  onClick={() => {
                    onViewChange('chat');
                    onSelectChannel(ch);
                  }} 
                  className={`w-full text-left flex items-center gap-2.5 px-6 py-1 rounded-md transition-colors text-sm ${
                    activeView === 'chat' && currentChannel?.id === ch.id 
                      ? 'bg-[#1164a3] text-white' 
                      : 'hover:bg-[#350d36]'
                  }`}
                >
                  <Hash size={16} className={currentChannel?.id === ch.id ? 'text-white' : 'text-gray-500'} />
                  <span className="truncate">{ch.name}</span>
                </button>
              ))}
              <button 
                onClick={() => setShowAddChannel(true)}
                className="w-full flex items-center gap-2.5 px-6 py-1 text-sm hover:bg-[#350d36] rounded-md transition-colors group"
              >
                <div className="w-4 h-4 bg-white/10 rounded flex items-center justify-center group-hover:bg-white/20">
                  <Plus size={10} />
                </div>
                <span>Add channels</span>
              </button>
            </div>
          )}
        </div>

        {/* Direct Messages Section */}
        <div className="mb-8">
          <div className="flex items-center group px-2 mb-1">
            <button 
              onClick={() => setCollapsedDMs(!collapsedDMs)}
              className="p-1 hover:bg-white/10 rounded transition-colors"
            >
              <ChevronDown size={14} className={`transition-transform ${collapsedDMs ? '-rotate-90' : ''}`} />
            </button>
            <span className="text-xs font-medium px-1 flex-1 cursor-default">Direct Messages</span>
            <button className="p-1 opacity-0 group-hover:opacity-100 hover:bg-white/10 rounded transition-all">
              <Plus size={14} />
            </button>
          </div>

          {!collapsedDMs && (
            <div className="space-y-0.5">
              {allUsers.filter((u: any) => u.id !== user?.id).map((u: any) => {
                const isOnline = onlineUsers.some((ou: any) => ou.id === u.id);
                return (
                  <div key={u.id} className="flex items-center gap-2.5 px-6 py-1 text-sm hover:bg-[#350d36] rounded-md cursor-pointer transition-colors group/dm">
                    <div className="relative">
                      <div className={`w-3 h-3 rounded-full border-2 border-[#3f0e40] ${isOnline ? 'bg-slack-green' : 'border-gray-500'}`} />
                    </div>
                    <span className={`truncate ${isOnline ? 'text-gray-200' : 'text-gray-400'}`}>{u.username}</span>
                  </div>
                );
              })}
              <button className="w-full flex items-center gap-2.5 px-6 py-1 text-sm hover:bg-[#350d36] rounded-md transition-colors group">
                <div className="w-4 h-4 bg-white/10 rounded flex items-center justify-center group-hover:bg-white/20">
                  <Plus size={10} />
                </div>
                <span>Add teammates</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* User Footer */}
      <div className="p-4 bg-[#3f0e40] border-t border-white/5 flex items-center gap-2.5 hover:bg-[#522653] cursor-pointer transition-colors group">
        <div className="relative">
          <div className="w-8 h-8 rounded-lg bg-[#e8912d] flex items-center justify-center font-bold text-white text-sm shrink-0 shadow-inner">
            {user?.username?.[0]?.toUpperCase() || '?'}
          </div>
          <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-[#3f0e40] rounded-full flex items-center justify-center">
            <div className="w-2 h-2 bg-slack-green rounded-full" />
          </div>
        </div>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-sm font-bold text-white truncate">{user?.username || 'Guest'}</span>
          <span className="text-[10px] text-gray-400 font-medium tracking-wide">Active</span>
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

