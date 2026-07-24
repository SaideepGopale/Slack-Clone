import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { isAdminAccount } from '../lib/admin';
import { LoadingScreen } from '../pages/workspace/WorkspaceLayout';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
}

export const ProtectedRoute = ({ children, requireAdmin = false }: ProtectedRouteProps) => {
  const { user, loading } = useAuth();

  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;

  const admin = isAdminAccount(user);
  if (requireAdmin && !admin) return <Navigate to="/" replace />;
  if (!requireAdmin && admin) return <Navigate to="/admin" replace />;

  return <>{children}</>;
};
