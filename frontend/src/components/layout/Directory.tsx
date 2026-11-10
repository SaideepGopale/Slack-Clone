import axios from 'axios';
import { Filter, Grid, Hash, List as ListIcon, Search, UserPlus, Users } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../pages/workspace/WorkspaceContext';
import { useWorkspaces } from '../../pages/workspace/WorkspacesProvider';
import { invitationsApi } from '../../lib/api';
import { InviteMemberModal } from './InviteMemberModal';
import { PeopleDirectory } from '../people/PeopleDirectory';
import { InvitationsPanel } from '../workspaceAdmin/InvitationsPanel';
import { JoinRequestsPanel } from '../workspaceAdmin/JoinRequestsPanel';

// F1 removed the "User Groups" and "External" tabs (they only ever showed a
// "nothing here yet" placeholder). Invitations / Join Requests are management
// tabs, shown only when the server says the viewer may manage invitations.
const tabs = ['People', 'Channels', 'Invitations', 'Join Requests'];
const MANAGEMENT_TABS = new Set(['Invitations', 'Join Requests']);

export const Directory = ({ onChannelJoined, onlineUsers = [], onSelectUser }: { onChannelJoined?: () => void, onlineUsers?: any[], onSelectUser?: (userId: string) => void }) => {
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState(requestedTab && tabs.includes(requestedTab) ? requestedTab : 'Channels');
  // P3: follow ?tab= when it changes while the directory is already open.
  useEffect(() => {
    if (requestedTab && tabs.includes(requestedTab)) setActiveTab(requestedTab);
  }, [requestedTab]);
  const [search, setSearch] = useState('');
  const [channels, setChannels] = useState<any[]>([]);
  // F2: pending counts for the management tab badges. The lists themselves
  // live in the shared, token-free InvitationsPanel / JoinRequestsPanel.
  const [pendingInvites, setPendingInvites] = useState(0);
  const [pendingRequests, setPendingRequests] = useState(0);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showFilters, setShowFilters] = useState(false);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);

  const { user: currentUser } = useAuth();
  const { workspaceId } = useWorkspace();
  const canManageInvitations = !!useWorkspaces().getWorkspace(workspaceId)?.capabilities?.canManageInvitations;
  const visibleTabs = tabs.filter((tab) => !MANAGEMENT_TABS.has(tab) || canManageInvitations);
  const currentTab = visibleTabs.includes(activeTab) ? activeTab : 'Channels';

  const fetchData = async () => {
    try {
      setLoading(true);
      const channelsRes = await axios.get('/api/channels/all', { params: { workspaceId } });
      setChannels(Array.isArray(channelsRes.data) ? channelsRes.data : []);
    } catch (err) {
      console.error('Failed to fetch directory data', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [workspaceId]);

  // Badge counts for managers only (the old GET /api/invitations listing,
  // which carried tokens, is no longer used anywhere).
  useEffect(() => {
    if (!canManageInvitations) return;
    let cancelled = false;
    Promise.all([invitationsApi.listWorkspaceInvitations(workspaceId), invitationsApi.listJoinRequests(workspaceId)])
      .then(([invites, requests]) => {
        if (cancelled) return;
        setPendingInvites(invites.filter((inv) => inv.state === 'pending').length);
        setPendingRequests(requests.length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceId, canManageInvitations]);

  // InviteMemberModal owns generating/copying the invite link itself (GET
  // /api/workspaces/:workspaceId/invite-link) — this just refreshes this
  // page's own data on close, in case anything else here depends on it.
  const closeInviteModal = () => {
    setIsInviteModalOpen(false);
    fetchData();
  };

  const handleJoinChannel = async (channelId: string) => {
    try {
      await axios.post(`/api/channels/${channelId}/join`);
      onChannelJoined?.();
    } catch (err) {
      console.error('Failed to join channel', err);
    }
  };

  const filteredChannels = channels.filter((c: any) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col bg-white overflow-hidden h-full selection:bg-slack-purple/10">
      
      {/* Header */}
      <div className="h-[49px] border-b border-gray-200 flex items-center justify-between px-4 md:px-5 shrink-0 bg-white z-20">
        <h1 className="font-black text-base md:text-lg text-gray-900 tracking-tight flex items-center gap-2">
          {currentTab === 'People' && <Users size={18} className="text-gray-400" />}
          {currentTab === 'Channels' && <Hash size={18} className="text-gray-400" />}
          {currentTab}
        </h1>
        {currentTab === 'People' && canManageInvitations && (
          <button
            onClick={() => setIsInviteModalOpen(true)}
            className="bg-violet-600 hover:bg-violet-700 text-white font-medium px-4 py-2 rounded-lg shadow-sm flex items-center gap-2 text-sm transition-colors active:scale-95"
          >
            <UserPlus size={16} />
            Invite Members
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto slack-scrollbar flex flex-col">
        {/* Tabs Bar */}
        <div className="px-4 md:px-6 border-b border-gray-100 bg-white sticky top-0 z-10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6 overflow-x-auto no-scrollbar scroll-smooth">
              {visibleTabs.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`py-3.5 text-[13px] font-bold border-b-2 transition-all relative whitespace-nowrap ${currentTab === tab
                      ? 'border-slack-purple text-gray-900'
                      : 'border-transparent text-gray-500 hover:text-gray-900'
                    }`}
                >
                  {tab}
                  {tab === 'Invitations' && pendingInvites > 0 && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-gray-100 text-[10px] text-gray-500 font-black">{pendingInvites}</span>
                  )}
                  {tab === 'Join Requests' && pendingRequests > 0 && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-[10px] text-amber-700 font-black">{pendingRequests}</span>
                  )}
                </button>
              ))}
            </div>

            <div className="hidden sm:flex items-center gap-2 py-2">
              <button onClick={() => setViewMode('grid')} className={`p-1.5 rounded transition-colors ${viewMode === 'grid' ? 'bg-gray-100 text-gray-900' : 'text-gray-400 hover:text-gray-600'}`}><Grid size={16} /></button>
              <button onClick={() => setViewMode('list')} className={`p-1.5 rounded transition-colors ${viewMode === 'list' ? 'bg-gray-100 text-gray-900' : 'text-gray-400 hover:text-gray-600'}`}><ListIcon size={16} /></button>
            </div>
          </div>
        </div>

        <div className="p-4 md:p-8 max-w-7xl mx-auto w-full">
          {/* Invite Banner — only for people who can actually invite (F1). */}
          {canManageInvitations && (
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
            <button type="button" onClick={() => setIsInviteModalOpen(true)} className="theme-fixed w-full md:w-auto px-6 py-3 bg-white text-[#1264a3] font-black rounded-xl hover:bg-white/90 transition-colors text-[15px] shadow-xl shadow-black/10 shrink-0">
              Invite people
            </button>
          </motion.div>
          )}

          <InviteMemberModal isOpen={isInviteModalOpen} onClose={closeInviteModal} workspaceId={workspaceId} />

          {/* Search and Filters Bar — Channels only (People has its own server-side search; the management tabs have their own controls) */}
          {currentTab === 'Channels' && (
          <div className="flex flex-col sm:flex-row gap-3 mb-8">
            <div className="flex-1 relative group">
              <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-slack-purple transition-colors" />
              <input type="text" placeholder="Filter channels by name..." aria-label="Filter channels" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full bg-white border border-gray-200 rounded-xl py-2.5 pl-11 pr-4 text-[13px] font-medium outline-none focus:ring-2 focus:ring-slack-purple/10 focus:border-slack-purple transition-all shadow-sm" />
            </div>
            <button onClick={() => setShowFilters(!showFilters)} className={`px-4 py-2.5 rounded-xl border flex items-center justify-center gap-2 text-[13px] font-bold transition-all ${showFilters ? 'bg-gray-100 border-gray-300 text-gray-900 shadow-inner' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              <Filter size={16} /> Filter
            </button>
          </div>
          )}

          <AnimatePresence>
            {showFilters && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden mb-6">
                <div className="p-5 border border-gray-200 rounded-xl bg-gray-50/50 flex flex-wrap gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Status</label>
                    <select className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-xs font-bold outline-none focus:border-slack-purple"><option>All Members</option><option>Online Only</option><option>Away</option></select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Sort By</label>
                    <select className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-xs font-bold outline-none focus:border-slack-purple"><option>A-Z</option><option>Newest Members</option></select>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {loading ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <div className="w-10 h-10 border-4 border-gray-100 border-t-slack-purple rounded-full animate-spin" />
              <span className="text-gray-400 font-black text-sm uppercase tracking-widest">Scanning {currentTab}...</span>
            </div>
          ) : (
            <>
              {currentTab === 'People' && currentUser && (
                <PeopleDirectory workspaceId={workspaceId} currentUserId={currentUser.id} onMessage={(id) => onSelectUser?.(id)} />
              )}

              {/* 👇 UPGRADED: Channels Tab with Delete Button */}
              {currentTab === 'Channels' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {filteredChannels.map((channel) => {
                    return (
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
                              <span className="text-[10px] bg-gray-100 text-gray-500 font-black px-1.5 py-0.5 rounded tracking-tighter uppercase">
                                {channel.isAnnouncement ? 'Announcement' : channel.visibility === 'PRIVATE' ? 'Private' : 'Public'}
                              </span>
                              <span className="text-[10px] text-gray-400 font-bold">Workspace Project</span>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          {/* Batch 3/D: private channels are joined by invitation only. */}
                          {channel.isMember ? (
                            <span className="px-3 py-2 text-[11px] font-black text-gray-400 uppercase tracking-wider">Joined</span>
                          ) : channel.visibility !== 'PRIVATE' ? (
                            <button
                              onClick={() => handleJoinChannel(channel.id)}
                              className="px-5 py-2 bg-white border border-gray-300 text-gray-700 font-black rounded-lg hover:border-slack-purple hover:text-slack-purple hover:bg-slack-purple/5 transition-all text-[11px] uppercase tracking-wider"
                            >
                              Join
                            </button>
                          ) : null}
                          
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}

              {/* F2: shared, token-free management panels (also used in workspace settings). */}
              {currentTab === 'Invitations' && canManageInvitations && (
                <InvitationsPanel workspaceId={workspaceId} onPendingCountChange={setPendingInvites} />
              )}

              {currentTab === 'Join Requests' && canManageInvitations && (
                <JoinRequestsPanel workspaceId={workspaceId} onCountChange={setPendingRequests} />
              )}

              {currentTab === 'Channels' && filteredChannels.length === 0 && (
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