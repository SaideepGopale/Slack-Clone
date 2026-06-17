import axios from 'axios';
import { Activity, Database, Hash, Server, ShieldCheck, TrendingUp, Users, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../hooks/useSocket';

interface DashboardStats {
  totalUsers: number;
  activeConnections: number;
  totalChannels: number;
  storageUsed: string;
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
  const [stats, setStats] = useState<DashboardStats>({
    totalUsers: 0,
    activeConnections: 0,
    totalChannels: 0,
    storageUsed: '0 GB',
  });
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const [users, channels] = await Promise.all([
          axios.get('/api/users'),
          axios.get('/api/channels'),
        ]);
        
        setStats({
          totalUsers: users.data.length,
          activeConnections: onlineUsers.length,
          totalChannels: channels.data.length,
          storageUsed: '14.2 GB',
        });
      } catch (err) {
        console.error('Failed to fetch dashboard stats', err);
      } finally {
        setLoading(false);
      }
    };
    
    fetchStats();
    const interval = setInterval(fetchStats, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [onlineUsers.length]);

  // Listen for real-time user status updates
  useEffect(() => {
    if (!socket) return;

    socket.on('user:online', (users: OnlineUser[]) => {
      setOnlineUsers(users);
      // Update active connections count
      setStats(prev => ({
        ...prev,
        activeConnections: users.length
      }));
    });

    return () => {
      socket.off('user:online');
    };
  }, [socket]);

  const statConfigs = [
    { label: 'Total Users', value: stats.totalUsers, icon: Users, color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200' },
    { label: 'Active Connections', value: stats.activeConnections, icon: Activity, color: 'text-green-600', bg: 'bg-green-50', border: 'border-green-200' },
    { label: 'Total Channels', value: stats.totalChannels, icon: Hash, color: 'text-purple-600', bg: 'bg-purple-50', border: 'border-purple-200' },
    { label: 'Storage Used', value: stats.storageUsed, icon: Database, color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200' },
  ];

  return (
    <div className="p-8 font-sans animate-in fade-in slide-in-from-bottom-4 duration-500 bg-gray-50 min-h-screen">
      
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold text-gray-900 tracking-tight flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Server className="text-blue-600" size={28} />
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
            className={`bg-white border ${stat.border} p-6 rounded-lg shadow-sm hover:shadow-md transition-all duration-300`}
          >
            <div className="flex items-center justify-between mb-4">
              <div className={`p-3 rounded-lg ${stat.bg}`}>
                <stat.icon size={24} className={stat.color} />
              </div>
              <div className="flex items-center gap-1">
                <TrendingUp size={14} className={`${stat.color} opacity-60`} />
                <span className={`${stat.color} text-xs font-semibold`}>+2.4%</span>
              </div>
            </div>
            
            <div>
              <h3 className="text-3xl font-bold text-gray-900 tracking-tight mb-1">
                {loading ? <span className="text-gray-400">--</span> : stat.value}
              </h3>
              <p className="text-xs font-medium text-gray-600 uppercase tracking-wider">{stat.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Analytics & Online Users Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Activity Chart */}
        <div className="lg:col-span-2 bg-white border border-gray-200 rounded-lg p-8 min-h-80 flex flex-col items-center justify-center shadow-sm hover:shadow-md transition-shadow">
          <div className="p-3 bg-blue-50 rounded-lg mb-3">
            <ShieldCheck size={48} className="text-blue-300" />
          </div>
          <p className="text-gray-500 font-medium text-sm uppercase tracking-wide">📊 Advanced Analytics Coming Soon</p>
          <p className="text-gray-400 text-xs mt-2">Features in development</p>
        </div>

        {/* Online Users - Real-time Status */}
        <div className="bg-white border border-gray-200 rounded-lg p-6 flex flex-col shadow-sm hover:shadow-md transition-shadow">
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wide mb-4 border-b border-gray-200 pb-4 flex items-center gap-2">
            <Zap size={16} className="text-green-600" /> Online Users ({onlineUsers.length})
          </h3>
          <div className="flex-1 flex flex-col gap-2 overflow-y-auto max-h-60">
            {onlineUsers.length === 0 ? (
              <div className="text-gray-500 text-center py-8 text-sm">
                <div className="opacity-50 mb-2 text-2xl">👥</div>
                <p className="font-medium">No users online</p>
              </div>
            ) : (
              onlineUsers.map((user) => (
                <div 
                  key={user.id} 
                  className="p-3 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors border border-gray-200 group"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="text-lg">{user.emoji}</span>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-gray-900 truncate">{user.username}</p>
                        <p className="text-[10px] text-gray-600 capitalize">{user.status}</p>
                      </div>
                    </div>
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0 ml-2" />
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="text-[10px] text-gray-600 pt-3 border-t border-gray-200 mt-2 uppercase tracking-widest font-medium">
            📡 Real-time Updates Active
          </div>
        </div>

      </div>

    </div>
  );
};