import { prisma } from '../../lib/prisma';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * People the caller can see: everyone who shares at least one workspace with
 * them (including themselves). Previously returned every user on the
 * platform, across all tenants (audit SEC-10).
 */
export const listUsers = (userId: string) =>
  prisma.user.findMany({
    where: {
      OR: [{ id: userId }, { workspaces: { some: { workspace: { members: { some: { userId } } } } } }],
    },
    select: { id: true, username: true },
    orderBy: { username: 'asc' },
  });

// Called whenever the caller switches into a workspace (see
// WorkspaceLayout.tsx) — kept in sync so login/signup can tell the frontend
// where to land them next time, instead of always defaulting to whichever
// workspace happens to be first in the list.
export const setLastActiveWorkspace = (userId: string, workspaceId: string) =>
  prisma.user.update({ where: { id: userId }, data: { lastActiveWorkspaceId: workspaceId } });

export const PROFILE_LIMITS = { title: 80, bio: 500, timezone: 64 } as const;

export interface ProfileView {
  title: string | null;
  bio: string | null;
  timezone: string | null;
  readReceiptsEnabled: boolean;
}

const DEFAULT_PROFILE: ProfileView = { title: null, bio: null, timezone: null, readReceiptsEnabled: true };

export const getProfile = async (userId: string): Promise<ProfileView> => {
  const profile = await prisma.userProfile.findUnique({
    where: { userId },
    select: { title: true, bio: true, timezone: true, readReceiptsEnabled: true },
  });
  return profile ?? DEFAULT_PROFILE;
};

const isValidTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const optionalText = (value: unknown, field: string, max: number): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `${field} must be at most ${max} characters.`);
  return trimmed || null;
};

/**
 * Collaboration profile + preferences. Stored in UserProfile, never on the
 * User (authentication) row. Partial updates; unknown fields ignored.
 */
export const updateProfile = async (userId: string, body: unknown): Promise<ProfileView> => {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const title = optionalText(input.title, 'Title', PROFILE_LIMITS.title);
  const bio = optionalText(input.bio, 'Bio', PROFILE_LIMITS.bio);
  const timezone = optionalText(input.timezone, 'Time zone', PROFILE_LIMITS.timezone);
  if (timezone && !isValidTimeZone(timezone)) throw new HttpError(400, 'Unknown time zone.');
  let readReceiptsEnabled: boolean | undefined;
  if (input.readReceiptsEnabled !== undefined) {
    if (typeof input.readReceiptsEnabled !== 'boolean') throw new HttpError(400, 'readReceiptsEnabled must be true or false.');
    readReceiptsEnabled = input.readReceiptsEnabled;
  }

  const data = { title, bio, timezone, readReceiptsEnabled };
  const profile = await prisma.userProfile.upsert({
    where: { userId },
    create: { userId, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) },
    update: data,
    select: { title: true, bio: true, timezone: true, readReceiptsEnabled: true },
  });
  return profile;
};

export { HttpError };
