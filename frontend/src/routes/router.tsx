import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { ResetPassword } from '../components/auth/ResetPassword';
import { AdminPage } from '../pages/admin/AdminPage';
import { ActivateAccountPage } from '../pages/auth/ActivateAccountPage';
import { InviteHandler } from '../pages/auth/InviteHandler';
import { JoinWorkspacePage } from '../pages/auth/JoinWorkspacePage';
import { LoginPage } from '../pages/auth/LoginPage';
import { ActivityPage } from '../pages/workspace/ActivityPage';
import { ChannelPage } from '../pages/workspace/ChannelPage';
import { DirectoryPage } from '../pages/workspace/DirectoryPage';
import { DMsPage } from '../pages/workspace/DMsPage';
import { HomePage } from '../pages/workspace/HomePage';
import { MorePage } from '../pages/workspace/MorePage';
import { MyWorkspacesPage } from '../pages/workspace/MyWorkspacesPage';
import { WorkspaceIndex } from '../pages/workspace/WorkspaceIndex';
import { WorkspaceLayout } from '../pages/workspace/WorkspaceLayout';
import { WorkspaceRedirect } from '../pages/workspace/WorkspaceRedirect';
import { WorkspacesProvider } from '../pages/workspace/WorkspacesProvider';
import { ManagedWorkspacePage } from '../pages/organization/ManagedWorkspacePage';
import { OrganizationPage } from '../pages/organization/OrganizationPage';
import { OrganizationRedirect } from '../pages/organization/OrganizationRedirect';
import { OrganizationsPage } from '../pages/organization/OrganizationsPage';
import { WorkspaceSettingsPage } from '../pages/workspace/settings/WorkspaceSettingsPage';
import { ProjectShell, ProjectsShell } from '../pages/workspace/shells/RouteShells';
import { ProtectedRoute } from './ProtectedRoute';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  // Same component as /login — AuthForm just defaults to its Sign Up tab
  // (see LoginPage.tsx's startOnSignup prop).
  { path: '/signup', element: <LoginPage /> },
  { path: '/reset-password', element: <ResetPassword /> },
  // Stage 2 (T.20): one-time account activation (token in the URL fragment).
  // Public: it creates no session — people sign in normally afterwards.
  { path: '/activate', element: <ActivateAccountPage /> },
  // The traffic-controller entry point for invite links — inspects the token
  // and routes to /login or /signup (or accepts immediately if already
  // signed in as the invited account). See InviteHandler.tsx.
  { path: '/invite/:token', element: <InviteHandler /> },
  // Discord/Slack-style reusable invite link — ?token=<jwt>, not bound to any
  // specific email. See JoinWorkspacePage.tsx.
  { path: '/join-workspace', element: <JoinWorkspacePage /> },
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
  // Every authenticated workspace route shares ONE workspace list
  // (WorkspacesProvider, F1). The guard is the same ProtectedRoute as before,
  // applied once to this pathless parent instead of to each child.
  {
    element: (
      <ProtectedRoute>
        <WorkspacesProvider>
          <Outlet />
        </WorkspacesProvider>
      </ProtectedRoute>
    ),
    children: [
      { path: '/', element: <WorkspaceRedirect /> },
      {
        path: '/:workspaceId',
        element: <WorkspaceLayout />,
        children: [
          { index: true, element: <WorkspaceIndex /> },
          { path: 'home', element: <HomePage /> },
          { path: 'dms', element: <DMsPage /> },
          { path: 'activity', element: <ActivityPage /> },
          { path: 'directory', element: <DirectoryPage /> },
          { path: 'more', element: <MorePage /> },
          // Stage 3 (T.22): a Team Lead's workspaces dashboard.
          { path: 'my-workspaces', element: <MyWorkspacesPage /> },
          { path: 'c/:channelId', element: <ChannelPage /> },
          // F2: workspace + organization administration. They render inside
          // the CURRENT workspace's layout (socket, navigation) and only call
          // management endpoints, so an organization admin can manage another
          // workspace of the organization without loading its content.
          { path: 'settings', element: <WorkspaceSettingsPage /> },
          { path: 'organization', element: <OrganizationRedirect /> },
          { path: 'organizations', element: <OrganizationsPage /> },
          { path: 'organizations/:organizationId', element: <OrganizationPage /> },
          { path: 'organizations/:organizationId/workspaces/:managedWorkspaceId', element: <ManagedWorkspacePage /> },
          // F1 route shells for F3 — not linked from navigation yet.
          { path: 'projects', element: <ProjectsShell /> },
          { path: 'projects/:projectId', element: <ProjectShell /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
