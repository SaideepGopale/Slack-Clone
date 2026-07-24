import { Navigate } from 'react-router-dom';
import { useWorkspace } from './WorkspaceContext';

// Landing on "/:workspaceId" (no channel specified) always redirects into
// that workspace's own "General" channel, rather than "whichever channel
// happens to be first". Falls back to any non-DM channel, then any channel
// at all, only as a defensive measure if this workspace's "General" hasn't
// been seeded yet — every workspace gets one automatically on creation (see
// backend workspaces.service.ts), so this should always exist in normal operation.
export const WorkspaceIndex = () => {
  const { workspaceId, channels, channelsLoading } = useWorkspace();

  // Don't navigate off of a channels array that might still belong to a
  // just-departed workspace (see channelsLoading's doc comment in
  // WorkspaceContext.tsx) — wait for a fetch that's actually for this workspace.
  if (channelsLoading) return null;
  if (channels.length === 0) return null;

  const target =
    channels.find(c => !c.isDM && c.name === 'General') ??
    channels.find(c => !c.isDM) ??
    channels[0];

  return <Navigate to={`/${workspaceId}/c/${target.id}`} replace />;
};
