export interface ReactionSummary {
  emoji: string;
  count: number;
  users: { id: string; username: string }[];
}

interface ReactionRow {
  emoji: string;
  user: { id: string; username: string };
}

// Shared by the socket reaction handlers (live updates) and the REST message
// history endpoint (initial load) so both return the exact same shape —
// the frontend never needs to special-case "just loaded" vs "just changed".
export const groupReactions = (reactions: ReactionRow[]): ReactionSummary[] => {
  const byEmoji = new Map<string, ReactionSummary>();
  for (const r of reactions) {
    const existing = byEmoji.get(r.emoji);
    if (existing) {
      existing.count += 1;
      existing.users.push(r.user);
    } else {
      byEmoji.set(r.emoji, { emoji: r.emoji, count: 1, users: [r.user] });
    }
  }
  return Array.from(byEmoji.values());
};
