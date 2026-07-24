import axios from 'axios';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import { Hash, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { useWorkspace } from '../../pages/workspace/WorkspaceContext';
import { Channel } from '../../types';

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
  const { workspaceId, addChannel } = useWorkspace();
  const navigate = useNavigate();

  if (!isOpen) return null;

  const resetAndClose = () => {
    setName('');
    setDescription('');
    setIcon(null);
    setShowEmojiPicker(false);
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

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        <form onSubmit={handleSubmit} className="p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-violet-50 rounded-xl flex items-center justify-center text-violet-600 shrink-0 border border-violet-100">
              <Hash size={22} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-xl font-black text-gray-900 tracking-tight">Create a channel</h3>
              <p className="text-xs text-gray-400 font-bold uppercase tracking-widest leading-none mt-1">Give your team a new space</p>
            </div>
            <button
              type="button"
              onClick={resetAndClose}
              className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors shrink-0"
            >
              <X size={18} />
            </button>
          </div>

          <div className="space-y-4">
            <div>
              <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 block">Channel Name</label>
              <div className="flex items-center gap-3">
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setShowEmojiPicker((v) => !v)}
                    title="Choose an icon"
                    className={`w-[46px] h-[46px] rounded-xl border flex items-center justify-center transition-all active:scale-95 ${
                      showEmojiPicker
                        ? 'bg-violet-100 border-violet-300 ring-2 ring-violet-100'
                        : 'bg-violet-50 border-violet-100 hover:bg-violet-100 hover:border-violet-200'
                    }`}
                  >
                    {icon ? (
                      <span className="text-xl leading-none">{icon}</span>
                    ) : (
                      <Hash size={20} className="text-violet-400" />
                    )}
                  </button>

                  {showEmojiPicker && (
                    <div className="absolute top-full left-0 mt-2 z-50 shadow-2xl rounded-xl border border-gray-100 overflow-hidden bg-white animate-in fade-in zoom-in-95 duration-150">
                      <EmojiPicker
                        onEmojiClick={(emojiData) => {
                          setIcon(emojiData.emoji);
                          setShowEmojiPicker(false);
                        }}
                        theme={Theme.LIGHT}
                        lazyLoadEmojis
                      />
                    </div>
                  )}
                </div>

                <input
                  autoFocus
                  type="text"
                  maxLength={80}
                  placeholder="product-launch"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="flex-1 min-w-0 bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm font-medium text-gray-900 outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 transition-all"
                />
              </div>
            </div>

            <div>
              <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 block">
                Description <span className="text-gray-300 normal-case font-medium">(optional)</span>
              </label>
              <textarea
                rows={3}
                maxLength={250}
                placeholder="What's this channel about?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm font-medium text-gray-900 outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 transition-all resize-none"
              />
            </div>
          </div>

          <div className="flex gap-3 mt-8">
            <button
              type="button"
              onClick={resetAndClose}
              className="flex-1 px-6 py-3 border border-gray-200 text-gray-600 font-black rounded-xl hover:bg-gray-50 transition-all active:scale-95 text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating || !name.trim()}
              className="flex-1 px-6 py-3 bg-violet-600 text-white font-black rounded-xl hover:bg-violet-700 transition-all active:scale-95 text-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {creating ? <Loader2 size={16} className="animate-spin" /> : 'Create Channel'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
