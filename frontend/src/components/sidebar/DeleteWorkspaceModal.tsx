import axios from 'axios';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';

interface DeleteWorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceId: string;
  workspaceName: string;
}

export const DeleteWorkspaceModal = ({ isOpen, onClose, workspaceId, workspaceName }: DeleteWorkspaceModalProps) => {
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();

  if (!isOpen) return null;

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await axios.delete(`/api/workspaces/${workspaceId}`);
      toast.success(`"${workspaceName}" deleted.`);
      // "/" resolves to whichever workspace the user should land in next
      // (see WorkspaceRedirect.tsx) — simpler and more universally correct
      // than /admin, since deleting a workspace only requires being its
      // owner/admin, not a system admin.
      navigate('/');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to delete workspace.');
      setDeleting(false);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        <div className="p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-red-50 rounded-xl flex items-center justify-center text-red-600 shrink-0 border border-red-100">
              <AlertTriangle size={22} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-xl font-black text-gray-900 tracking-tight truncate">Delete "{workspaceName}"?</h3>
              <p className="text-xs text-red-500 font-bold uppercase tracking-widest leading-none mt-1">This cannot be undone</p>
            </div>
          </div>

          <p className="text-sm text-gray-600 mb-8 leading-relaxed">
            Are you sure? This will delete all channels and messages, along with every membership and pending
            invitation for this workspace. Everyone in it will lose access immediately.
          </p>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={deleting}
              className="flex-1 px-6 py-3 border border-gray-200 text-gray-600 font-black rounded-xl hover:bg-gray-50 transition-all active:scale-95 text-sm disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="flex-1 px-6 py-3 bg-red-600 text-white font-black rounded-xl hover:bg-red-700 transition-all active:scale-95 text-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {deleting ? <Loader2 size={16} className="animate-spin" /> : 'Delete Workspace'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
