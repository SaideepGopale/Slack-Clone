import type { Channel, ChannelDetails, ChannelRole } from '../types';

/** Human labels for the stored channel roles ('admin' is the Channel Owner). */
export const ROLE_LABELS: Record<ChannelRole, string> = {
  admin: 'Owner',
  moderator: 'Moderator',
  member: 'Member',
};

/** Short type label shown in headers and lists. */
export const channelTypeLabel = (channel: Pick<Channel, 'visibility' | 'isAnnouncement'>) => {
  const visibility = channel.visibility === 'PRIVATE' ? 'Private' : 'Public';
  return channel.isAnnouncement ? `${visibility} announcement channel` : `${visibility} channel`;
};

export type ComposerState = { mode: 'open' } | { mode: 'locked'; reason: 'archived' | 'announcement' | 'not-member' };

/**
 * What the message composer should show for a channel. The server enforces
 * the same rules (lib/policy canChannelContent); this only avoids offering an
 * action that would be refused. Unknown details (still loading, DMs) → open.
 */
export const composerState = (details: ChannelDetails | null): ComposerState => {
  if (!details) return { mode: 'open' };
  if (details.capabilities.canPost) return { mode: 'open' };
  if (details.archived) return { mode: 'locked', reason: 'archived' };
  if (!details.capabilities.canRead) return { mode: 'locked', reason: 'not-member' };
  return { mode: 'locked', reason: 'announcement' };
};

export const COMPOSER_NOTICES: Record<'archived' | 'announcement' | 'not-member', string> = {
  archived: 'This channel is archived. Its history stays readable, but nobody can post, reply or react.',
  announcement: 'Only channel owners, moderators and workspace admins can post here. You can still reply in threads and react.',
  'not-member': 'Join this channel to send messages.',
};

/** Sidebar rule: archived channels are hidden unless currently open. */
export const isSidebarVisible = (channel: Channel, activeChannelId?: string | null) =>
  !channel.archivedAt || channel.id === activeChannelId;
