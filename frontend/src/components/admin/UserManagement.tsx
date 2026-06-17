import axios from 'axios';
import { Ban, Mail, MoreVertical, Search, Trash2, UserCheck, User as UserIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../hooks/useSocket';
import { User } from '../../types';

interface UserWithStatus extends User {
  status?: string;
  emoji?: string;
}

export const UserManagement = () => {
  const { token } = useAuth();
  const socket = useSocket(token);
  const [users, setUsers] = useState<UserWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedUser, setSelectedUser] = useState<UserWithStatus | null>(null);
  const [onlineUsers, setOnlineUsers] = useState<Map<string, { id: string; username: string; status: string; emoji: string }>>(new Map());

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const res = await axios.get<User[]>('/api/users');
        setUsers(res.data);
      } catch (error) {
        console.error('Failed to fetch users', error);
      } finally {
        setLoading(false);
      }
    };
    fetchUsers();
  }, []);

  // Listen to real-time user online status updates
  useEffect(() => {
    if (!socket) return;

    socket.on('user:online', (onlineUsersList: Array<{ id: string; username: string; status: string; emoji: string }>) => {
      // Create a map for quick lookup
      const statusMap = new Map(onlineUsersList.map(u => [u.id, u]));
      setOnlineUsers(statusMap);

      // Update users with their online status
      setUsers(prevUsers => 
        prevUsers.map(user => ({
          ...user,
          status: statusMap.get(user.id)?.status || 'offline',
          emoji: statusMap.get(user.id)?.emoji || '🔴'
        }))
      );
    });

    return () => {
      socket.off('user:online');
    };
  }, [socket]);

  const filteredUsers = users.filter(user => 
    user.username?.toLowerCase().includes(searchTerm.toLowerCase()) || 
    user.email?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleDeleteUser = async (userId: string, username: string) => {
    if (confirm(`⚠️ Permanently delete user "${username}" and all their data?`)) {
      try {
        await axios.delete(`/api/admin/users/${userId}`);
        setUsers(users.filter(u => u.id !== userId));
        setSelectedUser(null);
      } catch (err) {
        console.error('Failed to delete user', err);
        alert('Failed to delete user');
      }
    }
  };

  const getStatusDisplay = (user: UserWithStatus) => {
    if (onlineUsers.has(user.id)) {
      const userStatus = onlineUsers.get(user.id);
      let statusText = 'Active';
      let statusColor = 'bg-green-100 border-green-200 text-green-700';
      let emoji = '🟢';

      if (userStatus?.status === 'away') {
        statusText = 'Away';
        statusColor = 'bg-yellow-100 border-yellow-200 text-yellow-700';
        emoji = '🟡';
      } else if (userStatus?.status === 'in_meeting') {
        statusText = 'In Meeting';
        statusColor = 'bg-red-100 border-red-200 text-red-700';
        emoji = '🔴';
      }

      return { statusText, statusColor, emoji };
    }

    return { 
      statusText: 'Inactive', 
      statusColor: 'bg-gray-100 border-gray-200 text-gray-700',
      emoji: '⚫'
    };
  };

  const handleBanUser = async (userId: string) => {
    try {
      await axios.post(`/api/admin/users/${userId}/ban`);
      alert('User banned successfully');
    } catch (err) {
      console.error('Failed to ban user', err);
    }
  };

  return (
    <div className="p-8 h-full flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-500 bg-gray-50">
      
      {/* Header & Search */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <UserCheck className="text-blue-600" size={28} />
            </div>
            User Access Control
          </h1>
          <p className="text-gray-600 font-medium text-sm mt-2">Manage {users.length} workspace members</p>
        </div>

        <div className="relative group">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-600 transition-colors" size={18} />
          <input 
            type="text" 
            placeholder="Search by name or email..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full md:w-80 bg-white border border-gray-200 text-gray-900 placeholder:text-gray-400 text-sm rounded-lg pl-10 pr-4 py-3 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition-all shadow-sm"
          />
        </div>
      </div>

      {/* Users Table */}
      <div className="flex-1 bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm flex flex-col">
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">User Profile</th>
                <th className="px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">Contact</th>
                <th className="px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">Role</th>
                <th className="px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">Status</th>
                <th className="px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      <span className="text-gray-600 font-medium text-sm ml-2">Scanning Database...</span>
                    </div>
                  </td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-gray-600 font-medium text-sm uppercase tracking-wider">
                    🔍 No Users Found
                  </td>
                </tr>
              ) : (
                filteredUsers.map((user) => (
                  <tr 
                    key={user.id} 
                    className="hover:bg-blue-50 transition-colors group cursor-pointer"
                    onClick={() => setSelectedUser(user)}
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 border border-blue-300 flex items-center justify-center text-white font-bold uppercase shrink-0 shadow-sm">
                          {user.username?.[0] || <UserIcon size={18} />}
                        </div>
                        <div>
                          <div className="text-sm font-semibold text-gray-900">{user.username}</div>
                          <div className="text-xs font-mono text-gray-600">ID: {user.id.substring(0, 8)}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2 text-sm text-gray-700 font-medium">
                        <Mail size={14} className="text-gray-400" />
                        {user.email}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {user.email === 'admin@slack.com' || user.email?.includes('admin') ? (
                        <span className="px-3 py-1 rounded-md bg-purple-100 border border-purple-200 text-purple-700 text-[10px] font-bold uppercase tracking-wider">👑 Admin</span>
                      ) : (
                        <span className="px-3 py-1 rounded-md bg-gray-100 border border-gray-200 text-gray-700 text-[10px] font-bold uppercase tracking-wider">👤 Member</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      {(() => {
                        const { statusText, statusColor, emoji } = getStatusDisplay(user);
                        return (
                          <span className={`px-3 py-1 rounded-md border text-[10px] font-bold uppercase tracking-wider flex items-center gap-2 w-fit ${statusColor}`}>
                            <span>{emoji}</span>
                            {statusText}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        {user.email !== 'admin@slack.com' && (
                          <>
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleBanUser(user.id); }}
                              title="Ban User"
                              className="p-2.5 bg-white border border-amber-200 hover:bg-amber-50 text-amber-600 hover:text-amber-700 rounded-lg transition-all hover:scale-110 active:scale-95 shadow-sm"
                            >
                              <Ban size={16} />
                            </button>
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleDeleteUser(user.id, user.username); }}
                              title="Delete User"
                              className="p-2.5 bg-white border border-red-200 hover:bg-red-50 text-red-600 hover:text-red-700 rounded-lg transition-all hover:scale-110 active:scale-95 shadow-sm"
                            >
                              <Trash2 size={16} />
                            </button>
                          </>
                        )}
                        <button className="p-2.5 text-gray-600 hover:text-blue-600 transition-all hover:scale-110 bg-gray-50 rounded-lg">
                          <MoreVertical size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        
        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 text-xs font-medium text-gray-700 uppercase tracking-wider flex justify-between items-center">
          <div>
            <span className="text-blue-600 font-bold">●</span> Total: {filteredUsers.length} | Showing {filteredUsers.length} of {users.length}
          </div>
          <span className="text-gray-600">🔒 Encrypted Connection Active</span>
        </div>
      </div>

      {/* User Detail Panel */}
      {selectedUser && (
        <div className="fixed bottom-0 right-0 w-80 bg-white border-l border-t border-gray-200 rounded-tl-lg p-6 shadow-lg animate-in slide-in-from-right-full duration-300 z-40">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wider">User Details</h3>
            <button onClick={() => setSelectedUser(null)} className="text-gray-600 hover:text-gray-900 text-xl">×</button>
          </div>
          
          <div className="space-y-3 text-sm">
            <div>
              <span className="text-gray-600 text-xs uppercase tracking-wider font-medium">Name</span>
              <p className="text-gray-900 font-semibold">{selectedUser.username}</p>
            </div>
            <div>
              <span className="text-gray-600 text-xs uppercase tracking-wider font-medium">Email</span>
              <p className="text-gray-900 font-mono">{selectedUser.email}</p>
            </div>
            <div>
              <span className="text-gray-600 text-xs uppercase tracking-wider font-medium">ID</span>
              <p className="text-gray-900 font-mono text-[10px]">{selectedUser.id}</p>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};