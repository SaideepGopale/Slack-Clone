import { prisma } from './prisma';

export type AuditAction =
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
  | 'BROADCAST_MESSAGE';

export type AuditTargetType = 'USER' | 'CHANNEL' | 'MESSAGE' | 'FILE' | 'WORKSPACE';

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
