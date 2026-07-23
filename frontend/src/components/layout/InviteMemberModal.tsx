import axios from 'axios';
import { Loader2, Mail, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'react-toastify';

interface InviteMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceId: string;
}

export const InviteMemberModal = ({ isOpen, onClose, workspaceId }: InviteMemberModalProps) => {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);

  if (!isOpen) return null;

  const resetAndClose = () => {
    setEmail('');
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      toast.error('Email address is required.');
      return;
    }

    setSending(true);
    try {
      const res = await axios.post(`/api/workspaces/${workspaceId}/invites`, { email: trimmedEmail });
      if (res.data?.emailError) {
        toast.warn('Invite created, but the email failed to send — share the invite link with them instead.');
      } else {
        toast.success(`Invite sent to ${trimmedEmail}`);
      }
      resetAndClose();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to send invite.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        <form onSubmit={handleSubmit} className="p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-violet-50 rounded-xl flex items-center justify-center text-violet-600 shrink-0 border border-violet-100">
              <Mail size={22} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-xl font-black text-gray-900 tracking-tight">Invite people</h3>
              <p className="text-xs text-gray-400 font-bold uppercase tracking-widest leading-none mt-1">Grow your workspace</p>
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
            <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 block">Email Address</label>
            <input
              autoFocus
              type="email"
              placeholder="name@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm font-medium text-gray-900 outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 transition-all"
            />
            <p className="text-xs text-gray-400 mt-2">
              We'll email them a link to join this workspace.
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
              disabled={sending || !email.trim()}
              className="flex-1 px-6 py-3 bg-violet-600 text-white font-black rounded-xl hover:bg-violet-700 transition-all active:scale-95 text-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {sending ? <Loader2 size={16} className="animate-spin" /> : 'Send Invite'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
