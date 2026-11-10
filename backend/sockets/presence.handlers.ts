import { Server } from 'socket.io';
import { prisma } from '../lib/prisma';
import { isAdminUser } from '../middleware/admin.middleware';
import { getSocketServer, workspaceRoom } from './registry';
import { AuthenticatedSocket } from './types';

/**
 * Workspace-scoped presence (Batch 2, audit SEC-10).
 *
 * Previously every presence change was broadcast to every connected socket,
 * so anyone could see who was online in every other workspace/tenant. Now:
 *  - each socket joins `ws:<workspaceId>` for every workspace its user is a
 *    member of;
 *  - a user's online/status/offline events go only to the rooms of the
 *    workspaces they belong to (plus the platform-admin room);
 *  - `presence:init` contains only users who share at least one workspace
 *    with the viewer.
 * Platform admins keep the global view the admin panel relies on, via the
 * dedicated `presence:admins` room (same event names, same payloads).
 *
 * In-memory, single-process (see revocation.ts for the multi-instance note).
 */

interface OnlineUser {
  id: string;
  username: string;
  status: string;
  emoji: string;
  sockets: Set<string>;
  workspaceIds: Set<string>;
  isAdmin: boolean;
}

export interface PublicPresence {
  id: string;
  username: string;
  status: string;
  emoji: string;
}

const STATUS_EMOJI: Record<string, string> = { active: '🟢', away: '🟡', in_meeting: '🔴' };

const onlineUsers = new Map<string, OnlineUser>();

export { workspaceRoom };
export const PRESENCE_ADMIN_ROOM = 'presence:admins';

const toPublic = ({ id, username, status, emoji }: OnlineUser): PublicPresence => ({ id, username, status, emoji });

const sharesWorkspace = (a: Set<string>, b: Set<string>) => {
  for (const id of a) if (b.has(id)) return true;
  return false;
};

// Everyone allowed to observe `subject`'s presence.
const audienceRooms = (subject: OnlineUser) => [...Array.from(subject.workspaceIds).map(workspaceRoom), PRESENCE_ADMIN_ROOM];

const snapshotFor = (viewer: OnlineUser): PublicPresence[] =>
  Array.from(onlineUsers.values())
    .filter((u) => viewer.isAdmin || u.id === viewer.id || sharesWorkspace(viewer.workspaceIds, u.workspaceIds))
    .map(toPublic);

/** Presence of `userId` as seen inside `workspaceId` (null = offline or not a member). */
export const getPresenceInWorkspace = (userId: string, workspaceId: string): PublicPresence | null => {
  const user = onlineUsers.get(userId);
  return user && user.workspaceIds.has(workspaceId) ? toPublic(user) : null;
};

export const registerPresenceHandlers = (io: Server, socket: AuthenticatedSocket) => {
  const user = socket.user;
  if (!user?.id) return;
  let registered = false;

  const init = async () => {
    const [memberships, admin] = await Promise.all([
      prisma.workspaceMember.findMany({ where: { userId: user.id }, select: { workspaceId: true } }),
      isAdminUser(user.id),
    ]);
    // The socket may have gone away while we were querying.
    if (socket.disconnected) return;

    const workspaceIds = memberships.map((m) => m.workspaceId);
    if (workspaceIds.length > 0) socket.join(workspaceIds.map(workspaceRoom));
    if (admin) socket.join(PRESENCE_ADMIN_ROOM);

    let presence = onlineUsers.get(user.id);
    const isNew = !presence;
    if (!presence) {
      presence = {
        id: user.id,
        username: user.username,
        status: 'active',
        emoji: STATUS_EMOJI.active,
        sockets: new Set(),
        workspaceIds: new Set(),
        isAdmin: admin,
      };
      onlineUsers.set(user.id, presence);
    }
    presence.sockets.add(socket.id);
    for (const id of workspaceIds) presence.workspaceIds.add(id);
    presence.isAdmin = admin;
    registered = true;

    socket.emit('presence:init', { users: snapshotFor(presence) });
    if (isNew) {
      io.to(audienceRooms(presence)).emit('user:online', toPublic(presence));
      io.to(PRESENCE_ADMIN_ROOM).emit('admin:stats:onlineCount', onlineUsers.size);
    }
  };
  init().catch((err) => console.error('presence init failed:', err));

  socket.on('user:status', (data: { status?: unknown }) => {
    const current = onlineUsers.get(user.id);
    if (!registered || !current) return;
    const status = typeof data?.status === 'string' && data.status in STATUS_EMOJI ? data.status : null;
    if (!status) return;
    current.status = status;
    current.emoji = STATUS_EMOJI[status];
    io.to(audienceRooms(current)).emit('user:online', toPublic(current));
  });

  socket.on('disconnect', () => {
    if (!registered) return;
    const current = onlineUsers.get(user.id);
    if (!current) return;
    current.sockets.delete(socket.id);
    if (current.sockets.size === 0) {
      onlineUsers.delete(user.id);
      io.to(audienceRooms(current)).emit('user:offline', { id: user.id });
      io.to(PRESENCE_ADMIN_ROOM).emit('admin:stats:onlineCount', onlineUsers.size);
    }
  });
};

/** A user gained a workspace at runtime (created it, invite accepted, request approved). */
export const addWorkspacePresence = (userId: string, workspaceId: string) => {
  const io = getSocketServer();
  if (!io) return;
  io.in(`user:${userId}`).socketsJoin(workspaceRoom(workspaceId));
  const presence = onlineUsers.get(userId);
  if (!presence || presence.workspaceIds.has(workspaceId)) return;
  presence.workspaceIds.add(workspaceId);
  io.to(workspaceRoom(workspaceId)).emit('user:online', toPublic(presence));
  io.to(`user:${userId}`).emit('presence:init', { users: snapshotFor(presence) });
};

/**
 * A user lost a workspace (removed, left, workspace deleted). Their sockets
 * leave the workspace room; members of that workspace who no longer share
 * any workspace with them stop seeing them; their own view is recomputed.
 */
export const removeWorkspacePresence = (userId: string, workspaceId: string) => {
  const io = getSocketServer();
  if (!io) return;
  io.in(`user:${userId}`).socketsLeave(workspaceRoom(workspaceId));
  const presence = onlineUsers.get(userId);
  if (!presence) return;
  presence.workspaceIds.delete(workspaceId);
  for (const other of onlineUsers.values()) {
    if (other.id === userId || other.isAdmin || !other.workspaceIds.has(workspaceId)) continue;
    if (sharesWorkspace(other.workspaceIds, presence.workspaceIds)) continue;
    io.to(`user:${other.id}`).emit('user:offline', { id: userId });
  }
  io.to(`user:${userId}`).emit('presence:init', { users: snapshotFor(presence) });
};
