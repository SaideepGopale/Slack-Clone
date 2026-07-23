import axios from 'axios';
import { Hash, RefreshCw, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../hooks/useSocket';
import { Channel } from '../../types';

// Shape returned only by GET /api/channels/admin/all — the regular
// GET /api/channels (sidebar listing) doesn't include this.
interface AdminChannel extends Channel {
  _count: { members: number };
}

const SkeletonRow = () => (
  <tr className="animate-pulse">
    <td className="px-6 py-4">
      <div className="flex gap-3 items-center">
        <div className="w-10 h-10 rounded-lg bg-gray-200 shrink-0" />
        <div className="space-y-2">
          <div className="h-3.5 w-32 bg-gray-200 rounded" />
          <div className="h-2.5 w-20 bg-gray-100 rounded" />
        </div>
      </div>
    </td>
    <td className="px-6 py-4"><div className="h-5 w-14 bg-gray-100 rounded" /></td>
    <td className="px-6 py-4"><div className="h-5 w-14 bg-gray-100 rounded" /></td>
    <td className="px-6 py-4"><div className="h-3.5 w-16 bg-gray-100 rounded" /></td>
    <td className="px-6 py-4 text-right"><div className="h-3.5 w-12 bg-gray-100 rounded ml-auto" /></td>
  </tr>
);

export const ChannelManagement = () => {
  const { token } = useAuth();
  const socket = useSocket(token);
  const [channels, setChannels] = useState<AdminChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchAllChannels = useCallback(async () => {
    try {
      setLoading(true);
      const res = await axios.get<AdminChannel[]>('/api/channels/admin/all');
      setChannels(res.data);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch channels', err);
      setError('Failed to load channels');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAllChannels();
  }, [fetchAllChannels]);

  useEffect(() => {
    if (!socket) return;

    socket.on('admin:channel:list:updated', (data: any) => {
      if (data.action === 'deleted') {
        setChannels(prev => prev.filter(c => c.id !== data.channelId));
        setSuccess('Channel deleted!');
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
        setChannels(prev => prev.filter(c => c.id !== channelId));
        setSuccess('Channel deleted!');
        setTimeout(() => setSuccess(null), 3000);
      } catch (err: any) {
        setError(err.response?.data?.error || 'Failed to delete channel');
      }
    }
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
          <div className="p-2 bg-violet-100 rounded-lg">
            <Hash className="text-violet-600" />
          </div>
          Channel Administration
        </h1>

        <div className="flex gap-3">
          <input
            type="text"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="px-4 py-2 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 transition-all"
          />
          <button
            onClick={fetchAllChannels}
            disabled={loading}
            className="px-4 py-2 border border-gray-200 rounded-lg hover:bg-gray-50 flex items-center gap-2 disabled:opacity-60 transition-all"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
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
              Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
            ) : filteredChannels.length === 0 ? (
              <tr><td colSpan={5} className="px-6 py-8 text-center text-gray-600">No channels found</td></tr>
            ) : (
              filteredChannels.map((ch) => (
                <tr key={ch.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="flex gap-3">
                      <div className="w-10 h-10 rounded-lg bg-violet-500 text-white flex items-center justify-center text-lg shrink-0">
                        {ch.icon && ch.icon !== 'hash' ? ch.icon : <Hash size={18} />}
                      </div>
                      <div>
                        <div className="font-semibold text-gray-900">{ch.name}</div>
                        <div className="text-xs text-gray-400 font-mono">{ch.id.substring(0, 8)}</div>
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
                  <td className="px-6 py-4 text-sm text-gray-700">
                    <div className="flex items-center gap-1.5">
                      <Users size={14} className="text-gray-400" />
                      {ch._count.members} {ch._count.members === 1 ? 'user' : 'users'}
                    </div>
                  </td>
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
    </div>
  );
};
