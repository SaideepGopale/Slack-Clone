import type { ChannelDetails, Message } from '../../types';
import { http, seg } from './http';

/** A message returned by in-channel search (newest first, at most 50). */
export type SearchResult = Message;

/**
 * GET /api/channels/:id/search?q= — server-side, membership-checked search
 * within ONE channel or DM (respects the member's visible-history window).
 * There is deliberately no global search API yet.
 */
export const searchChannelMessages = (channelId: string, query: string) =>
  http.get<SearchResult[]>(`/api/channels/${seg(channelId)}/search`, { q: query });

export const getChannelDetails = (channelId: string) => http.get<ChannelDetails>(`/api/channels/${seg(channelId)}/details`);
