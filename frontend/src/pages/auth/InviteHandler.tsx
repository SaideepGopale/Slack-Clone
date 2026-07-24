import axios from 'axios';
import { ArrowRight, Loader2, MailWarning } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { useAuth } from '../../contexts/AuthContext';

interface InvitationLookup {
  valid: true;
  email: string;
  workspaceId: string;
  workspaceName: string;
  isExistingUser: boolean;
}

/**
 * The traffic controller for `/invite/:token` — never renders a form itself,
 * just inspects the token and routes to wherever the visitor actually needs
 * to go:
 *   - existing account, already signed in here -> accept immediately, land
 *     straight in the workspace's #general channel.
 *   - existing account, signed out -> /login?inviteToken=..., which repeats
 *     the "accept immediately" step itself once that login succeeds (see
 *     LoginPage.tsx).
 *   - brand-new email -> /signup?inviteToken=...&email=..., which runs the
 *     normal signup+OTP flow with the email pre-filled, then does the same
 *     post-auth accept as the login path.
 */
export const InviteHandler = () => {
  const { token } = useParams<{ token: string }>();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  // This whole flow must run exactly once, but AuthContext's own checkAuth
  // effect hands us a *new* `user` object reference shortly after mount
  // (StrictMode double-invokes it in dev, and even outside StrictMode,
  // /api/auth/me refreshing `user` after login is a real second update) —
  // depending on `user` directly would re-run this effect mid-flight. Refs
  // let the one-shot effect below read the latest auth state without being
  // retriggered by it; `authLoading` is a primitive boolean, so it only ever
  // flips false once and is safe to depend on directly.
  const userRef = useRef(user);
  userRef.current = user;
  const startedRef = useRef(false);

  useEffect(() => {
    if (authLoading) return; // wait until we actually know if there's a session
    if (startedRef.current) return;
    if (!token) {
      setError('No invitation token was provided.');
      return;
    }
    startedRef.current = true;

    axios.get<InvitationLookup>(`/api/invitations/${token}`)
      .then(async ({ data }) => {
        if (data.isExistingUser && userRef.current) {
          try {
            const res = await axios.post<{ workspaceId: string; generalChannelId: string }>(
              `/api/invitations/accept/${token}`
            );
            navigate(`/${res.data.workspaceId}/c/${res.data.generalChannelId}`, { replace: true });
          } catch (err: any) {
            // Most likely: signed in as a different account than the one
            // this invite was sent to (see acceptInvitation's email check) —
            // don't strand them on a blank page, just send them home.
            toast.error(err.response?.data?.error || 'Failed to join the workspace.');
            navigate('/', { replace: true });
          }
          return;
        }

        if (data.isExistingUser) {
          navigate(`/login?inviteToken=${token}`, { replace: true });
          return;
        }

        navigate(`/signup?inviteToken=${token}&email=${encodeURIComponent(data.email)}`, { replace: true });
      })
      .catch((err) => {
        setError(err.response?.data?.error || 'This invitation link is invalid or has expired.');
      });
  }, [token, authLoading, navigate]);

  if (error) {
    return (
      <div className="min-h-screen bg-[#faf9fa] flex items-center justify-center p-4 font-sans">
        <div className="bg-white p-8 lg:p-10 rounded-[2rem] shadow-xl max-w-md w-full border border-gray-100 text-center">
          <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6">
            <MailWarning size={32} />
          </div>
          <h2 className="text-2xl font-black text-gray-900 mb-2">Invitation not valid</h2>
          <p className="text-gray-500 font-medium text-sm mb-8">{error}</p>
          <a href="/login" className="inline-flex items-center gap-2 text-sm font-bold text-[#350d36] hover:text-purple-900">
            Go to sign in <ArrowRight size={16} />
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#faf9fa] flex items-center justify-center p-4">
      <Loader2 className="animate-spin text-[#350d36]" size={32} />
    </div>
  );
};
