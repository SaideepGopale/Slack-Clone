import axios from 'axios';
import { useEffect, useRef } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { AuthForm } from '../../components/auth/AuthForm';
import { useAuth } from '../../contexts/AuthContext';
import { isAdminAccount } from '../../lib/admin';
import { LoadingScreen } from '../workspace/WorkspaceLayout';

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
  // StrictMode double-invokes effects in dev, which would otherwise fire two
  // near-simultaneous accept calls for the same token — guard so it only
  // ever actually runs once per token, not just tolerate the race server-side.
  const acceptedTokenRef = useRef<string | null>(null);

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

  if (loading) return <LoadingScreen />;
  if (user) {
    if (inviteToken) return <LoadingScreen />; // the effect above takes it from here
    return <Navigate to={isAdminAccount(user) ? '/admin' : '/'} replace />;
  }

  return (
    <AuthForm
      startOnSignup={location.pathname === '/signup'}
      presetEmail={searchParams.get('email') ?? undefined}
    />
  );
};
