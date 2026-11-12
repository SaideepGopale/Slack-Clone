import { ChevronsUpDown, Hash, Lock, PenSquare, Search, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from '../../components/ui';
import { Avatar } from '../../components/ui/Avatar';
import { useAuth } from '../../contexts/AuthContext';
import type { Channel } from '../../types';
import { useWorkspace } from './WorkspaceContext';
import { useWorkspaces } from './WorkspacesProvider';

/**
 * T.39 — the phone's chat list (the "Chats" tab): every channel and direct
 * message of the workspace with unread counts and presence, a local filter,
 * "New message" (the people search) and the workspace switcher. Opening a
 * conversation shows it full-screen with a back button. Same data and
 * permissions as the sidebar (the server's channel/DM lists).
 */
export const openNavigationDrawer = () => window.dispatchEvent(new Event('smartconnect:open-navigation'));
const openPalette = () => window.dispatchEvent(new Event('smartconnect:open-palette'));

const busy = (status?: string) => status === 'in_meeting' || status === 'busy';
const unreadText = (n: number) => (n > 99 ? '99+' : String(n));

export const ChatsPage = () => {
  const { workspaceId, channels, dms, unreadCounts, onlineUsers, channelsLoading, dmsLoading } = useWorkspace();
  const workspace = useWorkspaces().getWorkspace(workspaceId);
  const { user } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const visibleChannels = useMemo(() => channels.filter((c) => !c.isDM && !c.archivedAt && (!q || (c.name ?? '').toLowerCase().includes(q))), [channels, q]);
  const visibleDMs = useMemo(
    () => dms.filter((dm) => (dm.isGroupDM || (dm.otherUserId && dm.otherUserId !== user?.id)) && (!q || (dm.name ?? '').toLowerCase().includes(q))),
    [dms, q, user?.id]
  );
  const open = (c: Channel) => navigate(`/${workspaceId}/c/${c.id}`);
  const loading = (channelsLoading && channels.length === 0) || (dmsLoading && dms.length === 0);

  const row = (c: Channel, leading: React.ReactNode, sub?: string) => {
    const unread = unreadCounts[c.id] ?? 0;
    return (
      <li key={c.id}>
        <button
          type="button"
          onClick={() => open(c)}
          className="flex min-h-14 w-full select-none items-center gap-3 px-4 py-2 text-left transition-colors active:bg-surface-secondary"
          aria-label={`${c.isDM ? '' : '#'}${c.name}${unread > 0 ? `, ${unread} unread` : ''}${sub ? `, ${sub}` : ''}`}
        >
          {leading}
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-[15px] ${unread > 0 ? 'font-semibold text-fg' : 'font-medium text-fg'}`}>{c.name}</span>
            {sub && <span className="block truncate text-xs text-fg-subtle">{sub}</span>}
          </span>
          {unread > 0 && (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-danger px-1.5 text-[11px] font-bold tabular-nums text-white" aria-hidden="true">
              {unreadText(unread)}
            </span>
          )}
        </button>
      </li>
    );
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="shrink-0 border-b border-line px-4 pb-3 pt-3">
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={openNavigationDrawer} className="flex min-w-0 select-none items-center gap-1.5 rounded-lg py-1 text-left active:opacity-70" aria-label={`Switch workspace (current: ${workspace?.name ?? 'workspace'})`}>
            <span className="min-w-0">
              <span className="block text-2xl font-bold leading-tight tracking-tight text-fg">Chats</span>
              <span className="flex items-center gap-1 text-xs text-fg-muted">
                <span className="truncate">{workspace?.name ?? ' '}</span>
                <ChevronsUpDown size={12} aria-hidden="true" />
              </span>
            </span>
          </button>
          <button type="button" onClick={openPalette} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand shadow-sm active:scale-95" aria-label="New message">
            <PenSquare size={19} aria-hidden="true" />
          </button>
        </div>
        <label className="relative mt-3 block">
          <span className="sr-only">Filter conversations</span>
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter conversations"
            className="h-10 w-full rounded-xl border border-line bg-surface-secondary pl-9 pr-3 text-[15px] text-fg outline-none placeholder:text-fg-subtle focus:border-brand focus:ring-2 focus:ring-brand-muted"
          />
        </label>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {loading ? (
          <ul className="space-y-1 p-4" role="status" aria-label="Loading conversations">
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i} className="skeleton h-12 rounded-xl" aria-hidden="true" />
            ))}
          </ul>
        ) : visibleChannels.length === 0 && visibleDMs.length === 0 ? (
          <EmptyState icon={<Search size={24} />} title={q ? `No conversations match “${query.trim()}”` : 'No conversations yet'} description={q ? undefined : 'Start one with New message.'} />
        ) : (
          <>
            {visibleChannels.length > 0 && (
              <section aria-labelledby="chats-channels">
                <h2 id="chats-channels" className="px-4 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                  Channels
                </h2>
                <ul>
                  {visibleChannels.map((c) =>
                    row(
                      c,
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-tertiary text-fg-muted" aria-hidden="true">
                        {c.visibility === 'PRIVATE' ? <Lock size={17} /> : <Hash size={18} />}
                      </span>
                    )
                  )}
                </ul>
              </section>
            )}
            {visibleDMs.length > 0 && (
              <section aria-labelledby="chats-dms">
                <h2 id="chats-dms" className="px-4 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                  Direct messages
                </h2>
                <ul>
                  {visibleDMs.map((dm) => {
                    if (dm.isGroupDM) {
                      return row(
                        dm,
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-tertiary text-fg-muted" aria-hidden="true">
                          <Users size={18} />
                        </span>,
                        `${dm.participants?.length ?? 0} people`
                      );
                    }
                    const online = onlineUsers.find((u) => u.id === dm.otherUserId) as { status?: string } | undefined;
                    const presence = busy(online?.status) ? 'In a meeting' : online ? 'Online' : 'Offline';
                    return row(dm, <Avatar name={dm.name} size="lg" presence={online ? 'online' : 'offline'} />, presence);
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default ChatsPage;
