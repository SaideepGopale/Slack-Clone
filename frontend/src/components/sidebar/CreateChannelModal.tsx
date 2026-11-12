import axios from 'axios';
import { EmojiPicker } from '../ui/EmojiPicker';
import { Hash, Lock, Megaphone } from 'lucide-react';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { useWorkspace } from '../../pages/workspace/WorkspaceContext';
import { Channel, ChannelVisibility } from '../../types';

interface CreateChannelModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CreateChannelModal = ({ isOpen, onClose }: CreateChannelModalProps) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [creating, setCreating] = useState(false);
  const [visibility, setVisibility] = useState<ChannelVisibility>('PUBLIC');
  const [isAnnouncement, setIsAnnouncement] = useState(false);
  const { workspaceId, addChannel } = useWorkspace();
  const navigate = useNavigate();

  if (!isOpen) return null;

  const resetAndClose = () => {
    setName('');
    setDescription('');
    setIcon(null);
    setShowEmojiPicker(false);
    setVisibility('PUBLIC');
    setIsAnnouncement(false);
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('Channel name is required.');
      return;
    }

    setCreating(true);
    try {
      const res = await axios.post<Channel>('/api/channels', {
        workspaceId,
        name: trimmedName,
        description: description.trim() || undefined,
        icon: icon || undefined,
        visibility,
        isAnnouncement,
      });

      addChannel(res.data);
      resetAndClose();
      navigate(`/${workspaceId}/c/${res.data.id}`);
      toast.success(`#${res.data.name} created!`);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to create channel.');
    } finally {
      setCreating(false);
    }
  };

  const fieldClass = 'w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg outline-none transition-colors placeholder:text-fg-subtle focus:border-brand';

  // T.32 (audit FE-9): built on the shared accessible Modal (dialog role,
  // focus trap, Escape, focus restore) instead of a hand-rolled overlay.
  return (
    <Modal
      title="Create a channel"
      subtitle="Channels are where your team talks about a topic or project."
      onClose={resetAndClose}
      footer={
        <>
          <Button variant="secondary" onClick={resetAndClose}>Cancel</Button>
          <Button type="submit" form="create-channel-form" disabled={creating || !name.trim()} loading={creating}>
            Create Channel
          </Button>
        </>
      }
    >
      <form id="create-channel-form" onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="create-channel-name" className="mb-1.5 block text-xs font-medium text-fg-muted">Name</label>
          <div className="flex items-center gap-2">
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setShowEmojiPicker((v) => !v)}
                title="Choose an icon"
                aria-label={icon ? `Channel icon ${icon} — change` : 'Choose an icon'}
                aria-expanded={showEmojiPicker}
                className={`flex h-10 w-10 items-center justify-center rounded-lg border transition-colors ${showEmojiPicker ? 'border-brand bg-brand-soft' : 'border-line bg-surface-secondary hover:bg-surface-tertiary'}`}
              >
                {icon ? <span className="text-lg leading-none">{icon}</span> : <Hash size={17} className="text-fg-subtle" aria-hidden="true" />}
              </button>
              {showEmojiPicker && (
                <div className="absolute left-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-line bg-surface shadow-xl animate-pop-in">
                  <EmojiPicker
                    onPick={(emoji) => {
                      setIcon(emoji);
                      setShowEmojiPicker(false);
                    }}
                  />
                </div>
              )}
            </div>
            <input
              id="create-channel-name"
              autoFocus
              type="text"
              maxLength={80}
              placeholder="product-launch"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`${fieldClass} h-10 min-w-0 flex-1`}
            />
          </div>
        </div>

        <div>
          <label htmlFor="create-channel-description" className="mb-1.5 block text-xs font-medium text-fg-muted">
            Description <span className="font-normal text-fg-subtle">(optional)</span>
          </label>
          <textarea
            id="create-channel-description"
            rows={3}
            maxLength={250}
            placeholder="What's this channel about?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={`${fieldClass} resize-none py-2`}
          />
        </div>

        <fieldset>
          <legend className="mb-1.5 block text-xs font-medium text-fg-muted">Channel type</legend>
          <div className="grid grid-cols-2 gap-2">
            {([
              ['PUBLIC', Hash, 'Public', 'Anyone in the workspace can find and join'],
              ['PRIVATE', Lock, 'Private', 'Only invited people can see it'],
            ] as const).map(([value, Icon, label, hint]) => (
              <label
                key={value}
                className={`flex cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 transition-colors ${
                  visibility === value ? 'border-brand bg-brand-soft' : 'border-line hover:border-border-strong'
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-fg">
                  <input
                    type="radio"
                    name="channel-visibility"
                    value={value}
                    checked={visibility === value}
                    onChange={() => setVisibility(value)}
                    className="accent-[var(--color-brand)]"
                  />
                  <Icon size={14} aria-hidden="true" /> {label}
                </span>
                <span className="text-[11px] leading-snug text-fg-subtle">{hint}</span>
              </label>
            ))}
          </div>
          <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-lg border border-line px-3 py-2.5 hover:border-border-strong">
            <input
              type="checkbox"
              checked={isAnnouncement}
              onChange={(e) => setIsAnnouncement(e.target.checked)}
              className="mt-0.5 accent-[var(--color-brand)]"
            />
            <span>
              <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
                <Megaphone size={14} aria-hidden="true" /> Announcement channel
              </span>
              <span className="block text-[11px] leading-snug text-fg-subtle">
                Only owners, moderators and workspace admins post; everyone can reply in threads and react.
              </span>
            </span>
          </label>
        </fieldset>
      </form>
    </Modal>
  );
};
