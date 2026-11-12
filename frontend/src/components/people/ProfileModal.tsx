import axios from 'axios';
import { Clock, Hash, Loader2, MessageSquare, UserMinus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MemberProfile } from '../../types';
import { Modal } from '../ui/Modal';

interface ProfileModalProps {
  workspaceId: string;
  userId: string;
  currentUserId: string;
  // Viewer may remove people (workspace admin/owner, non-default workspace).
  canManage: boolean;
  viewerIsOwner: boolean;
  onClose: () => void;
  onMessage: (userId: string) => void;
  onRemoved: (userId: string) => void;
}

const localTime = (timezone: string | null) => {
  if (!timezone) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date());
  } catch {
    return null;
  }
};

const statusLabel = (status?: string) =>
  status === 'away' ? 'Away' : status === 'in_meeting' ? 'In a meeting' : 'Active';

export const ProfileModal = ({ workspaceId, userId, currentUserId, canManage, viewerIsOwner, onClose, onMessage, onRemoved }: ProfileModalProps) => {
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    axios
      .get<MemberProfile>(`/api/workspaces/${workspaceId}/members/${userId}`)
      .then((res) => !cancelled && setProfile(res.data))
      .catch((err) => !cancelled && setError(err.response?.data?.error ?? 'Could not load this profile.'));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, userId]);

  const isSelf = userId === currentUserId;
  const mayRemove =
    !!profile && canManage && !isSelf && !profile.isOwner && (profile.role !== 'ADMIN' || viewerIsOwner);

  const remove = async () => {
    setRemoving(true);
    setError(null);
    try {
      await axios.delete(`/api/workspaces/${workspaceId}/members/${userId}`);
      onRemoved(userId);
    } catch (err: unknown) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not remove this member.');
      setRemoving(false);
    }
  };

  const time = localTime(profile?.timezone ?? null);

  return (
    <Modal title={profile?.username ?? 'Profile'} subtitle={profile?.title ?? undefined} onClose={onClose}>
      {!profile && !error && (
        <p className="py-8 flex justify-center text-gray-400" role="status">
          <Loader2 className="animate-spin" size={20} aria-label="Loading profile" />
        </p>
      )}
      {error && (
        <p className="mb-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      {profile && (
        <div className="space-y-5">
          <div className="flex items-center gap-4">
            <span className="w-16 h-16 rounded-2xl bg-accent-600 text-white flex items-center justify-center text-2xl font-semibold uppercase">
              {profile.username[0]}
            </span>
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm">
                <span
                  role="img"
                  aria-label={profile.presence ? 'Online' : 'Offline'}
                  className={`w-2.5 h-2.5 rounded-full ${profile.presence ? 'bg-emerald-500' : 'bg-gray-300'}`}
                />
                <span className="text-gray-700">{profile.presence ? statusLabel(profile.presence.status) : 'Offline'}</span>
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {profile.isOwner ? 'Workspace owner' : profile.role === 'ADMIN' ? 'Workspace admin' : 'Member'} · joined{' '}
                {new Date(profile.joinedAt).toLocaleDateString()}
              </p>
              {profile.email && <p className="text-xs text-gray-500 truncate">{profile.email}</p>}
            </div>
          </div>

          {profile.bio && <p className="text-sm text-gray-700 whitespace-pre-line">{profile.bio}</p>}

          {time && (
            <p className="flex items-center gap-2 text-sm text-gray-600">
              <Clock size={14} aria-hidden="true" /> {time} local time ({profile.timezone})
            </p>
          )}

          {profile.sharedChannels.length > 0 && (
            <section aria-label="Channels in common">
              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Channels in common</h3>
              <ul className="flex flex-wrap gap-1.5">
                {profile.sharedChannels.map((c) => (
                  <li key={c.id} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-gray-100 text-xs text-gray-700">
                    <Hash size={12} aria-hidden="true" />
                    {c.name}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {!isSelf && (
              <button
                type="button"
                onClick={() => onMessage(userId)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700"
              >
                <MessageSquare size={16} aria-hidden="true" /> Message
              </button>
            )}
            {mayRemove &&
              (confirming ? (
                <span className="inline-flex items-center gap-2" role="group" aria-label="Confirm removal">
                  <span className="text-sm text-red-700">Remove {profile.username}?</span>
                  <button type="button" onClick={remove} disabled={removing} className="px-3 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
                    {removing ? 'Removing…' : 'Remove'}
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className="px-3 py-2 rounded-lg border border-gray-200 text-sm font-semibold">
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-red-200 text-red-600 text-sm font-semibold hover:bg-red-50"
                >
                  <UserMinus size={16} aria-hidden="true" /> Remove from workspace
                </button>
              ))}
          </div>
        </div>
      )}
    </Modal>
  );
};
