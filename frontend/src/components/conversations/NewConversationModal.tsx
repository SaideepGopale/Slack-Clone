import axios from 'axios';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Channel, WorkspaceMember } from '../../types';
import { MemberPicker } from '../people/MemberPicker';
import { Modal } from '../ui/Modal';

export const MAX_GROUP_SIZE = 9;

interface NewConversationModalProps {
  workspaceId: string;
  currentUserId: string;
  onClose: () => void;
  // One person selected → 1:1 DM.
  onStartDM: (userId: string) => Promise<void> | void;
  // Two or more → group DM (already created on the server).
  onGroupCreated: (conversation: Channel) => void;
}

/** Start a 1:1 DM (one person) or a group conversation (2-8 others). */
export const NewConversationModal = ({ workspaceId, currentUserId, onClose, onStartDM, onGroupCreated }: NewConversationModalProps) => {
  const [selected, setSelected] = useState<WorkspaceMember[]>([]);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isGroup = selected.length >= 2;

  const submit = async () => {
    if (selected.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      if (!isGroup) {
        await onStartDM(selected[0].id);
      } else {
        const res = await axios.post<Channel>(`/api/workspaces/${workspaceId}/group-dms`, {
          userIds: selected.map((m) => m.id),
          name: name.trim() || undefined,
        });
        onGroupCreated(res.data);
      }
      onClose();
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(message ?? 'Could not start the conversation.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="New message"
      subtitle={`Choose one person for a direct message, or up to ${MAX_GROUP_SIZE - 1} for a group.`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={selected.length === 0 || submitting}
            className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {submitting && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {isGroup ? 'Start group conversation' : 'Start conversation'}
          </button>
        </>
      }
    >
      <MemberPicker
        workspaceId={workspaceId}
        selected={selected}
        onChange={setSelected}
        excludeIds={[currentUserId]}
        max={MAX_GROUP_SIZE - 1}
      />
      {isGroup && (
        <label className="block mt-4">
          <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Conversation name (optional)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder="e.g. Launch crew"
            className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100"
          />
        </label>
      )}
      {error && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
};
