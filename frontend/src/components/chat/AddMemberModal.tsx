import axios from 'axios';
import { Check, Loader2, Search, UserPlus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';

interface AddableUser {
  id: string;
  username: string;
  email: string;
}

interface AddMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  channelId: string;
  channelName: string;
}

export const AddMemberModal = ({ isOpen, onClose, channelId, channelName }: AddMemberModalProps) => {
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<AddableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen) return;

    setLoading(true);
    setSearch('');
    setAddedIds(new Set());
    axios.get<AddableUser[]>(`/api/channels/${channelId}/addable-members`)
      .then(res => setUsers(res.data))
      .catch(err => {
        console.error('Failed to fetch addable members', err);
        toast.error('Failed to load workspace members.');
      })
      .finally(() => setLoading(false));
  }, [isOpen, channelId]);

  if (!isOpen) return null;

  const handleAdd = async (user: AddableUser) => {
    setAddingId(user.id);
    try {
      await axios.post(`/api/channels/${channelId}/members`, { userId: user.id });
      setAddedIds(prev => new Set(prev).add(user.id));
      toast.success(`${user.username} added to #${channelName}`);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to add member.');
    } finally {
      setAddingId(null);
    }
  };

  const filteredUsers = users.filter(u =>
    u.username.toLowerCase().includes(search.toLowerCase()) ||
    u.email?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[80vh]">
        <div className="p-8 pb-5 shrink-0">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-violet-50 rounded-xl flex items-center justify-center text-violet-600 shrink-0 border border-violet-100">
              <UserPlus size={22} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-xl font-black text-gray-900 tracking-tight">Add people</h3>
              <p className="text-xs text-gray-400 font-bold uppercase tracking-widest leading-none mt-1 truncate">to #{channelName}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors shrink-0"
            >
              <X size={18} />
            </button>
          </div>

          <div className="relative">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              autoFocus
              type="text"
              placeholder="Search by name or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-white border border-gray-200 rounded-xl pl-10 pr-4 py-3 text-sm font-medium text-gray-900 outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 transition-all"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="animate-spin text-violet-500" size={24} />
            </div>
          ) : filteredUsers.length === 0 ? (
            <div className="py-12 text-center text-gray-400 font-medium text-sm">
              {users.length === 0 ? 'Everyone in this workspace is already in this channel.' : `No matches for "${search}"`}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {filteredUsers.map((u) => {
                const isAdded = addedIds.has(u.id);
                const isAdding = addingId === u.id;
                return (
                  <div key={u.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 transition-colors">
                    <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-white font-bold uppercase shrink-0 text-sm">
                      {u.username[0] || '?'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-gray-900 truncate">{u.username}</div>
                      <div className="text-xs text-gray-400 truncate">{u.email}</div>
                    </div>
                    <button
                      onClick={() => handleAdd(u)}
                      disabled={isAdding || isAdded}
                      className={`shrink-0 px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center gap-1.5 ${
                        isAdded
                          ? 'bg-green-50 text-green-600 cursor-default'
                          : 'bg-violet-50 text-violet-700 hover:bg-violet-100 active:scale-95 disabled:opacity-50'
                      }`}
                    >
                      {isAdding ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : isAdded ? (
                        <>
                          <Check size={13} /> Added
                        </>
                      ) : (
                        'Add'
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
