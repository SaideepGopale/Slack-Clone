// Typed API layer (F1). New code calls these instead of axios directly;
// existing call sites move over as later phases touch them.
// Side effect first: global axios baseURL (unchanged behaviour, see config.ts).
import './config';
export { ApiError, errorMessage, http, toApiError } from './http';
export * as activityApi from './activity';
export * as adminUsersApi from './adminUsers';
export * as companyOverviewApi from './companyOverview';
export * as channelsApi from './channels';
export * as invitationsApi from './invitations';
export * as organizationsApi from './organizations';
export * as projectsApi from './projects';
export * as tasksApi from './tasks';
export * as teamManagementApi from './teamManagement';
export * as workspacesApi from './workspaces';
export type { SearchResult } from './channels';
export type { ActivityNotification, ConversationRef, WorkspaceSearchResult } from './activity';
export type { InvitationState, InviteResult, JoinRequest, WorkspaceInvitation } from './invitations';
export type {
  OrganizationCapabilities,
  OrganizationDetails,
  OrganizationMember,
  OrganizationRole,
  OrganizationSummary,
  OrganizationWorkspace,
  Page,
} from './organizations';
export type { ProjectDetails, ProjectSummary } from './projects';
export type { TaskDetail, TaskStatus, TaskPriority, TaskView } from './tasks';
export type { ChannelCreationPolicy, WorkspaceRole, WorkspaceSettings, WorkspaceSettingsCapabilities } from './workspaces';
