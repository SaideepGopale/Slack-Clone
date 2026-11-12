import { Hash, Lock, Phone, Search, Users, Video } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmptyState } from '../../components/ui';
import { Avatar } from '../../components/ui/Avatar';
import { useAuth } from '../../contexts/AuthContext';
import type { Channel } from '../../types';
import { useWorkspace } from './WorkspaceContext';

/**
 * T.39 — the "Calls" tab: start an audio or video call with a person, a
 * group or a channel. It uses the existing call flow (WorkspaceLayout
 * startCall → the pre-join lobby with camera/microphone check → the call),
 * so every server rule about who may be called still applies. There is no
 * call history in SmartConnect yet; this screen does not pretend otherwise.
 */
export const CallsPage = () => {
  const { channels, dms, onlineUsers, startCall } = useWorkspace();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const people = useMemo(
    () => dms.filter((dm) => (dm.isGroupDM || (dm.otherUserId && dm.otherUserId !== user?.id)) && (!q || (dm.name ?? '').toLowerCase().includes(q))),
    [dms, q, user?.id]
  );
  const rooms = useMemo(() => channels.filter((c) => !c.isDM && !c.archivedAt && (!q || (c.name ?? '').toLowerCase().includes(q))), [channels, q]);

  const row = (c: Channel, leading: React.ReactNode, label: string, sub?: string) => (
    <li key={c.id} className="flex min-h-16 items-center gap-3 px-4 py-2">
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium text-fg">{label}</span>
        {sub && <span className="block truncate text-xs text-fg-subtle">{sub}</span>}
      </span>
      <button type="button" onClick={() => startCall(c.id, 'audio')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-tertiary text-fg active:scale-95" aria-label={`Audio call ${label}`}>
        <Phone size={18} aria-hidden="true" />
      </button>
      <button type="button" onClick={() => startCall(c.id, 'video')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand active:scale-95" aria-label={`Video call ${label}`}>
        <Video size={18} aria-hidden="true" />
      </button>
    </li>
  );

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="shrink-0 border-b border-line px-4 pb-3 pt-3">
        <h1 className="text-2xl font-bold tracking-tight text-fg">Calls</h1>
        <p className="mt-0.5 text-xs text-fg-muted">Start an audio or video call. You’ll check your camera and microphone before joining.</p>
        <label className="relative mt-3 block">
          <span className="sr-only">Find a person or channel</span>
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a person or channel"
            className="h-10 w-full rounded-xl border border-line bg-surface-secondary pl-9 pr-3 text-[15px] text-fg outline-none placeholder:text-fg-subtle focus:border-brand focus:ring-2 focus:ring-brand-muted"
          />
        </label>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {people.length === 0 && rooms.length === 0 ? (
          <EmptyState icon={<Phone size={24} />} title={q ? `Nothing matches “${query.trim()}”` : 'No one to call yet'} description={q ? undefined : 'Start a direct message with someone first, then call them from here.'} />
        ) : (
          <>
            {people.length > 0 && (
              <section aria-labelledby="calls-people">
                <h2 id="calls-people" className="px-4 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                  People
                </h2>
                <ul className="divide-y divide-line">
                  {people.map((dm) =>
                    dm.isGroupDM
                      ? row(dm, <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-tertiary text-fg-muted" aria-hidden="true"><Users size={18} /></span>, dm.name, `${dm.participants?.length ?? 0} people`)
                      : row(dm, <Avatar name={dm.name} size="lg" presence={onlineUsers.some((u) => u.id === dm.otherUserId) ? 'online' : 'offline'} />, dm.name, onlineUsers.some((u) => u.id === dm.otherUserId) ? 'Online' : 'Offline')
                  )}
                </ul>
              </section>
            )}
            {rooms.length > 0 && (
              <section aria-labelledby="calls-channels">
                <h2 id="calls-channels" className="px-4 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                  Channels
                </h2>
                <ul className="divide-y divide-line">
                  {rooms.map((c) =>
                    row(
                      c,
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-tertiary text-fg-muted" aria-hidden="true">
                        {c.visibility === 'PRIVATE' ? <Lock size={17} /> : <Hash size={18} />}
                      </span>,
                      `#${c.name}`,
                      'Everyone in the channel is invited'
                    )
                  )}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default CallsPage;
