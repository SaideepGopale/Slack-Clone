import { NextFunction, Request, Response } from 'express';
import { kickUserSockets } from '../sockets/registry';

/**
 * FA-RT-03 (P1-B): a deleted user's live Socket.IO connections are revoked as
 * soon as the deletion succeeds.
 *
 * Banning or suspending a user already disconnects their sockets
 * (admin.service updateUserStatus → kickUserSockets), but deleting one never
 * did: their open sockets stayed in every channel, workspace, presence, thread
 * and call room they had joined, receiving and sending events after the
 * account was gone. The admin module is frozen, so this runs in front of the
 * admin router (mounted in app.ts) and only observes the one route that
 * deletes users — DELETE /api/admin/users/:id:
 *
 *  - It decides nothing and always calls next(): authentication, the admin
 *    check and the deletion itself stay entirely in the admin router
 *    (authenticate → requireAdmin → deleteUserHandler).
 *  - It reacts only to a 2xx response, which deleteUserHandler sends only
 *    after adminService.deleteUser's transaction has committed. Any 4xx/5xx
 *    (not an admin, unknown user, deleting yourself, …) leaves every socket
 *    untouched, so the route cannot be used to disconnect someone else.
 *  - It hooks res.end rather than the 'finish' event, so revocation still
 *    happens when the admin's own HTTP connection drops before the response
 *    can be written ('finish' never fires in that case).
 *
 * Disconnecting runs the existing per-socket cleanup (Socket.IO leaves every
 * room, presence broadcasts user:offline, call peers get webrtc:peer-left),
 * and reconnecting is refused by the unchanged handshake (sockets/index.ts),
 * which requires the user to still exist and be ACTIVE.
 */

// Same matching rules as the admin router's `router.delete('/users/:id')`
// (Express defaults: case-insensitive, optional trailing slash). req.path is
// relative to the '/api/admin' mount point.
const DELETE_USER_PATH = /^\/users\/([^/]+?)\/?$/i;

// A socket whose handshake looked the user up an instant before the deletion
// committed can finish connecting just after the first sweep; a second sweep
// closes that window. Anything later is refused at the handshake.
const RESWEEP_DELAY_MS = 2_000;

const deletedUserId = (req: Request): string | null => {
  if (req.method !== 'DELETE') return null;
  const match = DELETE_USER_PATH.exec(req.path);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null; // Express rejects the same malformed param itself; nothing was deleted
  }
};

const revokeDeletedUserSockets = (userId: string) => {
  kickUserSockets(userId);
  setTimeout(() => kickUserSockets(userId), RESWEEP_DELAY_MS).unref();
};

export const revokeSocketsOnUserDeletion = (req: Request, res: Response, next: NextFunction) => {
  const userId = deletedUserId(req);
  if (userId) {
    const end = res.end as (...args: unknown[]) => Response;
    let observed = false;
    res.end = function observeDeletionOutcome(this: Response, ...args: unknown[]) {
      if (!observed) {
        observed = true;
        if (res.statusCode >= 200 && res.statusCode < 300) revokeDeletedUserSockets(userId);
      }
      return end.apply(this, args);
    } as Response['end'];
  }
  next();
};
