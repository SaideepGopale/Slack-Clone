import { Navigate, useSearchParams } from 'react-router-dom';

/**
 * Entry point for reusable invite links (`/join-workspace?token=...`) —
 * unlike InviteHandler.tsx (email-bound invites), this link isn't tied to
 * any specific account, so there's no lookup needed to decide "login or
 * signup": just hand the token to LoginPage via `joinToken`, which shows the
 * normal AuthForm (both tabs available) and consumes the token once
 * authentication succeeds, whichever way that happened.
 */
export const JoinWorkspacePage = () => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  if (!token) return <Navigate to="/login" replace />;
  return <Navigate to={`/login?joinToken=${encodeURIComponent(token)}`} replace />;
};
