import { prisma } from './prisma';

export type AuditAction =
  // P2: platform user provisioning and direct workspace membership.
  | 'CREATE_USER'
  | 'UPDATE_USER'
  | 'SET_USER_PASSWORD'
  | 'ADD_WORKSPACE_MEMBER'
  | 'BAN_USER'
  | 'SUSPEND_USER'
  | 'REACTIVATE_USER'
  | 'CHANGE_ROLE'
  | 'DELETE_USER'
  | 'FORCE_PASSWORD_RESET'
  | 'DELETE_CHANNEL'
  | 'DELETE_MESSAGE'
  | 'DELETE_FILE'
  | 'DELETE_WORKSPACE'
  | 'BROADCAST_MESSAGE'
  | 'REMOVE_WORKSPACE_MEMBER'
  | 'REMOVE_CHANNEL_MEMBER'
  | 'CREATE_ORGANIZATION'
  | 'UPDATE_ORGANIZATION'
  | 'CHANGE_ORGANIZATION_ROLE'
  | 'REMOVE_ORGANIZATION_MEMBER'
  | 'UPDATE_WORKSPACE_SETTINGS'
  | 'CHANGE_WORKSPACE_ROLE'
  | 'CREATE_PROJECT'
  | 'UPDATE_PROJECT'
  | 'ARCHIVE_PROJECT'
  | 'RESTORE_PROJECT'
  | 'ADD_PROJECT_MEMBER'
  | 'REMOVE_PROJECT_MEMBER'
  | 'TRANSFER_PROJECT_OWNERSHIP'
  | 'MOVE_CHANNEL_TO_PROJECT'
  | 'MOVE_CHANNEL_TO_WORKSPACE'
  | 'UPDATE_CHANNEL'
  | 'ARCHIVE_CHANNEL'
  | 'RESTORE_CHANNEL'
  | 'CHANGE_CHANNEL_ROLE'
  | 'TRANSFER_CHANNEL_OWNERSHIP'
  | 'CREATE_INVITATION'
  | 'REVOKE_INVITATION'
  | 'REVOKE_INVITE_LINKS'
  | 'APPROVE_JOIN_REQUEST'
  | 'REJECT_JOIN_REQUEST'
  // Stage 2 (T.20): Team Lead provisioning and one-time activation. Details
  // never contain a token or password.
  | 'PROVISION_TEAM_LEAD'
  | 'REVOKE_ACCOUNT_INVITATION'
  | 'REISSUE_ACCOUNT_INVITATION'
  | 'ACTIVATE_ACCOUNT'
  // Stage 3 (T.22): Team Lead → Member provisioning.
  | 'PROVISION_MEMBER';

export type AuditTargetType = 'USER' | 'CHANNEL' | 'MESSAGE' | 'FILE' | 'WORKSPACE' | 'ORGANIZATION' | 'PROJECT';

// Best-effort by design: a logging failure must never turn a successful ban/
// delete/role-change into a failed request for the admin who performed it.
// Errors are swallowed (and only logged to the server console) rather than
// propagated.
export const logAuditEvent = async (
  actorId: string,
  action: AuditAction,
  targetType: AuditTargetType,
  targetId: string | null,
  details: string
) => {
  try {
    await prisma.auditLog.create({ data: { actorId, action, targetType, targetId, details } });
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
};
