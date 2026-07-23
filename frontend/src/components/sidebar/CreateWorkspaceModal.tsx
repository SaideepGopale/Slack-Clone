import axios from 'axios';
import { Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { Workspace } from '../../types';

interface CreateWorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (workspace: Workspace) => void;
}

export const CreateWorkspaceModal = ({ isOpen, onClose, onCreated }: CreateWorkspaceModalProps) => {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  if (!isOpen) return null;

  const resetAndClose = () => {
    setName('');
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('Workspace name is required.');
      return;
    }

    setCreating(true);
    try {
      const res = await axios.post<{ workspace: Workspace; generalChannel: unknown }>('/api/workspaces', {
        name: trimmedName,
      });

      onCreated?.(res.data.workspace);
      resetAndClose();
      // The workspace's own index route resolves straight into its General
      // channel (see WorkspaceIndex.tsx) — no need to know the channel id here.
      navigate(`/${res.data.workspace.id}`);
      toast.success(`"${res.data.workspace.name}" created!`);
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to create workspace.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        <form onSubmit={handleSubmit} className="p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-violet-50 rounded-xl flex items-center justify-center text-violet-600 shrink-0 border border-violet-100 font-black text-xl">
              W
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-xl font-black text-gray-900 tracking-tight">Create a workspace</h3>
              <p className="text-xs text-gray-400 font-bold uppercase tracking-widest leading-none mt-1">A new home for your team</p>
            </div>
            <button
              type="button"
              onClick={resetAndClose}
              className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors shrink-0"
            >
              <X size={18} />
            </button>
          </div>

          <div>
            <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 block">Workspace Name</label>
            <input
              autoFocus
              type="text"
              maxLength={80}
              placeholder="Acme Corp"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm font-medium text-gray-900 outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 transition-all"
            />
            <p className="text-xs text-gray-400 mt-2">
              You'll be the admin, and we'll set up a "General" channel automatically.
            </p>
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
              {creating ? <Loader2 size={16} className="animate-spin" /> : 'Create Workspace'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
