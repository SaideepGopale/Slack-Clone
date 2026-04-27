import React, { useState, useEffect } from 'react';
import { Search, UserPlus, Filter, Grid, List as ListIcon, MoreHorizontal, Mail, ChevronRight, Share2, Hash } from 'lucide-react';
import { motion } from 'motion/react';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';

const tabs = ['People', 'Channels', 'User Groups', 'External', 'Invitations'];

export const Directory = ({ onChannelJoined }: { onChannelJoined?: () => void }) => {
  const [activeTab, setActiveTab] = useState('People');
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<any[]>([]);
  const [channels, setChannels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const { user: currentUser } = useAuth();

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [usersRes, channelsRes] = await Promise.all([
          axios.get('/api/users'),
          axios.get('/api/channels/all')
        ]);
        setUsers(usersRes.data);
        setChannels(channelsRes.data);
      } catch (err) {
        console.error('Failed to fetch directory data', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const handleJoinChannel = async (channelId: string) => {
    try {
      await axios.post(`/api/channels/${channelId}/join`);
      onChannelJoined?.();
      alert('Joined channel successfully!');
    } catch (err) {
      console.error('Failed to join channel', err);
    }
  };

  const filteredUsers = users.filter((u: any) => 
    u.username.toLowerCase().includes(search.toLowerCase())
  );

  const filteredChannels = channels.filter((c: any) => 
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col bg-white overflow-hidden">
      {/* Page Titlebar */}
      <div className="h-12 border-b border-gray-100 flex items-center px-6 shrink-0 bg-white shadow-sm z-10">
        <h1 className="font-black text-lg text-gray-900 tracking-tight">{activeTab}</h1>
      </div>

      <div className="flex-1 overflow-y-auto slack-scrollbar">
        {/* Tabs Scrollable */}
        <div className="px-4 md:px-6 border-b border-gray-100 bg-white sticky top-0 z-10 overflow-x-auto no-scrollbar">
          <div className="flex items-center gap-4 md:gap-6 min-w-max">
            {tabs.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`py-3 text-sm font-bold border-b-2 transition-all relative ${
                  activeTab === tab ? 'border-[#1264a3] text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-900'
                }`}
              >
                {tab}
                {tab === 'Invitations' && (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-gray-100 text-[10px] text-gray-500">2</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="p-4 md:p-6 max-w-7xl mx-auto w-full">
          {/* Invite Banner */}
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 md:mb-8 p-6 rounded-xl bg-gradient-to-r from-[#1264a3] to-[#0b4d7c] text-white flex flex-col sm:flex-row items-center justify-between gap-6 shadow-lg shadow-blue-900/10"
          >
            <div className="flex items-center gap-5 text-center sm:text-left flex-col sm:flex-row">
              <div className="w-14 h-14 bg-white/20 rounded-2xl flex items-center justify-center backdrop-blur-md shrink-0">
                <UserPlus size={28} className="text-white" />
              </div>
              <div className="flex flex-col">
                <h3 className="text-xl font-black tracking-tight">Bring your team to Slick</h3>
                <p className="text-blue-100/80 text-sm font-medium">Work together in shared channels for projects, support, and fun.</p>
              </div>
            </div>
            <button className="w-full sm:w-auto px-5 py-2.5 bg-white text-[#1264a3] font-black rounded-lg hover:bg-blue-50 transition-all active:scale-95 text-sm shadow-md shrink-0">
              Invite People
            </button>
          </motion.div>

          {/* Search and Filters */}
          <div className="flex flex-col md:flex-row gap-4 mb-8">
            <div className="flex-1 relative group">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-[#1264a3] transition-colors" />
              <input 
                type="text" 
                placeholder={`Search ${activeTab.toLowerCase()}...`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-white border-2 border-gray-100 rounded-xl py-3 pl-11 pr-4 text-sm outline-none focus:border-[#1264a3] transition-all shadow-sm"
              />
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20 text-gray-400 font-bold">Loading {activeTab}...</div>
          ) : (
            <div className="grid gap-3">
              {activeTab === 'People' && filteredUsers.map((user) => (
                <motion.div 
                  key={user.id}
                  whileHover={{ x: 4 }}
                  className="flex items-center justify-between p-4 bg-white border border-gray-100 rounded-xl hover:border-gray-300 hover:shadow-md transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center font-black text-gray-600 text-lg border border-gray-200">
                      {user.username.substring(0, 2).toUpperCase()}
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="font-black text-gray-900 tracking-tight group-hover:text-[#1264a3] transition-colors">
                        {user.username} {user.id === currentUser?.id && '(You)'}
                      </span>
                      <span className="text-xs text-gray-500 font-medium">Slick Member</span>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-6">
                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button className="p-2 hover:bg-gray-100 rounded-lg text-gray-400 transition-colors">
                        <Mail size={16} />
                      </button>
                      <button className="p-2 hover:bg-gray-100 rounded-lg text-gray-400 transition-colors">
                        <MoreHorizontal size={16} />
                      </button>
                    </div>
                  </div>
                </motion.div>
              ))}

              {activeTab === 'Channels' && filteredChannels.map((channel) => (
                <motion.div 
                  key={channel.id}
                  whileHover={{ x: 4 }}
                  className="flex items-center justify-between p-4 bg-white border border-gray-100 rounded-xl hover:border-gray-300 hover:shadow-md transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-gray-50 flex items-center justify-center text-gray-400 border border-gray-100">
                      <Hash size={24} />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="font-black text-gray-900 tracking-tight group-hover:text-[#1264a3] transition-colors">#{channel.name}</span>
                      <span className="text-xs text-gray-500 font-medium tracking-tight">Public Channel</span>
                    </div>
                  </div>
                  
                  <button 
                    onClick={() => handleJoinChannel(channel.id)}
                    className="px-4 py-2 bg-white border border-gray-200 text-gray-700 font-bold rounded-lg hover:border-[#1264a3] hover:text-[#1264a3] transition-all text-xs"
                  >
                    Join Channel
                  </button>
                </motion.div>
              ))}

              {((activeTab === 'People' && filteredUsers.length === 0) || (activeTab === 'Channels' && filteredChannels.length === 0)) && (
                <div className="text-center py-20 text-gray-400 font-medium">No results found for "{search}"</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
