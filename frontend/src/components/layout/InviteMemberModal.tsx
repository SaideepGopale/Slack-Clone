import axios from 'axios';
import { Check, Copy, Link2, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';

interface InviteMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceId: string;
}

// Discord/Slack-style reusable invite link — replaces the old per-email
// "send an invite email" flow entirely (see workspaces.routes.ts's
// GET /:workspaceId/invite-link and POST /join), since email delivery isn't
// reliably reachable right now. One link per open, generated fresh each
// time (each is independently valid for 7 days — there's no need to reuse
// exactly the same one), good for any number of people until it expires.
export const InviteMemberModal = ({ isOpen, onClose, workspaceId }: InviteMemberModalProps) => {
  const [link, setLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLink(null);
    setError(null);
    setCopied(false);
    setLoading(true);
    axios.get<{ url: string }>(`/api/workspaces/${workspaceId}/invite-link`)
      .then((res) => setLink(res.data.url))
      .catch((err) => setError(err.response?.data?.error || 'Failed to generate invite link.'))
      .finally(() => setLoading(false));
  }, [isOpen, workspaceId]);

  if (!isOpen) return null;

  const handleCopyLink = () => {
    if (!link) return;
    navigator.clipboard.writeText(link);
    setCopied(true);
    toast.success('Invite link copied!');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        <div className="p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-violet-50 rounded-xl flex items-center justify-center text-violet-600 shrink-0 border border-violet-100">
              <Link2 size={22} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-xl font-black text-gray-900 tracking-tight">Invite people</h3>
              <p className="text-xs text-gray-400 font-bold uppercase tracking-widest leading-none mt-1">Grow your workspace</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors shrink-0"
            >
              <X size={18} />
            </button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm font-bold text-gray-400">
              <Loader2 size={16} className="animate-spin" /> Generating link...
            </div>
          ) : error ? (
            <p className="text-sm font-bold text-red-600 py-4">{error}</p>
          ) : link ? (
            <div>
              <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 block">Invite Link</label>
              <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
                <span className="flex-1 min-w-0 truncate text-sm font-medium text-gray-700">{link}</span>
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="shrink-0 text-violet-600 hover:text-violet-800"
                  title="Copy link"
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>
              <p className="text-xs text-gray-400 mt-2">
                Anyone with this link can join this workspace. Valid for 7 days — share it directly (WhatsApp, chat, etc).
              </p>
            </div>
          ) : null}

          <div className="flex gap-3 mt-8">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-6 py-3 border border-gray-200 text-gray-600 font-black rounded-xl hover:bg-gray-50 transition-all active:scale-95 text-sm"
            >
              Close
            </button>
            {link && (
              <button
                type="button"
                onClick={handleCopyLink}
                className="flex-1 px-6 py-3 bg-violet-600 text-white font-black rounded-xl hover:bg-violet-700 transition-all active:scale-95 text-sm flex items-center justify-center gap-2"
              >
                {copied ? <Check size={16} /> : <Copy size={16} />} Copy Link
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
