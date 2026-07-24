import axios from 'axios';
import {
  Ban,
  Download,
  KeyRound,
  Mail,
  MoreVertical,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UserCog,
  User as UserIcon,
  UserMinus,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../hooks/useSocket';

type UserRole = 'USER' | 'ADMIN';
type UserAccountStatus = 'ACTIVE' | 'SUSPENDED' | 'BANNED';

interface AdminUser {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  status: UserAccountStatus;
  createdAt: string;
}

interface PresenceUser {
  id: string;
  username: string;
  status: string;
  emoji: string;
}

const STATUS_BADGE_STYLES: Record<UserAccountStatus, string> = {
  ACTIVE: 'bg-green-100 border-green-200 text-green-700',
  SUSPENDED: 'bg-yellow-100 border-yellow-200 text-yellow-700',
  BANNED: 'bg-red-100 border-red-200 text-red-700',
};

export const UserManagement = () => {
  const { token, user: currentUser } = useAuth();
  const socket = useSocket(token);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [onlineUsers, setOnlineUsers] = useState<Map<string, PresenceUser>>(new Map());
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);

  const fetchUsers = async () => {
    try {
      const res = await axios.get<{ users: AdminUser[] }>('/api/admin/stats');
      setUsers(res.data.users);
    } catch (err) {
      console.error('Failed to fetch users', err);
      setError('Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  // Close whichever row's action dropdown is open on any click outside it.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Same presence-delta pattern used elsewhere: one full snapshot via
  // presence:init, then single-user deltas via user:online/user:offline.
  useEffect(() => {
    if (!socket) return;

    const applyDelta = (map: Map<string, PresenceUser>) => setOnlineUsers(new Map(map));

    const handlePresenceInit = (data: { users: PresenceUser[] }) => {
      setOnlineUsers(new Map(data.users.map(u => [u.id, u])));
    };
    const handleUserOnline = (delta: PresenceUser) => {
      setOnlineUsers(prev => {
        const next = new Map(prev);
        next.set(delta.id, delta);
        return next;
      });
    };
    const handleUserOffline = ({ id }: { id: string }) => {
      setOnlineUsers(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    };

    socket.on('presence:init', handlePresenceInit);
    socket.on('user:online', handleUserOnline);
    socket.on('user:offline', handleUserOffline);

    return () => {
      socket.off('presence:init', handlePresenceInit);
      socket.off('user:online', handleUserOnline);
      socket.off('user:offline', handleUserOffline);
    };
  }, [socket]);

  const filteredUsers = users.filter(user =>
    user.username?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    user.email?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const flash = (setter: (v: string | null) => void, text: string) => {
    setter(text);
    setTimeout(() => setter(null), 3000);
  };

  const runAction = async (userId: string, action: () => Promise<unknown>, successMsg: string) => {
    setBusyId(userId);
    setOpenMenuId(null);
    try {
      await action();
      await fetchUsers();
      flash(setSuccess, successMsg);
    } catch (err: any) {
      flash(setError, err.response?.data?.error || 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleRole = (u: AdminUser) => {
    const nextRole = u.role === 'ADMIN' ? 'member' : 'admin';
    runAction(u.id, () => axios.patch(`/api/admin/users/${u.id}/role`), `${u.username} is now a ${nextRole}`);
  };

  const handleSetStatus = (u: AdminUser, status: UserAccountStatus) => {
    runAction(
      u.id,
      () => axios.patch(`/api/admin/users/${u.id}/status`, { status }),
      `${u.username} is now ${status.toLowerCase()}`
    );
  };

  const handleForceReset = (u: AdminUser) => {
    runAction(u.id, () => axios.post(`/api/admin/users/${u.id}/force-reset`), `Password reset email sent to ${u.username}`);
  };

  const handleDeleteUser = (u: AdminUser) => {
    if (!confirm(`Permanently delete "${u.username}" and all their data? This cannot be undone.`)) return;
    runAction(u.id, () => axios.delete(`/api/admin/users/${u.id}`), `${u.username} deleted`);
  };

  const handleExportCsv = async () => {
    try {
      const res = await axios.get('/api/admin/export/users', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'users.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export users', err);
      flash(setError, 'Failed to export users');
    }
  };

  const getStatusDisplay = (userId: string) => {
    const presence = onlineUsers.get(userId);
    if (!presence) return { statusText: 'Offline', statusColor: 'bg-gray-100 border-gray-200 text-gray-700', emoji: '⚫' };
    if (presence.status === 'away') return { statusText: 'Away', statusColor: 'bg-yellow-100 border-yellow-200 text-yellow-700', emoji: '🟡' };
    if (presence.status === 'in_meeting') return { statusText: 'In Meeting', statusColor: 'bg-red-100 border-red-200 text-red-700', emoji: '🔴' };
    return { statusText: 'Active', statusColor: 'bg-green-100 border-green-200 text-green-700', emoji: '🟢' };
  };

  return (
    <div className="p-8 h-full flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-500 bg-gray-50">

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

      {/* Header & Search */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight flex items-center gap-3">
            <div className="p-2 bg-violet-100 rounded-lg">
              <UserCog className="text-violet-600" size={28} />
            </div>
            User Access Control
          </h1>
          <p className="text-gray-600 font-medium text-sm mt-2">Manage {users.length} workspace members</p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative group">
            <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-violet-600 transition-colors" size={18} />
            <input
              type="text"
              placeholder="Search by name or email..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full md:w-72 bg-white border border-gray-200 text-gray-900 placeholder:text-gray-400 text-sm rounded-lg pl-10 pr-4 py-3 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100 transition-all shadow-sm"
            />
          </div>
          <button
            onClick={handleExportCsv}
            className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-200 rounded-lg text-sm font-bold text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm shrink-0"
          >
            <Download size={16} />
            Export CSV
          </button>
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
                <th className="px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">Presence</th>
                <th className="px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">Account Status</th>
                <th className="px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-2 h-2 bg-violet-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-2 h-2 bg-violet-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-2 h-2 bg-violet-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      <span className="text-gray-600 font-medium text-sm ml-2">Scanning Database...</span>
                    </div>
                  </td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-gray-600 font-medium text-sm uppercase tracking-wider">
                    No Users Found
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => {
                  const { statusText, statusColor, emoji } = getStatusDisplay(u.id);
                  const isSelf = u.id === currentUser?.id;
                  const isMenuOpen = openMenuId === u.id;

                  return (
                    <tr key={u.id} className="hover:bg-violet-50/40 transition-colors group">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 border border-violet-300 flex items-center justify-center text-white font-bold uppercase shrink-0 shadow-sm">
                            {u.username?.[0] || <UserIcon size={18} />}
                          </div>
                          <div>
                            <div className="text-sm font-semibold text-gray-900">{u.username} {isSelf && <span className="text-violet-500 font-medium">(You)</span>}</div>
                            <div className="text-xs font-mono text-gray-400">ID: {u.id.substring(0, 8)}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2 text-sm text-gray-700 font-medium">
                          <Mail size={14} className="text-gray-400" />
                          {u.email}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {u.role === 'ADMIN' ? (
                          <span className="px-3 py-1 rounded-md bg-purple-100 border border-purple-200 text-purple-700 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 w-fit">
                            <ShieldCheck size={11} /> Admin
                          </span>
                        ) : (
                          <span className="px-3 py-1 rounded-md bg-gray-100 border border-gray-200 text-gray-700 text-[10px] font-bold uppercase tracking-wider w-fit">Member</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-3 py-1 rounded-md border text-[10px] font-bold uppercase tracking-wider flex items-center gap-2 w-fit ${statusColor}`}>
                          <span>{emoji}</span>
                          {statusText}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-3 py-1 rounded-md border text-[10px] font-bold uppercase tracking-wider w-fit inline-block ${STATUS_BADGE_STYLES[u.status]}`}>
                          {u.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        {isSelf ? (
                          <span className="text-xs text-gray-300 font-bold uppercase tracking-wider">—</span>
                        ) : (
                          <div className="relative inline-block text-left" ref={isMenuOpen ? menuContainerRef : undefined}>
                            <button
                              onClick={() => setOpenMenuId(isMenuOpen ? null : u.id)}
                              disabled={busyId === u.id}
                              className="p-2.5 text-gray-500 hover:text-violet-600 hover:bg-violet-50 rounded-lg transition-all disabled:opacity-50"
                            >
                              <MoreVertical size={16} />
                            </button>

                            {isMenuOpen && (
                              <div className="absolute right-0 mt-1 w-56 bg-white border border-gray-200 rounded-xl shadow-xl z-20 overflow-hidden py-1.5 animate-in fade-in zoom-in-95 duration-150">
                                <button
                                  onClick={() => handleToggleRole(u)}
                                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-violet-50 hover:text-violet-700 transition-colors"
                                >
                                  <ShieldCheck size={15} />
                                  {u.role === 'ADMIN' ? 'Demote to Member' : 'Promote to Admin'}
                                </button>

                                {u.status === 'ACTIVE' ? (
                                  <>
                                    <button
                                      onClick={() => handleSetStatus(u, 'SUSPENDED')}
                                      className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-amber-700 hover:bg-amber-50 transition-colors"
                                    >
                                      <UserMinus size={15} />
                                      Suspend User
                                    </button>
                                    <button
                                      onClick={() => handleSetStatus(u, 'BANNED')}
                                      className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors"
                                    >
                                      <Ban size={15} />
                                      Ban User
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    onClick={() => handleSetStatus(u, 'ACTIVE')}
                                    className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-green-700 hover:bg-green-50 transition-colors"
                                  >
                                    <RotateCcw size={15} />
                                    Reactivate User
                                  </button>
                                )}

                                <button
                                  onClick={() => handleForceReset(u)}
                                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-violet-50 hover:text-violet-700 transition-colors"
                                >
                                  <KeyRound size={15} />
                                  Force Password Reset
                                </button>

                                <div className="my-1.5 border-t border-gray-100" />

                                <button
                                  onClick={() => handleDeleteUser(u)}
                                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors"
                                >
                                  <Trash2 size={15} />
                                  Delete User
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 text-xs font-medium text-gray-700 uppercase tracking-wider flex justify-between items-center">
          <div>
            <span className="text-violet-600 font-bold">●</span> Total: {filteredUsers.length} | Showing {filteredUsers.length} of {users.length}
          </div>
          <span className="text-gray-600">Encrypted Connection Active</span>
        </div>
      </div>

    </div>
  );
};
