import React, { useState, useEffect } from 'react';
import { Search, UserPlus, Filter, Grid, List as ListIcon, MoreHorizontal, Mail, ChevronRight, Share2, Hash, ExternalLink, Users, AlertCircle, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';

const tabs = ['People', 'Channels', 'User Groups', 'External', 'Invitations'];

const InviteModal = ({ isOpen, onClose, onInvite }: { isOpen: boolean, onClose: () => void, onInvite: (email: string) => void }) => {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl"
      >
        <div className="p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-slack-purple/10 rounded-2xl flex items-center justify-center text-slack-purple shrink-0">
              <Mail size={24} />
            </div>
            <div>
              <h3 className="text-xl font-black text-gray-900 tracking-tight">Invite to Slack</h3>
              <p className="text-xs text-gray-400 font-bold uppercase tracking-widest leading-none mt-1">Grow your workspace</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 block">Email Address</label>
              <input 
                autoFocus
                type="email" 
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm font-medium outline-none focus:ring-2 focus:ring-slack-purple/10 focus:border-slack-purple transition-all"
              />
            </div>
          </div>

          <div className="flex gap-3 mt-8">
            <button 
              onClick={onClose}
              className="flex-1 px-6 py-3 border border-gray-200 text-gray-600 font-black rounded-xl hover:bg-gray-50 transition-all active:scale-95 text-sm"
            >
              Cancel
            </button>
            <button 
              onClick={async () => {
                if (!email) return;
                setLoading(true);
                await onInvite(email);
                setLoading(false);
                onClose();
                setEmail('');
              }}
              disabled={loading}
              className="flex-1 px-6 py-3 bg-slack-purple text-white font-black rounded-xl hover:bg-slack-purple-hover transition-all active:scale-95 text-sm disabled:opacity-50"
            >
              {loading ? 'Sending...' : 'Send Invite'}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export const Directory = ({ onChannelJoined, onlineUsers = [], onSelectUser }: { onChannelJoined?: () => void, onlineUsers?: any[], onSelectUser?: (userId: string) => void }) => {
  const [activeTab, setActiveTab] = useState('People');
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<any[]>([]);
  const [channels, setChannels] = useState<any[]>([]);
  const [invitations, setInvitations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showFilters, setShowFilters] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const { user: currentUser } = useAuth();

  const fetchData = async () => {
    try {
      setLoading(true);
      const [usersRes, channelsRes, invitationsRes] = await Promise.all([
        axios.get('/api/users'),
        axios.get('/api/channels/all'),
        axios.get('/api/invitations')
      ]);
      setUsers(usersRes.data);
      setChannels(channelsRes.data);
      setInvitations(invitationsRes.data);
    } catch (err) {
      console.error('Failed to fetch directory data', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleInvite = async (email: string) => {
    try {
      await axios.post('/api/invitations', { email });
      await fetchData();
    } catch (err) {
      console.error('Failed to send invitation', err);
    }
  };

  const handleJoinChannel = async (channelId: string) => {
    try {
      await axios.post(`/api/channels/${channelId}/join`);
      onChannelJoined?.();
    } catch (err) {
      console.error('Failed to join channel', err);
    }
  };

  const filteredUsers = users.filter((u: any) => 
    u.username.toLowerCase().includes(search.toLowerCase()) ||
    u.email?.toLowerCase().includes(search.toLowerCase())
  );

  const filteredChannels = channels.filter((c: any) => 
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col bg-white overflow-hidden h-full selection:bg-slack-purple/10">
      {/* Header */}
      <div className="h-[49px] border-b border-gray-200 flex items-center px-4 md:px-5 shrink-0 bg-white z-20">
        <h1 className="font-black text-base md:text-lg text-gray-900 tracking-tight flex items-center gap-2">
          {activeTab === 'People' && <Users size={18} className="text-gray-400" />}
          {activeTab === 'Channels' && <Hash size={18} className="text-gray-400" />}
          {activeTab}
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto slack-scrollbar flex flex-col">
        {/* Tabs Bar */}
        <div className="px-4 md:px-6 border-b border-gray-100 bg-white sticky top-0 z-10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6 overflow-x-auto no-scrollbar scroll-smooth">
              {tabs.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`py-3.5 text-[13px] font-bold border-b-2 transition-all relative whitespace-nowrap ${
                    activeTab === tab 
                    ? 'border-slack-purple text-gray-900' 
                    : 'border-transparent text-gray-500 hover:text-gray-900'
                  }`}
                >
                  {tab}
                  {tab === 'Invitations' && invitations.length > 0 && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-gray-100 text-[10px] text-gray-500 font-black">{invitations.length}</span>
                  )}
                </button>
              ))}
            </div>
            
            <div className="hidden sm:flex items-center gap-2 py-2">
              <button 
                onClick={() => setViewMode('grid')}
                className={`p-1.5 rounded transition-colors ${viewMode === 'grid' ? 'bg-gray-100 text-gray-900' : 'text-gray-400 hover:text-gray-600'}`}
              >
                <Grid size={16} />
              </button>
              <button 
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded transition-colors ${viewMode === 'list' ? 'bg-gray-100 text-gray-900' : 'text-gray-400 hover:text-gray-600'}`}
              >
                <ListIcon size={16} />
              </button>
            </div>
          </div>
        </div>

        <div className="p-4 md:p-8 max-w-7xl mx-auto w-full">
          {/* Invite Banner */}
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8 p-6 md:p-8 rounded-2xl bg-gradient-to-br from-[#1264a3] to-[#0b4d7c] text-white flex flex-col md:flex-row items-center justify-between gap-6 shadow-[0_20px_50px_rgba(18,100,163,0.15)] ring-1 ring-white/10"
          >
            <div className="flex items-center gap-6 text-center md:text-left flex-col md:flex-row">
              <div className="w-16 h-16 bg-white/10 rounded-2xl flex items-center justify-center backdrop-blur-md shrink-0 border border-white/20">
                <UserPlus size={32} className="text-white" />
              </div>
              <div className="flex flex-col gap-1">
                <h3 className="text-xl md:text-2xl font-black tracking-tight">Expand your workspace</h3>
                <p className="text-blue-100/70 text-sm font-medium max-w-md">Collaborate better with your teammates. Invite them to join #{filteredChannels[0]?.name || 'general'}.</p>
              </div>
            </div>
            <button 
              onClick={() => setShowInviteModal(true)}
              className="w-full md:w-auto px-6 py-3 bg-white text-[#1264a3] font-black rounded-xl hover:bg-white/90 transition-all active:scale-95 text-[15px] shadow-xl shadow-black/10 shrink-0"
            >
              Invite people
            </button>
          </motion.div>

          <InviteModal 
            isOpen={showInviteModal} 
            onClose={() => setShowInviteModal(false)} 
            onInvite={handleInvite} 
          />

          {/* Search and Filters Bar */}
          <div className="flex flex-col sm:flex-row gap-3 mb-8">
            <div className="flex-1 relative group">
              <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-slack-purple transition-colors" />
              <input 
                type="text" 
                placeholder={`Filter by name or ${activeTab === 'People' ? 'email' : 'tag'}...`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-white border border-gray-200 rounded-xl py-2.5 pl-11 pr-4 text-[13px] font-medium outline-none focus:ring-2 focus:ring-slack-purple/10 focus:border-slack-purple transition-all shadow-sm"
              />
            </div>
            <button 
              onClick={() => setShowFilters(!showFilters)}
              className={`px-4 py-2.5 rounded-xl border flex items-center justify-center gap-2 text-[13px] font-bold transition-all ${
                showFilters ? 'bg-gray-100 border-gray-300 text-gray-900 shadow-inner' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              <Filter size={16} />
              Filter
            </button>
          </div>

          <AnimatePresence>
            {showFilters && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden mb-6"
              >
                <div className="p-5 border border-gray-200 rounded-xl bg-gray-50/50 flex flex-wrap gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Status</label>
                    <select className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-xs font-bold outline-none focus:border-slack-purple">
                      <option>All Members</option>
                      <option>Online Only</option>
                      <option>Away</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Sort By</label>
                    <select className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-xs font-bold outline-none focus:border-slack-purple">
                      <option>A-Z</option>
                      <option>Newest Members</option>
                    </select>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {loading ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <div className="w-10 h-10 border-4 border-gray-100 border-t-slack-purple rounded-full animate-spin" />
              <span className="text-gray-400 font-black text-sm uppercase tracking-widest">Scanning {activeTab}...</span>
            </div>
          ) : (
            <>
              {activeTab === 'People' && (
                viewMode === 'grid' ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-5">
                    {filteredUsers.map((user) => {
                      const isOnline = onlineUsers.some((ou: any) => ou.id === user.id);
                      return (
                        <motion.div 
                          key={user.id}
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          whileHover={{ y: -4 }}
                          className="bg-white border border-gray-200 rounded-2xl p-5 hover:border-slack-purple/30 hover:shadow-[0_12px_24px_-8px_rgba(0,0,0,0.08)] transition-all group flex flex-col items-center text-center relative"
                        >
                          <div className="relative mb-4">
                            <div className="w-20 h-20 rounded-[1.8rem] bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center font-black text-gray-500 text-2xl border-2 border-white shadow-sm ring-1 ring-gray-100 group-hover:scale-105 transition-transform">
                              {user.username.substring(0, 1).toUpperCase()}
                            </div>
                            {isOnline && (
                              <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-white rounded-full flex items-center justify-center shadow-md">
                                <div className="w-4 h-4 bg-slack-green rounded-full border-2 border-white" />
                              </div>
                            )}
                          </div>
                          
                          <div className="mb-4">
                            <h4 className="font-black text-gray-900 tracking-tight truncate max-w-full text-base">
                              {user.username} {user.id === currentUser?.id && '(You)'}
                            </h4>
                            <p className="text-[11px] text-gray-400 font-bold uppercase tracking-tight">Active User</p>
                          </div>

                          <div className="flex items-center gap-2 w-full pt-4 border-t border-gray-50 mt-auto">
                            <button 
                              onClick={() => onSelectUser?.(user.id)}
                              className="flex-1 py-2 bg-gray-50 hover:bg-gray-100 rounded-lg text-gray-600 text-[11px] font-black transition-all hover:text-gray-900 active:scale-95"
                            >
                              Message
                            </button>
                            <button className="p-2 hover:bg-gray-100 rounded-lg text-gray-400 transition-colors">
                              <MoreHorizontal size={16} />
                            </button>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex flex-col border border-gray-100 rounded-xl overflow-hidden bg-white shadow-sm">
                    {filteredUsers.map((user, idx) => (
                      <div 
                        key={user.id} 
                        onClick={() => onSelectUser?.(user.id)}
                        className={`flex items-center justify-between p-4 px-6 hover:bg-gray-50 transition-colors group cursor-pointer ${idx !== filteredUsers.length - 1 ? 'border-b border-gray-50' : ''}`}
                      >
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center font-black text-gray-500 text-sm">
                            {user.username.substring(0, 2).toUpperCase()}
                          </div>
                          <div className="flex flex-col">
                            <span className="font-bold text-gray-900">{user.username}</span>
                            <span className="text-xs text-gray-400">Software Engineer</span>
                          </div>
                        </div>
                        <button className="p-2 text-gray-400 hover:text-slack-purple transition-colors opacity-0 group-hover:opacity-100">
                          <Mail size={18} />
                        </button>
                      </div>
                    ))}
                  </div>
                )
              )}

              {activeTab === 'Channels' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {filteredChannels.map((channel) => (
                    <motion.div 
                      key={channel.id}
                      whileHover={{ scale: 1.01 }}
                      className="flex items-center justify-between p-5 bg-white border border-gray-200 rounded-2xl hover:border-slack-purple/40 hover:shadow-lg transition-all group"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-xl bg-gray-50 flex items-center justify-center text-gray-300 border border-gray-100">
                          <Hash size={24} />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="font-black text-gray-900 tracking-tight group-hover:text-slack-purple transition-colors">#{channel.name}</span>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] bg-gray-100 text-gray-500 font-black px-1.5 py-0.5 rounded tracking-tighter uppercase">Public</span>
                            <span className="text-[10px] text-gray-400 font-bold">128 members</span>
                          </div>
                        </div>
                      </div>
                      
                      <button 
                        onClick={() => handleJoinChannel(channel.id)}
                        className="px-5 py-2 bg-white border border-gray-300 text-gray-700 font-black rounded-lg hover:border-slack-purple hover:text-slack-purple hover:bg-slack-purple/5 transition-all text-[11px] uppercase tracking-wider"
                      >
                        Join
                      </button>
                    </motion.div>
                  ))}
                </div>
              )}

              {activeTab === 'Invitations' && (
                <div className="flex flex-col gap-4">
                  {invitations.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                      <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-6 text-gray-300">
                        <Mail size={40} />
                      </div>
                      <h3 className="text-xl font-black text-gray-900 mb-2">No pending invitations</h3>
                      <p className="text-gray-500 max-w-sm">When you invite teammates by email, they will appear here until they join.</p>
                      <button 
                        onClick={() => setShowInviteModal(true)}
                        className="mt-6 px-6 py-2 bg-slack-purple text-white font-black rounded-lg transition-all active:scale-95 shadow-lg shadow-purple-900/10"
                      >
                        Invite Someone
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {invitations.map((inv) => (
                        <div key={inv.id} className="p-5 bg-white border border-gray-100 rounded-2xl flex flex-col gap-4 group hover:border-slack-purple/20 transition-all">
                          <div className="flex items-center justify-between">
                            <div>
                               <p className="font-black text-gray-900 tracking-tight truncate max-w-[150px]">{inv.email}</p>
                               <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-0.5">Status: {inv.status}</p>
                            </div>
                            <div className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center text-gray-400 group-hover:bg-slack-purple/10 group-hover:text-slack-purple transition-all">
                              <Clock size={20} />
                            </div>
                          </div>
                          
                          <button 
                            onClick={() => {
                              const joinLink = `${window.location.origin}/join/${inv.token}`;
                              navigator.clipboard.writeText(joinLink);
                              alert('Invite link copied to clipboard!');
                            }}
                            className="w-full flex items-center justify-center gap-2 py-2 bg-gray-50 hover:bg-gray-100 rounded-lg text-[11px] font-black text-gray-600 transition-all"
                          >
                            <Share2 size={14} />
                            Copy Invite Link
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {['User Groups', 'External'].includes(activeTab) && (
                <div className="flex flex-col items-center justify-center py-24 text-center">
                  <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-6 text-gray-300">
                    <AlertCircle size={40} />
                  </div>
                  <h3 className="text-xl font-black text-gray-900 mb-2">Nothing to see here yet</h3>
                  <p className="text-gray-500 max-w-sm font-medium">We're still workspace setup mode. This section will be populated once you grow your team.</p>
                </div>
              )}

              {((activeTab === 'People' && filteredUsers.length === 0) || (activeTab === 'Channels' && filteredChannels.length === 0)) && (
                <div className="flex flex-col items-center justify-center py-20 bg-gray-50/50 rounded-2xl border-2 border-dashed border-gray-200">
                  <Search size={32} className="text-gray-300 mb-4" />
                  <p className="text-gray-400 font-black text-sm uppercase tracking-widest">No results found for "{search}"</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
