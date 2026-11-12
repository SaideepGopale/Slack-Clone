import { Activity, ArrowRight, Hash, Lock, MessageSquare, Users } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { Channel } from '../../types';

interface HomeViewProps {
  channels: Channel[];
  dms: Channel[];
  onSelectChannel: (channel: Channel) => void;
  onViewChange: (view: any) => void;
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

/**
 * Workspace home (T.32 redesign): a greeting, three real entry points (all
 * counts come from the workspace's actual channel and conversation lists) and
 * the channels you belong to. Every card and row is a real button.
 */
export const HomeView = ({ channels, dms, onSelectChannel, onViewChange }: HomeViewProps) => {
  const { user } = useAuth();
  const myChannels = channels.filter((c) => !c.isDM);

  const cards = [
    {
      id: 'directory',
      icon: Hash,
      title: 'Channels',
      body: `${myChannels.length} ${myChannels.length === 1 ? 'channel' : 'channels'} you're in`,
      action: 'Browse channels',
    },
    {
      id: 'dms',
      icon: MessageSquare,
      title: 'Direct messages',
      body: `${dms.length} ${dms.length === 1 ? 'conversation' : 'conversations'}`,
      action: 'Open messages',
    },
    {
      id: 'activity',
      icon: Activity,
      title: 'Activity',
      body: 'Mentions, replies and reactions',
      action: 'See activity',
    },
  ] as const;

  return (
    <div className="flex h-full flex-1 flex-col overflow-y-auto bg-surface app-scrollbar">
      <div className="mx-auto w-full max-w-4xl px-5 py-8 md:px-10 md:py-12">
        <header className="mb-8 animate-fade-in">
          <p className="text-sm text-fg-subtle">{greeting()}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-fg md:text-[28px]">
            Welcome back, {user?.username}
          </h1>
        </header>

        <div className="mb-10 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {cards.map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={() => onViewChange(card.id)}
              className="group flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 text-left transition-colors hover:border-border-strong hover:bg-surface-secondary"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand" aria-hidden="true">
                <card.icon size={17} />
              </span>
              <span>
                <span className="block text-sm font-semibold text-fg">{card.title}</span>
                <span className="mt-0.5 block text-xs text-fg-subtle tabular-nums">{card.body}</span>
              </span>
              <span className="mt-auto flex items-center gap-1 text-xs font-medium text-brand">
                {card.action} <ArrowRight size={12} className="transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>

        <section aria-labelledby="home-channels">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="home-channels" className="text-sm font-semibold text-fg">Your channels</h2>
            <button type="button" onClick={() => onViewChange('directory')} className="text-xs font-medium text-fg-subtle transition-colors hover:text-fg">
              See all
            </button>
          </div>
          {myChannels.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
              <Users size={18} className="mx-auto mb-2 text-fg-subtle" aria-hidden="true" />
              <p className="text-sm text-fg-muted">You're not in any channels yet.</p>
              <button type="button" onClick={() => onViewChange('directory')} className="mt-2 text-sm font-medium text-brand hover:text-brand-hover">
                Browse channels
              </button>
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {myChannels.slice(0, 8).map((ch) => (
                <li key={ch.id}>
                  <button
                    type="button"
                    onClick={() => onSelectChannel(ch)}
                    className="group flex w-full items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-border-strong hover:bg-surface-secondary"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-tertiary text-fg-muted" aria-hidden="true">
                      {ch.icon && ch.icon !== 'hash' ? <span className="text-base leading-none">{ch.icon}</span> : ch.visibility === 'PRIVATE' ? <Lock size={14} /> : <Hash size={15} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-fg">{ch.name}</span>
                      <span className="block truncate text-xs text-fg-subtle">{ch.visibility === 'PRIVATE' ? 'Private channel' : ch.description || 'Public channel'}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};
