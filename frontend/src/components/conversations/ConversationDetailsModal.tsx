import axios from 'axios';
import { Loader2, LogOut, UserMinus, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Channel, User, WorkspaceMember } from '../../types';
import { MemberPicker } from '../people/MemberPicker';
import { Modal } from '../ui/Modal';

interface Participant {
  id: string;
  username: string;
  joinedAt: string;
}

interface ParticipantsResponse {
  channelId: string;
  isGroupDM: boolean;
  createdBy: string;
  name: string | null;
  maxParticipants: number;
  participants: Participant[];
}

interface ConversationDetailsModalProps {
  conversation: Channel;
  workspaceId: string;
  currentUserId: string;
  onlineUsers: User[];
  onClose: () => void;
  // Called after the current user left the conversation.
  onLeft: () => void;
}

const errorText = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

/**
 * Participants of a DM / group DM. Group conversations additionally support
 * rename, adding people (optionally sharing earlier messages), removing
 * people (creator only, enforced server-side) and leaving.
 */
export const ConversationDetailsModal = ({ conversation, workspaceId, currentUserId, onlineUsers, onClose, onLeft }: ConversationDetailsModalProps) => {
  const [details, setDetails] = useState<ParticipantsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<WorkspaceMember[]>([]);
  const [shareHistory, setShareHistory] = useState(false);
  const [name, setName] = useState('');

  const load = useCallback(() => {
    axios
      .get<ParticipantsResponse>(`/api/channels/${conversation.id}/participants`)
      .then((res) => {
        setDetails(res.data);
        setName(res.data.name ?? '');
      })
      .catch((err) => setError(errorText(err, 'Could not load participants.')));
  }, [conversation.id]);

  useEffect(load, [load]);

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setError(errorText(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addPeople = async () => {
    const ok = await run(async () => {
      for (const person of adding) {
        await axios.post(`/api/channels/${conversation.id}/participants`, { userId: person.id, shareHistory });
      }
    }, 'Could not add people.');
    if (ok) {
      setAdding([]);
      load();
    }
  };

  const remove = async (userId: string) => {
    if (await run(() => axios.delete(`/api/channels/${conversation.id}/participants/${userId}`), 'Could not remove this person.')) load();
  };

  const leave = async () => {
    if (await run(() => axios.delete(`/api/channels/${conversation.id}/participants/${currentUserId}`), 'Could not leave the conversation.')) {
      onLeft();
    }
  };

  const rename = async () => {
    if (await run(() => axios.patch(`/api/channels/${conversation.id}/conversation`, { name }), 'Could not rename the conversation.')) load();
  };

  const isGroup = details?.isGroupDM ?? !!conversation.isGroupDM;
  const isCreator = details?.createdBy === currentUserId;
  const onlineIds = new Set(onlineUsers.map((u) => u.id));
  const roomLeft = details ? details.maxParticipants - details.participants.length : 0;

  return (
    <Modal title={conversation.name ?? 'Conversation'} subtitle={isGroup ? 'Group conversation' : 'Direct message'} onClose={onClose} size="lg">
      {!details && !error && (
        <p className="py-8 flex justify-center text-gray-400" role="status">
          <Loader2 className="animate-spin" size={20} aria-label="Loading participants" />
        </p>
      )}
      {error && (
        <p className="mb-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      {details && (
        <div className="space-y-6">
          {isGroup && (
            <section aria-label="Conversation name">
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider" htmlFor="conversation-name">
                Name
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id="conversation-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  placeholder="Add a name"
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100"
                />
                <button type="button" onClick={rename} disabled={busy} className="px-3 py-2 rounded-lg border border-gray-200 text-sm font-semibold hover:bg-gray-50 disabled:opacity-50">
                  Save
                </button>
              </div>
            </section>
          )}

          <section aria-label="Participants">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
              {details.participants.length} {details.participants.length === 1 ? 'person' : 'people'}
            </h3>
            <ul className="divide-y divide-gray-50">
              {details.participants.map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-2">
                  <span className="relative">
                    <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 text-white flex items-center justify-center text-xs font-bold uppercase">
                      {p.username[0]}
                    </span>
                    <span
                      role="img"
                      aria-label={onlineIds.has(p.id) ? 'Online' : 'Offline'}
                      className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${onlineIds.has(p.id) ? 'bg-emerald-500' : 'bg-gray-300'}`}
                    />
                  </span>
                  <span className="flex-1 text-sm font-semibold text-gray-900">
                    {p.username}
                    {p.id === currentUserId && <span className="text-gray-400 font-normal"> (you)</span>}
                    {p.id === details.createdBy && <span className="ml-2 text-[10px] uppercase tracking-wider text-violet-600">Creator</span>}
                  </span>
                  {isGroup && isCreator && p.id !== currentUserId && (
                    <button
                      type="button"
                      onClick={() => remove(p.id)}
                      disabled={busy}
                      aria-label={`Remove ${p.username}`}
                      className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      <UserMinus size={16} aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {isGroup && roomLeft > 0 && (
            <section aria-label="Add people">
              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Add people</h3>
              <MemberPicker
                workspaceId={workspaceId}
                selected={adding}
                onChange={setAdding}
                excludeIds={details.participants.map((p) => p.id)}
                max={roomLeft}
              />
              <label className="mt-3 flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={shareHistory} onChange={(e) => setShareHistory(e.target.checked)} />
                Share earlier messages with them
              </label>
              <button
                type="button"
                onClick={addPeople}
                disabled={adding.length === 0 || busy}
                className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 disabled:opacity-50"
              >
                <UserPlus size={16} aria-hidden="true" /> Add {adding.length || ''}
              </button>
            </section>
          )}

          {isGroup && (
            <button
              type="button"
              onClick={leave}
              disabled={busy}
              className="inline-flex items-center gap-2 text-sm font-semibold text-red-600 hover:text-red-700 disabled:opacity-50"
            >
              <LogOut size={16} aria-hidden="true" /> Leave conversation
            </button>
          )}
        </div>
      )}
    </Modal>
  );
};
