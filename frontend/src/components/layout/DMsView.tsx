import { formatDistanceToNowStrict } from 'date-fns';
import { MessageSquare, Search, SquarePen, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatUnread } from '../../lib/unread';
import { Channel, User } from '../../types';

interface DMsViewProps {
  dms: Channel[];
  onlineUsers: User[];
  unreadCounts: Record<string, number>;
  currentUserId?: string;
  loading?: boolean;
  onSelectChannel: (channel: Channel) => void;
  onNewConversation: () => void;
}

const activityTime = (dm: Channel) => new Date(dm.lastActivityAt ?? dm.createdAt ?? 0).getTime();

/**
 * Direct Messages page — every conversation the user participates in, most
 * recently active first, with a last-message preview, unread badge and the
 * other participant's presence. Previously this filtered the public-channel
 * list for DMs (which never contains any) and was always empty.
 */
export const DMsView = ({
  dms,
  onlineUsers,
  unreadCounts,
  currentUserId,
  loading = false,
  onSelectChannel,
  onNewConversation,
}: DMsViewProps) => {
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...dms]
      .filter((dm) => !q || dm.name?.toLowerCase().includes(q) || dm.lastMessage?.preview.toLowerCase().includes(q))
      .sort((a, b) => activityTime(b) - activityTime(a));
  }, [dms, query]);

  const onlineIds = useMemo(() => new Set(onlineUsers.map((u) => u.id)), [onlineUsers]);

  return (
    <div className="flex-1 flex flex-col h-full bg-white min-w-0">
      <div className="h-16 border-b border-gray-100 flex items-center justify-between gap-3 px-4 md:px-6 shrink-0">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-gray-900 tracking-tight">Direct Messages</h1>
          <p className="text-[11px] text-gray-400 font-bold uppercase tracking-widest leading-none mt-1">
            {dms.length} {dms.length === 1 ? 'conversation' : 'conversations'}
          </p>
        </div>
        <button
          type="button"
          onClick={onNewConversation}
          className="shrink-0 inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
        >
          <SquarePen size={16} aria-hidden="true" />
          New message
        </button>
      </div>

      <div className="px-4 md:px-6 py-3 border-b border-gray-50 shrink-0">
        <label className="relative block max-w-xl">
          <span className="sr-only">Search conversations</span>
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            className="w-full bg-gray-50 border border-gray-200 rounded-lg py-2 pl-10 pr-3 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100"
          />
        </label>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && dms.length === 0 ? (
          <p className="p-8 text-center text-sm text-gray-400" role="status">
            Loading conversations…
          </p>
        ) : dms.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
            <div className="w-16 h-16 bg-gray-50 rounded-2xl flex items-center justify-center text-gray-300 mb-5">
              <MessageSquare size={32} aria-hidden="true" />
            </div>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">No conversations yet</h2>
            <p className="text-sm text-gray-500 max-w-sm mb-6">
              Direct messages are private conversations between you and a teammate.
            </p>
            <button
              type="button"
              onClick={onNewConversation}
              className="px-6 py-2.5 bg-violet-600 text-white font-semibold rounded-lg hover:bg-violet-700"
            >
              Find teammates
            </button>
          </div>
        ) : visible.length === 0 ? (
          <p className="p-8 text-center text-sm text-gray-400">No conversations match "{query}".</p>
        ) : (
          <ul className="divide-y divide-gray-50" aria-label="Direct message conversations">
            {visible.map((dm) => {
              const unread = unreadCounts[dm.id] ?? 0;
              const isGroup = !!dm.isGroupDM;
              const online = !isGroup && !!dm.otherUserId && onlineIds.has(dm.otherUserId);
              const peopleCount = dm.participants?.length ?? 0;
              const preview = dm.lastMessage
                ? `${dm.lastMessage.senderId === currentUserId ? 'You: ' : ''}${dm.lastMessage.preview}`
                : 'No messages yet — say hello';
              const when = dm.lastMessage ? formatDistanceToNowStrict(new Date(dm.lastMessage.createdAt), { addSuffix: true }) : '';
              return (
                <li key={dm.id}>
                  <button
                    type="button"
                    onClick={() => onSelectChannel(dm)}
                    className="w-full flex items-center gap-3.5 px-4 md:px-6 py-3.5 text-left hover:bg-gray-50 focus-visible:bg-violet-50 focus-visible:outline-none"
                    aria-label={`Open ${isGroup ? 'group conversation' : 'conversation with'} ${dm.name}${unread ? `, ${unread} unread` : ''}`}
                  >
                    <span className="relative shrink-0">
                      <span className="w-11 h-11 rounded-xl bg-accent-600 text-white flex items-center justify-center font-bold uppercase">
                        {isGroup ? <Users size={20} aria-hidden="true" /> : dm.name?.[0] ?? '?'}
                      </span>
                      {!isGroup && (
                        <span
                          className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white ${online ? 'bg-emerald-500' : 'bg-gray-300'}`}
                          aria-label={online ? 'Online' : 'Offline'}
                          role="img"
                        />
                      )}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className={`truncate text-[15px] ${unread ? 'font-semibold text-gray-900' : 'font-semibold text-gray-800'}`}>
                          {dm.name}
                        </span>
                        {when && <span className="shrink-0 text-[11px] text-gray-400">{when}</span>}
                      </span>
                      {isGroup && <span className="block text-[11px] text-gray-400">{peopleCount} people</span>}
                      <span className={`block truncate text-sm ${unread ? 'text-gray-800 font-medium' : 'text-gray-500'}`}>{preview}</span>
                    </span>
                    {unread > 0 && (
                      <span className="shrink-0 min-w-[22px] h-[22px] px-1.5 rounded-full bg-red-500 text-white text-[11px] font-semibold flex items-center justify-center">
                        {formatUnread(unread)}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};
