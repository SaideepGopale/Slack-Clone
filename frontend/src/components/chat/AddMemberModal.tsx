import axios from 'axios';
import { Check, Loader2, Search } from 'lucide-react';
import { Avatar } from '../ui/Avatar';
import { Modal } from '../ui/Modal';
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';

interface AddableUser {
  id: string;
  username: string;
  /** Only sent to workspace managers (FA-SEC-03). */
  email?: string;
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

  // T.32 (audit FE-9): the shared accessible Modal (dialog semantics, focus
  // trap, Escape, focus restore) instead of a hand-rolled overlay.
  return (
    <Modal title="Add people" subtitle={`to #${channelName}`} onClose={onClose}>
      <div className="relative mb-3">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
        <input
          autoFocus
          type="text"
          aria-label="Search people"
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-3 text-sm text-fg outline-none transition-colors placeholder:text-fg-subtle focus:border-brand"
        />
      </div>

      {loading ? (
        <div className="space-y-2 py-2" aria-label="Loading people">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-1.5">
              <div className="skeleton h-8 w-8 rounded-lg" />
              <div className="skeleton h-3 w-40 rounded" />
            </div>
          ))}
        </div>
      ) : filteredUsers.length === 0 ? (
        <p className="py-10 text-center text-sm text-fg-subtle">
          {users.length === 0 ? 'Everyone in this workspace is already in this channel.' : `No matches for "${search}"`}
        </p>
      ) : (
        <ul className="-mx-1 flex flex-col gap-0.5">
          {filteredUsers.map((u) => {
            const isAdded = addedIds.has(u.id);
            const isAdding = addingId === u.id;
            return (
              <li key={u.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-secondary">
                <Avatar name={u.username} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-fg">{u.username}</div>
                  {u.email && <div className="truncate text-xs text-fg-subtle">{u.email}</div>}
                </div>
                <button
                  type="button"
                  onClick={() => handleAdd(u)}
                  disabled={isAdding || isAdded}
                  aria-label={isAdded ? `${u.username} added` : `Add ${u.username}`}
                  className={`flex h-7 shrink-0 items-center gap-1 rounded-md px-3 text-xs font-semibold transition-colors ${
                    isAdded ? 'cursor-default bg-success-soft text-success' : 'bg-brand-soft text-brand hover:bg-brand-muted disabled:opacity-50'
                  }`}
                >
                  {isAdding ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : isAdded ? <><Check size={13} aria-hidden="true" /> Added</> : 'Add'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
};
