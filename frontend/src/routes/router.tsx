import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { RouteErrorScreen } from '../components/ui/ErrorBoundary';
import { LoadingScreen } from '../components/ui/LoadingScreen';
import { LoginPage } from '../pages/auth/LoginPage';
import { WorkspaceIndex } from '../pages/workspace/WorkspaceIndex';
import { WorkspaceLayout } from '../pages/workspace/WorkspaceLayout';
import { WorkspaceRedirect } from '../pages/workspace/WorkspaceRedirect';
import { WorkspacesProvider } from '../pages/workspace/WorkspacesProvider';
import { ProtectedRoute } from './ProtectedRoute';

// T.32 (audit M25): every page beyond sign-in and the workspace shell is its
// own chunk, loaded on first visit — the admin console (charts), the channel
// view (rich-text editor), settings and organization pages no longer weigh
// on everyone's first load.
const page = <T extends Record<string, unknown>>(load: () => Promise<T>, name: keyof T) =>
  lazy(() => load().then((m) => ({ default: m[name] as React.ComponentType })));

const ResetPassword = page(() => import('../components/auth/ResetPassword'), 'ResetPassword');
const AdminPage = page(() => import('../pages/admin/AdminPage'), 'AdminPage');
const ActivateAccountPage = page(() => import('../pages/auth/ActivateAccountPage'), 'ActivateAccountPage');
const InviteHandler = page(() => import('../pages/auth/InviteHandler'), 'InviteHandler');
const JoinWorkspacePage = page(() => import('../pages/auth/JoinWorkspacePage'), 'JoinWorkspacePage');
const ActivityPage = page(() => import('../pages/workspace/ActivityPage'), 'ActivityPage');
const ChannelPage = page(() => import('../pages/workspace/ChannelPage'), 'ChannelPage');
const DirectoryPage = page(() => import('../pages/workspace/DirectoryPage'), 'DirectoryPage');
const DMsPage = page(() => import('../pages/workspace/DMsPage'), 'DMsPage');
const HomePage = page(() => import('../pages/workspace/HomePage'), 'HomePage');
const MorePage = page(() => import('../pages/workspace/MorePage'), 'MorePage');
const MyWorkspacesPage = page(() => import('../pages/workspace/MyWorkspacesPage'), 'MyWorkspacesPage');
const ManagedWorkspacePage = page(() => import('../pages/organization/ManagedWorkspacePage'), 'ManagedWorkspacePage');
const OrganizationPage = page(() => import('../pages/organization/OrganizationPage'), 'OrganizationPage');
const OrganizationRedirect = page(() => import('../pages/organization/OrganizationRedirect'), 'OrganizationRedirect');
const OrganizationsPage = page(() => import('../pages/organization/OrganizationsPage'), 'OrganizationsPage');
const WorkspaceSettingsPage = page(() => import('../pages/workspace/settings/WorkspaceSettingsPage'), 'WorkspaceSettingsPage');
// T.33: projects & tasks.
const ProjectsPage = page(() => import('../pages/projects/ProjectsPage'), 'ProjectsPage');
const ProjectPage = page(() => import('../pages/projects/ProjectPage'), 'ProjectPage');
const MyTasksPage = page(() => import('../pages/projects/MyTasksPage'), 'MyTasksPage');
const TeamTasksPage = page(() => import('../pages/projects/TeamTasksPage'), 'TeamTasksPage');
const ChatsPage = page(() => import('../pages/workspace/ChatsPage'), 'ChatsPage');
const CallsPage = page(() => import('../pages/workspace/CallsPage'), 'CallsPage');

/** Top-level pages: full-screen fallback while a page chunk loads. */
const RootLayout = () => (
  <Suspense fallback={<LoadingScreen />}>
    <Outlet />
  </Suspense>
);

export const router = createBrowserRouter([
  {
    // T.32 (audit M22): one error screen for every route (no blank page).
    element: <RootLayout />,
    errorElement: <RouteErrorScreen />,
    children: [
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
          // T.33: projects (board/list/calendar/workload/overview) and My Tasks.
          { path: 'projects', element: <ProjectsPage /> },
          { path: 'projects/:projectId', element: <ProjectPage /> },
          { path: 'tasks', element: <MyTasksPage /> },
          // T.38: the Team Lead dashboard (lead-only on the server).
          { path: 'team-tasks', element: <TeamTasksPage /> },
          // T.39: the phone's Chats and Calls tabs (usable at any width).
          { path: 'chats', element: <ChatsPage /> },
          { path: 'calls', element: <CallsPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
