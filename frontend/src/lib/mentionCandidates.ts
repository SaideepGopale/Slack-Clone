import axios from 'axios';

export interface MentionCandidate {
  id: string;
  username: string;
}

export const MENTION_SUGGESTION_LIMIT = 8;

/**
 * People the composer suggests for an @mention (P3). Channels ask the server
 * for matching members; DMs and group DMs use the conversation's own
 * participants (at most a handful), ranked so names that start with the query
 * come first. You are never suggested to yourself.
 */
export const fetchMentionCandidates = async (
  channel: { id: string; isDM?: boolean },
  query: string,
  currentUserId?: string
): Promise<MentionCandidate[]> => {
  if (!channel.isDM) {
    const res = await axios.get<{ members?: { user: MentionCandidate }[] }>(`/api/channels/${channel.id}/members`, {
      params: { q: query, limit: MENTION_SUGGESTION_LIMIT },
    });
    return (res.data.members ?? []).map((m) => m.user).filter((u) => u.id !== currentUserId);
  }

  const res = await axios.get<{ participants?: MentionCandidate[] }>(`/api/channels/${channel.id}/participants`);
  const q = query.toLowerCase();
  const rank = (name: string) => (name.toLowerCase().startsWith(q) ? 0 : 1);
  return (res.data.participants ?? [])
    .filter((u) => u.id !== currentUserId && u.username.toLowerCase().includes(q))
    .sort((a, b) => rank(a.username) - rank(b.username) || a.username.localeCompare(b.username))
    .slice(0, MENTION_SUGGESTION_LIMIT)
    .map(({ id, username }) => ({ id, username }));
};
