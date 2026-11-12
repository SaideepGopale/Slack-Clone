import { Server } from 'socket.io';
import { prisma } from '../lib/prisma';
import { isAdminUser } from '../middleware/admin.middleware';
import { HEARTBEAT_MS, getPresenceStore, PresenceRecord } from './presenceStore';
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
 * T.33: the state lives in a PresenceStore (presenceStore.ts) — in memory for
 * one process, in Redis when REDIS_URL is set so every instance sees the same
 * online set. Emits go to rooms, which the Socket.IO Redis adapter delivers
 * on every instance.
 */

export type PublicPresence = PresenceRecord;

const STATUS_EMOJI: Record<string, string> = { active: '🟢', away: '🟡', in_meeting: '🔴' };

export { workspaceRoom };
export const PRESENCE_ADMIN_ROOM = 'presence:admins';

const store = () => getPresenceStore();

// Everyone allowed to observe a user's presence.
const audienceRooms = (workspaceIds: string[]) => [...workspaceIds.map(workspaceRoom), PRESENCE_ADMIN_ROOM];

const emitOnlineCount = async (io: Server) => {
  io.to(PRESENCE_ADMIN_ROOM).emit('admin:stats:onlineCount', await store().onlineCount());
};

/** Presence of `userId` as seen inside `workspaceId` (null = offline or not a member). */
export const getPresenceInWorkspace = async (userId: string, workspaceId: string): Promise<PublicPresence | null> =>
  (await store().presenceIn([userId], workspaceId)).get(userId) ?? null;

/** Batch form for member lists (one round trip). */
export const getPresenceMapInWorkspace = (userIds: string[], workspaceId: string) => store().presenceIn(userIds, workspaceId);

export const registerPresenceHandlers = (io: Server, socket: AuthenticatedSocket) => {
  const user = socket.user;
  if (!user?.id) return;

  // Resolves true once this socket is counted as online. Every later handler
  // waits for it, so a disconnect that races the initial queries is never
  // lost (which would leave a ghost "online" socket behind).
  const ready = (async () => {
    const [memberships, admin] = await Promise.all([
      prisma.workspaceMember.findMany({ where: { userId: user.id }, select: { workspaceId: true } }),
      isAdminUser(user.id),
    ]);
    if (socket.disconnected) return false;

    const workspaceIds = memberships.map((m) => m.workspaceId);
    if (workspaceIds.length > 0) socket.join(workspaceIds.map(workspaceRoom));
    if (admin) socket.join(PRESENCE_ADMIN_ROOM);

    const { isNew } = await store().connect({ id: user.id, username: user.username, isAdmin: admin }, socket.id, workspaceIds);
    const users = await store().snapshotFor(user.id);
    socket.emit('presence:init', { users });
    if (isNew) {
      const self = users.find((u) => u.id === user.id) ?? { id: user.id, username: user.username, status: 'active', emoji: STATUS_EMOJI.active };
      io.to(audienceRooms(workspaceIds)).emit('user:online', self);
      await emitOnlineCount(io);
    }
    return true;
  })().catch((err) => {
    console.error('presence init failed:', err instanceof Error ? err.message : err);
    return false;
  });

  socket.on('user:status', (data: { status?: unknown }) => {
    const status = typeof data?.status === 'string' && data.status in STATUS_EMOJI ? data.status : null;
    if (!status) return;
    ready
      .then(async (ok) => {
        if (!ok) return;
        const result = await store().setStatus(user.id, status, STATUS_EMOJI[status]);
        if (result) io.to(audienceRooms(result.workspaceIds)).emit('user:online', result.record);
      })
      .catch((err) => console.error('presence status failed:', err instanceof Error ? err.message : err));
  });

  socket.on('disconnect', () => {
    ready
      .then(async (ok) => {
        if (!ok) return;
        const result = await store().disconnect(user.id, socket.id);
        if (!result.offline) return;
        io.to(audienceRooms(result.workspaceIds)).emit('user:offline', { id: user.id });
        await emitOnlineCount(io);
      })
      .catch((err) => console.error('presence disconnect failed:', err instanceof Error ? err.message : err));
  });
};

/**
 * Keeps this instance's sockets fresh in the shared store and, on whichever
 * instance holds the sweep lock, takes users offline whose instance died
 * without running disconnect handlers. No-op work for the memory store.
 */
export const startPresenceHeartbeat = (io: Server) => {
  const timer = setInterval(() => {
    const local: [string, string][] = [];
    for (const socket of io.sockets.sockets.values()) {
      const id = (socket as AuthenticatedSocket).user?.id;
      if (id) local.push([id, socket.id]);
    }
    (async () => {
      await store().heartbeat(local);
      const offline = await store().sweep();
      for (const { userId, workspaceIds } of offline) io.to(audienceRooms(workspaceIds)).emit('user:offline', { id: userId });
      if (offline.length > 0) await emitOnlineCount(io);
    })().catch((err) => console.error('presence heartbeat failed:', err instanceof Error ? err.message : err));
  }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
};

/** A user gained a workspace at runtime (created it, invite accepted, request approved). */
export const addWorkspacePresence = (userId: string, workspaceId: string) => {
  const io = getSocketServer();
  if (!io) return;
  io.in(`user:${userId}`).socketsJoin(workspaceRoom(workspaceId));
  (async () => {
    const record = await store().addWorkspace(userId, workspaceId);
    if (!record) return;
    io.to(workspaceRoom(workspaceId)).emit('user:online', record);
    io.to(`user:${userId}`).emit('presence:init', { users: await store().snapshotFor(userId) });
  })().catch((err) => console.error('presence add failed:', err instanceof Error ? err.message : err));
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
  (async () => {
    const result = await store().removeWorkspace(userId, workspaceId);
    if (!result) return;
    const remaining = new Set(result.remaining);
    for (const otherId of await store().onlineUsersIn(workspaceId)) {
      if (otherId === userId) continue;
      const other = await store().infoOf(otherId);
      if (!other || other.isAdmin) continue;
      if (other.workspaceIds.some((w) => remaining.has(w))) continue;
      io.to(`user:${otherId}`).emit('user:offline', { id: userId });
    }
    io.to(`user:${userId}`).emit('presence:init', { users: await store().snapshotFor(userId) });
  })().catch((err) => console.error('presence remove failed:', err instanceof Error ? err.message : err));
};
