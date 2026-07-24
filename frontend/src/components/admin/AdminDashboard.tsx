import axios from 'axios';
import { Hash, MessageSquare, Radio, Server, Users, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../hooks/useSocket';

interface AnalyticsResponse {
  totalUsers: number;
  totalChannels: number;
  totalMessages: number;
  messagesPerDay: { date: string; count: number }[];
  topChannels: { id: string; name: string; messageCount: number }[];
}

interface OnlineUser {
  id: string;
  username: string;
  status: string;
  emoji: string;
}

export const AdminDashboard = () => {
  const { token } = useAuth();
  const socket = useSocket(token);
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [liveOnlineCount, setLiveOnlineCount] = useState(0);

  useEffect(() => {
    const fetchAnalytics = async () => {
      try {
        const res = await axios.get<AnalyticsResponse>('/api/admin/analytics');
        setAnalytics(res.data);
      } catch (err) {
        console.error('Failed to fetch analytics', err);
      } finally {
        setLoading(false);
      }
    };

    fetchAnalytics();
    const interval = setInterval(fetchAnalytics, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  // presence:init seeds the initial count (a full snapshot, sent once right
  // after connecting); admin:stats:onlineCount then keeps it current with
  // single-integer deltas emitted only when the count actually changes.
  useEffect(() => {
    if (!socket) return;

    const handlePresenceInit = (data: { users: OnlineUser[] }) => {
      setOnlineUsers(data.users);
      setLiveOnlineCount(data.users.length);
    };

    const handleUserOnline = (delta: OnlineUser) => {
      setOnlineUsers(prev => {
        const index = prev.findIndex(u => u.id === delta.id);
        return index === -1 ? [...prev, delta] : prev.map(u => (u.id === delta.id ? delta : u));
      });
    };

    const handleUserOffline = ({ id }: { id: string }) => {
      setOnlineUsers(prev => prev.filter(u => u.id !== id));
    };

    const handleOnlineCount = (count: number) => setLiveOnlineCount(count);

    socket.on('presence:init', handlePresenceInit);
    socket.on('user:online', handleUserOnline);
    socket.on('user:offline', handleUserOffline);
    socket.on('admin:stats:onlineCount', handleOnlineCount);

    return () => {
      socket.off('presence:init', handlePresenceInit);
      socket.off('user:online', handleUserOnline);
      socket.off('user:offline', handleUserOffline);
      socket.off('admin:stats:onlineCount', handleOnlineCount);
    };
  }, [socket]);

  const statConfigs = [
    { label: 'Total Users', value: analytics?.totalUsers ?? 0, icon: Users },
    { label: 'Total Channels', value: analytics?.totalChannels ?? 0, icon: Hash },
    { label: 'Total Messages', value: analytics?.totalMessages ?? 0, icon: MessageSquare },
    { label: 'Live Online', value: liveOnlineCount, icon: Radio, live: true },
  ];

  return (
    <div className="p-8 font-sans animate-in fade-in slide-in-from-bottom-4 duration-500 bg-gray-50 min-h-screen">

      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold text-gray-900 tracking-tight flex items-center gap-3">
            <div className="p-2 bg-violet-100 rounded-lg">
              <Server className="text-violet-600" size={28} />
            </div>
            System Overview
          </h1>
          <p className="text-gray-600 font-medium text-sm mt-2">Real-time Workspace Metrics & Analytics</p>
        </div>
        <div className="flex items-center gap-2 px-4 py-3 bg-white border border-green-200 rounded-lg shadow-sm hover:shadow-md transition-shadow">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-sm font-semibold text-green-700">All Systems Operational</span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-10">
        {statConfigs.map((stat, index) => (
          <div
            key={index}
            className="bg-white border border-gray-100 p-6 rounded-2xl shadow-sm hover:shadow-md transition-all duration-300"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="p-3 rounded-xl bg-violet-50">
                <stat.icon size={24} className="text-violet-600" />
              </div>
              {stat.live && (
                <span className="flex items-center gap-1.5 text-[10px] font-black text-green-600 uppercase tracking-widest">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  Live
                </span>
              )}
            </div>

            <div>
              <h3 className="text-3xl font-bold text-gray-900 tracking-tight mb-1">
                {loading ? <span className="text-gray-300">--</span> : stat.value}
              </h3>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{stat.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Analytics & Online Users Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Activity Chart */}
        <div className="lg:col-span-2 bg-white border border-gray-100 rounded-2xl p-6 shadow-sm hover:shadow-md transition-shadow">
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide mb-1">Message Activity</h3>
          <p className="text-xs text-gray-400 font-medium mb-6">Messages sent per day — last 7 days</p>

          {loading ? (
            <div className="h-72 flex items-center justify-center text-gray-300 text-sm font-medium">Loading chart...</div>
          ) : (
            <ResponsiveContainer width="100%" height={288}>
              <AreaChart data={analytics?.messagesPerDay ?? []} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorViolet" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f0f5" />
                <XAxis dataKey="date" tick={{ fontSize: 12, fill: '#9ca3af', fontWeight: 600 }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#9ca3af', fontWeight: 600 }} axisLine={false} tickLine={false} width={32} />
                <Tooltip
                  contentStyle={{ borderRadius: 12, border: '1px solid #ede9fe', boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}
                  labelStyle={{ fontWeight: 700, color: '#111827' }}
                />
                <Area type="monotone" dataKey="count" stroke="#7c3aed" strokeWidth={2.5} fill="url(#colorViolet)" name="Messages" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Online Users - Real-time Status */}
        <div className="bg-white border border-gray-100 rounded-2xl p-6 flex flex-col shadow-sm hover:shadow-md transition-shadow">
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide mb-4 border-b border-gray-100 pb-4 flex items-center gap-2">
            <Zap size={16} className="text-violet-600" /> Online Users ({onlineUsers.length})
          </h3>
          <div className="flex-1 flex flex-col gap-2 overflow-y-auto max-h-60">
            {onlineUsers.length === 0 ? (
              <div className="text-gray-400 text-center py-8 text-sm">
                <div className="opacity-50 mb-2 text-2xl">👥</div>
                <p className="font-medium">No users online</p>
              </div>
            ) : (
              onlineUsers.map((user) => (
                <div
                  key={user.id}
                  className="p-3 rounded-xl bg-gray-50 hover:bg-violet-50 transition-colors border border-gray-100 group"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="text-lg">{user.emoji}</span>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-gray-900 truncate">{user.username}</p>
                        <p className="text-[10px] text-gray-400 capitalize">{user.status}</p>
                      </div>
                    </div>
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0 ml-2" />
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="text-[10px] text-gray-400 pt-3 border-t border-gray-100 mt-2 uppercase tracking-widest font-medium">
            Real-time updates active
          </div>
        </div>

      </div>

    </div>
  );
};
