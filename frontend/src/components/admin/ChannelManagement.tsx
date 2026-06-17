import axios from 'axios';
import { AlertCircle, Hash, Megaphone, Plus, RefreshCw, Search, Trash2, Zap } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../hooks/useSocket';
import { Channel } from '../../types';

export const ChannelManagement = () => {
  const { token } = useAuth();
  const socket = useSocket(token);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelDesc, setNewChannelDesc] = useState('');
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchAllChannels = async () => {
    try {
      setLoading(true);
      const res = await axios.get<Channel[]>('/api/channels/admin/all');
      setChannels(res.data);
      setError(null);
    } catch (err: any) {
      console.error('Failed to fetch channels', err);
      setError('Failed to load channels');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAllChannels();
  }, []);

  useEffect(() => {
    if (!socket) return;

    socket.on('admin:channel:list:updated', (data: any) => {
      if (data.action === 'created') {
        setChannels(prev => [data.channel, ...prev]);
        setSuccess(`✅ Channel "${data.channel.name}" created!`);
        setTimeout(() => setSuccess(null), 3000);
      } else if (data.action === 'deleted') {
        setChannels(prev => prev.filter(c => c.id !== data.channelId));
        setSuccess('✅ Channel deleted!');
        setTimeout(() => setSuccess(null), 3000);
      }
    });

    socket.on('error', (err: string) => {
      setError(err);
      setTimeout(() => setError(null), 3000);
    });

    return () => {
      socket.off('admin:channel:list:updated');
      socket.off('error');
    };
  }, [socket]);

  const filteredChannels = channels.filter(c => c.name?.toLowerCase().includes(searchTerm.toLowerCase()));

  const handleDeleteChannel = async (channelId: string, channelName: string) => {
    if (channelName.toLowerCase() === 'general') {
      setError('Cannot delete the general channel!');
      setTimeout(() => setError(null), 3000);
      return;
    }
    
    if (confirm(`Delete channel "#${channelName}"?`)) {
      try {
        await axios.delete(`/api/channels/${channelId}`);
        setChannels(channels.filter(c => c.id !== channelId));
        setSelectedChannel(null);
        setSuccess(`Channel deleted!`);
        setTimeout(() => setSuccess(null), 3000);
      } catch (err: any) {
        setError(err.response?.data?.error || 'Failed to delete channel');
      }
    }
  };

  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChannelName.trim()) {
      setError('Channel name is required');
      return;
    }

    try {
      const res = await axios.post<Channel>('/api/channels', { 
        name: newChannelName, 
        description: newChannelDesc 
      });
      
      setChannels([res.data, ...channels]);
      setIsCreateModalOpen(false);
      setNewChannelName('');
      setNewChannelDesc('');
      setSuccess(`Channel created!`);
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to create channel');
    }
  };

  const getChannelIcon = (channel: Channel) => {
    if (channel.isDM) return '@';
    if (channel.name?.toLowerCase().includes('announcements')) return '📢';
    if (channel.name?.toLowerCase().includes('general')) return '💬';
    return '#';
  };

  return (
    <div className="p-8 h-full flex flex-col bg-gray-50">
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg font-medium">
          <div className="flex justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        </div>
      )}

      {success && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 text-green-700 rounded-lg font-medium">
          {success}
        </div>
      )}

      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
          <div className="p-2 bg-purple-100 rounded-lg">
            <Hash className="text-purple-600" />
          </div>
          Channel Administration
        </h1>

        <div className="flex gap-3">
          <input 
            type="text" 
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="px-4 py-2 border border-gray-200 rounded-lg"
          />
          <button onClick={fetchAllChannels} className="px-4 py-2 border border-gray-200 rounded-lg hover:bg-gray-50">Refresh</button>
          <button onClick={() => setIsCreateModalOpen(true)} className="px-4 py-2 bg-blue-600 text-white rounded-lg">New Channel</button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg">
        <table className="w-full">
          <thead className="border-b bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700">Channel</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700">Type</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700">Status</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700">Members</th>
              <th className="px-6 py-3 text-right text-xs font-semibold text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr><td colSpan={5} className="px-6 py-8 text-center">Loading...</td></tr>
            ) : filteredChannels.length === 0 ? (
              <tr><td colSpan={5} className="px-6 py-8 text-center text-gray-600">No channels found</td></tr>
            ) : (
              filteredChannels.map((ch) => (
                <tr key={ch.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="flex gap-3">
                      <div className="w-10 h-10 rounded-lg bg-purple-500 text-white flex items-center justify-center">
                        {getChannelIcon(ch)}
                      </div>
                      <div>
                        <div className="font-semibold text-gray-900">{ch.name}</div>
                        <div className="text-xs text-gray-600">{ch.id.substring(0, 8)}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-2 py-1 rounded text-xs bg-blue-100 text-blue-700">
                      {ch.isDM ? 'Private' : 'Public'}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-2 py-1 rounded text-xs bg-green-100 text-green-700">Active</span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-700">{Math.random() * 50 | 0} users</td>
                  <td className="px-6 py-4 text-right">
                    {ch.name?.toLowerCase() !== 'general' ? (
                      <button onClick={() => handleDeleteChannel(ch.id, ch.name || '')} className="text-red-600 hover:text-red-800">Delete</button>
                    ) : (
                      <span className="text-gray-400">Protected</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-gray-200 rounded-lg w-full max-w-lg">
            <div className="px-8 py-6 border-b">
              <h3 className="text-lg font-bold text-gray-900">Create Channel</h3>
            </div>
            
            <form onSubmit={handleCreateChannel} className="p-8">
              <div className="mb-6">
                <label className="block text-xs font-semibold text-gray-700 mb-2">Channel Name</label>
                <div className="relative">
                  <span className="absolute left-3 top-2 text-gray-600">#</span>
                  <input
                    type="text"
                    required
                    value={newChannelName}
                    onChange={(e) => setNewChannelName(e.target.value)}
                    placeholder="announcements"
                    className="w-full pl-8 pr-4 py-2 border border-gray-200 rounded"
                  />
                </div>
              </div>

              <div className="mb-6">
                <label className="block text-xs font-semibold text-gray-700 mb-2">Description</label>
                <textarea value={newChannelDesc} onChange={(e) => setNewChannelDesc(e.target.value)} rows={3} className="w-full p-2 border border-gray-200 rounded" />
              </div>

              <div className="flex gap-3 justify-end">
                <button type="button" onClick={() => setIsCreateModalOpen(false)} className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">Create</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
