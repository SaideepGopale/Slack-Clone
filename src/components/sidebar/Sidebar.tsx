import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { Hash, Plus, LogOut, Circle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import axios from 'axios';
import { Channel } from '../../types';

export const Sidebar = ({ channels, currentChannel, onSelectChannel, onlineUsers }: any) => {
  const { user, logout } = useAuth();
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');

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

  return (
    <div className="w-64 bg-slack-purple text-gray-300 flex flex-col h-screen shrink-0 border-r border-slack-purple-hover">
      <div className="p-4 flex justify-between items-center bg-slack-purple-hover mb-2 group">
        <div className="flex items-center gap-2 text-white overflow-hidden">
          <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center font-bold text-white shrink-0">S</div>
          <span className="font-black text-lg truncate tracking-tight">Slick Workspace</span>
        </div>
        <button onClick={logout} className="p-1.5 hover:bg-white/10 rounded transition-all text-gray-400 hover:text-white opacity-0 group-hover:opacity-100"><LogOut size={16} /></button>
      </div>

      <div className="flex-1 overflow-y-auto sidebar-scrollbar px-2">
        <div className="mb-6">
          <div className="flex justify-between items-center px-4 mb-2 text-gray-400 text-[10px] font-bold uppercase tracking-wider group/title">
            <span>Channels</span>
            <button onClick={() => setShowAddChannel(true)} className="opacity-0 group-hover/title:opacity-100 hover:text-white transition-opacity"><Plus size={14} /></button>
          </div>
          <div className="space-y-0.5">
            {channels.map((ch: Channel) => (
              <button 
                key={ch.id} 
                onClick={() => onSelectChannel(ch)} 
                className={`w-full text-left flex items-center gap-2 px-4 py-1 rounded transition-colors text-sm ${
                  currentChannel?.id === ch.id ? 'bg-slack-active text-white font-medium' : 'hover:bg-slack-sidebar-hover'
                }`}
              >
                <Hash size={14} className={currentChannel?.id === ch.id ? 'text-white' : 'text-gray-500'} />
                <span className="truncate">{ch.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="mb-6">
          <div className="px-4 mb-2 text-gray-400 text-[10px] font-bold uppercase tracking-wider block">Direct Messages</div>
          <div className="space-y-0.5">
            {onlineUsers.map((u: any, i: number) => (
              <div key={i} className="flex items-center gap-2 px-4 py-1 text-sm hover:bg-slack-sidebar-hover rounded cursor-pointer transition-colors">
                <Circle size={8} fill="#2bac76" stroke="none" className="shrink-0" />
                <span className="truncate">{u.username}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="p-4 bg-slack-purple-hover flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-[#e8912d] flex items-center justify-center font-bold text-white text-sm shrink-0 shadow-inner">
          {user?.username[0]?.toUpperCase()}
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-bold text-white truncate">{user?.username}</span>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-slack-green"></div>
            <span className="text-[10px] text-gray-400 font-medium tracking-wide">Online</span>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showAddChannel && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
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
                  <button type="submit" className="px-6 py-2.5 bg-slack-purple text-white font-black rounded-lg hover:bg-slack-purple-hover transition-transform active:scale-95 shadow-lg shadow-purple-900/20">Create</button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
