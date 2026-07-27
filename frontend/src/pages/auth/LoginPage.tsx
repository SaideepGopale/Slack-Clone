import axios from 'axios';
import { Clock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { AuthForm } from '../../components/auth/AuthForm';
import { useAuth } from '../../contexts/AuthContext';
import { isAdminAccount } from '../../lib/admin';
import { LoadingScreen } from '../workspace/WorkspaceLayout';

// Shown instead of redirecting into the workspace when a join link now
// requires admin approval (see PendingRequests in Directory.tsx) — the old
// instant-join behavior is still what happens for `inviteToken` (the
// email-bound invite flow) and for a `joinToken` that resolves to
// 'already_member', just not for a fresh 'pending' join request.
const PendingApprovalScreen = () => (
  <div className="min-h-screen bg-[#faf9fa] flex items-center justify-center p-4 font-sans">
    <div className="bg-white p-8 lg:p-10 rounded-[2rem] shadow-xl max-w-md w-full border border-gray-100 text-center">
      <div className="w-16 h-16 bg-amber-50 text-amber-500 rounded-full flex items-center justify-center mx-auto mb-6">
        <Clock size={32} />
      </div>
      <h2 className="text-2xl font-black text-gray-900 mb-2">Request sent successfully!</h2>
      <p className="text-gray-500 font-medium text-sm">Waiting for a workspace admin to approve your request. You'll be able to access the workspace once it's approved.</p>
      <a href="/" className="inline-flex items-center gap-2 text-sm font-bold text-[#350d36] hover:text-purple-900 mt-8">
        Go to home
      </a>
    </div>
  </div>
);

// Serves both /login and /signup — same form, different default tab (see
// AuthForm's startOnSignup prop below). Owning the post-auth invite-accept
// step here (rather than inside AuthForm's own submit handlers) means it
// fires identically whichever way `user` got set — a normal login, or a
// brand-new signup completing its OTP step — without duplicating the logic
// or racing AuthForm's own navigation.
export const LoginPage = () => {
  const { user, loading } = useAuth();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const inviteToken = searchParams.get('inviteToken');
  // Reusable invite-link token (see JoinWorkspacePage.tsx) — a separate query
  // param from inviteToken since it goes through a different backend
  // endpoint (POST /api/workspaces/join, not email-bound) and isn't tied to
  // any specific account, but otherwise follows the exact same "consume once
  // authenticated" shape.
  const joinToken = searchParams.get('joinToken');
  // StrictMode double-invokes effects in dev, which would otherwise fire two
  // near-simultaneous accept calls for the same token — guard so it only
  // ever actually runs once per token, not just tolerate the race server-side.
  const acceptedTokenRef = useRef<string | null>(null);
  const joinedTokenRef = useRef<string | null>(null);
  const [joinPending, setJoinPending] = useState(false);

  useEffect(() => {
    if (!user || !inviteToken) return;
    if (acceptedTokenRef.current === inviteToken) return;
    acceptedTokenRef.current = inviteToken;
    axios.post<{ workspaceId: string; generalChannelId: string }>(`/api/invitations/accept/${inviteToken}`)
      .then(({ data }) => navigate(`/${data.workspaceId}/c/${data.generalChannelId}`, { replace: true }))
      .catch((err) => {
        toast.error(err.response?.data?.error || 'Failed to join the invited workspace.');
        navigate('/', { replace: true });
      });
  }, [user, inviteToken, navigate]);

  useEffect(() => {
    if (!user || !joinToken) return;
    if (joinedTokenRef.current === joinToken) return;
    joinedTokenRef.current = joinToken;
    axios.post<
      { status: 'pending' } | { status: 'already_member'; workspaceId: string; generalChannelId: string }
    >('/api/workspaces/join', { token: joinToken })
      .then(({ data }) => {
        if (data.status === 'already_member') {
          navigate(`/${data.workspaceId}/c/${data.generalChannelId}`, { replace: true });
        } else {
          setJoinPending(true);
        }
      })
      .catch((err) => {
        toast.error(err.response?.data?.error || 'Failed to join the workspace.');
        navigate('/', { replace: true });
      });
  }, [user, joinToken, navigate]);

  if (loading) return <LoadingScreen />;
  if (joinPending) return <PendingApprovalScreen />;
  if (user) {
    if (inviteToken || joinToken) return <LoadingScreen />; // the effects above take it from here
    return <Navigate to={isAdminAccount(user) ? '/admin' : '/'} replace />;
  }

  return (
    <AuthForm
      startOnSignup={location.pathname === '/signup'}
      presetEmail={searchParams.get('email') ?? undefined}
    />
  );
};
