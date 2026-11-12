import { RefreshCw, WifiOff } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { useAuth } from '../contexts/AuthContext';
import { isAdminAccount } from '../lib/admin';
import { LoadingScreen } from '../components/ui/LoadingScreen';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
}

/**
 * T.32 (audit M17): shown when the session could not be checked because the
 * server was unreachable — the user stays signed in and can retry.
 */
const SessionUnavailable = ({ message, onRetry, onSignOut }: { message: string; onRetry: () => void; onSignOut: () => void }) => (
  <div role="alert" className="min-h-screen flex items-center justify-center bg-surface-secondary px-4">
    <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 text-center shadow-sm">
      <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-warning-soft text-warning">
        <WifiOff size={18} aria-hidden="true" />
      </span>
      <h1 className="text-base font-semibold text-fg">Can’t reach SmartConnect</h1>
      <p className="mt-1 text-sm text-fg-muted">{message}</p>
      <div className="mt-5 flex justify-center gap-2">
        <Button variant="secondary" size="sm" onClick={onSignOut}>Sign out</Button>
        <Button size="sm" icon={<RefreshCw size={14} aria-hidden="true" />} onClick={onRetry}>Try again</Button>
      </div>
    </div>
  </div>
);

export const ProtectedRoute = ({ children, requireAdmin = false }: ProtectedRouteProps) => {
  const { user, loading, sessionError, retrySession, logout } = useAuth();

  if (loading) return <LoadingScreen />;
  if (!user && sessionError) return <SessionUnavailable message={sessionError} onRetry={retrySession} onSignOut={logout} />;
  if (!user) return <Navigate to="/login" replace />;

  const admin = isAdminAccount(user);
  if (requireAdmin && !admin) return <Navigate to="/" replace />;
  if (!requireAdmin && admin) return <Navigate to="/admin" replace />;

  return <>{children}</>;
};
