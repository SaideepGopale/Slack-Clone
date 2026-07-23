import { createBrowserRouter, Navigate } from 'react-router-dom';
import { ResetPassword } from '../components/auth/ResetPassword';
import { AdminPage } from '../pages/admin/AdminPage';
import { InviteHandler } from '../pages/auth/InviteHandler';
import { LoginPage } from '../pages/auth/LoginPage';
import { ActivityPage } from '../pages/workspace/ActivityPage';
import { ChannelPage } from '../pages/workspace/ChannelPage';
import { DirectoryPage } from '../pages/workspace/DirectoryPage';
import { DMsPage } from '../pages/workspace/DMsPage';
import { HomePage } from '../pages/workspace/HomePage';
import { MorePage } from '../pages/workspace/MorePage';
import { WorkspaceIndex } from '../pages/workspace/WorkspaceIndex';
import { WorkspaceLayout } from '../pages/workspace/WorkspaceLayout';
import { WorkspaceRedirect } from '../pages/workspace/WorkspaceRedirect';
import { ProtectedRoute } from './ProtectedRoute';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  // Same component as /login — AuthForm just defaults to its Sign Up tab
  // (see LoginPage.tsx's startOnSignup prop).
  { path: '/signup', element: <LoginPage /> },
  { path: '/reset-password', element: <ResetPassword /> },
  // The traffic-controller entry point for invite links — inspects the token
  // and routes to /login or /signup (or accepts immediately if already
  // signed in as the invited account). See InviteHandler.tsx.
  { path: '/invite/:token', element: <InviteHandler /> },
  {
    path: '/admin',
    element: (
      <ProtectedRoute requireAdmin>
        <AdminPage />
      </ProtectedRoute>
    ),
  },
  // "/" has no workspace of its own to render — it resolves the user's
  // workspaces and redirects into one of them (see WorkspaceRedirect). This
  // is also every post-login/post-invite-accept/catch-all landing target, so
  // it has to keep working as a bare entry point, not just a redirect source.
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <WorkspaceRedirect />
      </ProtectedRoute>
    ),
  },
  {
    path: '/:workspaceId',
    element: (
      <ProtectedRoute>
        <WorkspaceLayout />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <WorkspaceIndex /> },
      { path: 'home', element: <HomePage /> },
      { path: 'dms', element: <DMsPage /> },
      { path: 'activity', element: <ActivityPage /> },
      { path: 'directory', element: <DirectoryPage /> },
      { path: 'more', element: <MorePage /> },
      { path: 'c/:channelId', element: <ChannelPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
