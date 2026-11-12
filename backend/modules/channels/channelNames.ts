import { Prisma } from '@prisma/client';
import { HttpError } from '../../lib/httpError';
import { canChannel, isGeneralChannelName, projectAllowsChannelAccess, toChannelActor, WorkspaceActor } from '../../lib/policy';

/**
 * Channel names (Batch 3 / Sub-batch D, decision 7): unique per workspace,
 * case-insensitively, enforced in application logic — no DB unique index.
 *
 * PRIVACY: a "name taken" error is itself an existence oracle, so a name only
 * counts as taken when the conflicting channel is one the actor is allowed to
 * see (lib/policy canChannel 'channel.view'). Private channels — and channels
 * of private projects — that the actor can't see never block a name and are
 * never mentioned. Checks run again whenever a channel becomes visible to more
 * people (private → public, leaving a private project, a project going public).
 * Archived channels keep their names reserved (for whoever can see them).
 */

export const CHANNEL_NAME_MAX = 80;

export const parseChannelName = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'Channel name is required');
  const name = value.trim();
  if (name.length > CHANNEL_NAME_MAX) throw new HttpError(400, `Channel name must be ${CHANNEL_NAME_MAX} characters or fewer`);
  if (isGeneralChannelName(name)) throw new HttpError(400, '"General" is reserved for the default workspace channel');
  return name;
};

type Tx = Prisma.TransactionClient;

/**
 * Serializes name checks within one workspace so two concurrent creates or
 * renames can't both pass. Lock order across the codebase: channel row →
 * project row → this lock (see modules/projects/projectGuards.ts).
 */
const lockWorkspaceChannelNames = (tx: Tx, workspaceId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`channel-names:${workspaceId}`}))`;

/** Throws 409 when `name` is taken by a channel `actor` can see. Call inside the write transaction. */
export const assertChannelNameAvailable = async (tx: Tx, actor: WorkspaceActor, name: string, excludeChannelId?: string) => {
  await lockWorkspaceChannelNames(tx, actor.workspaceId);
  const candidates = await tx.channel.findMany({
    where: {
      workspaceId: actor.workspaceId,
      isDM: false,
      name: { equals: name, mode: 'insensitive' },
      ...(excludeChannelId ? { id: { not: excludeChannelId } } : {}),
    },
    select: {
      id: true,
      name: true,
      isDM: true,
      isGroupDM: true,
      visibility: true,
      isAnnouncement: true,
      archivedAt: true,
      members: { where: { userId: actor.userId }, select: { role: true } },
      project: { select: { visibility: true, members: { where: { userId: actor.userId }, select: { id: true } } } },
    },
  });
  const visibleConflict = candidates.some((c) =>
    canChannel(
      toChannelActor(actor, c, c.members[0]?.role, projectAllowsChannelAccess(c.project, (c.project?.members.length ?? 0) > 0)),
      'channel.view'
    )
  );
  if (visibleConflict) throw new HttpError(409, `A channel named "${name}" already exists in this workspace.`);
};
