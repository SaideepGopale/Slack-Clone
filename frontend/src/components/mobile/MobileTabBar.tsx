import { Bell, ListChecks, Menu, MessagesSquare, Phone } from 'lucide-react';

/**
 * T.39 — the phone tab bar (below 768px only; tablets and desktop use the
 * sidebar). It is part of the app shell's column — not floating — so it can
 * never cover page content, and it is hidden inside a conversation, where the
 * composer owns the bottom edge. Respects the home-indicator safe area.
 */
export type MobileTab = 'chats' | 'activity' | 'tasks' | 'calls' | 'more';

const TABS: { id: MobileTab; label: string; icon: typeof Bell; view: string }[] = [
  { id: 'chats', label: 'Chats', icon: MessagesSquare, view: 'chats' },
  { id: 'activity', label: 'Activity', icon: Bell, view: 'activity' },
  { id: 'tasks', label: 'Tasks', icon: ListChecks, view: 'tasks' },
  { id: 'calls', label: 'Calls', icon: Phone, view: 'calls' },
  { id: 'more', label: 'More', icon: Menu, view: 'more' },
];

/** Which tab a screen belongs to (activeView as computed by WorkspaceLayout). */
export const tabForView = (view: string): MobileTab | null => {
  if (view === 'chats' || view === 'chat' || view === 'dms' || view === 'home') return 'chats';
  if (view === 'activity') return 'activity';
  if (view === 'tasks' || view === 'team-tasks' || view === 'projects') return 'tasks';
  if (view === 'calls') return 'calls';
  if (view === 'more' || view === 'directory' || view === 'other') return 'more';
  return null;
};

const badgeText = (n: number) => (n > 99 ? '99+' : String(n));

export const MobileTabBar = ({
  activeView,
  chatsUnread,
  activityUnread,
  onNavigate,
}: {
  activeView: string;
  chatsUnread: number;
  activityUnread: number;
  onNavigate: (view: string) => void;
}) => {
  const active = tabForView(activeView);
  const badges: Partial<Record<MobileTab, number>> = { chats: chatsUnread, activity: activityUnread };
  return (
    <nav aria-label="Main" className="shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
      <ul className="grid grid-cols-5">
        {TABS.map((tab) => {
          const isActive = active === tab.id;
          const badge = badges[tab.id] ?? 0;
          return (
            <li key={tab.id}>
              <button
                type="button"
                onClick={() => onNavigate(tab.view)}
                aria-current={isActive ? 'page' : undefined}
                aria-label={badge > 0 ? `${tab.label}, ${badge} unread` : tab.label}
                className={`relative flex min-h-[54px] w-full select-none flex-col items-center justify-center gap-0.5 text-[10.5px] font-semibold tracking-wide transition-colors [-webkit-tap-highlight-color:transparent] active:bg-surface-secondary ${
                  isActive ? 'text-brand' : 'text-fg-muted'
                }`}
              >
                <span className="relative">
                  <tab.icon size={22} strokeWidth={isActive ? 2.25 : 1.75} aria-hidden="true" />
                  {badge > 0 && (
                    <span className="absolute -right-2.5 -top-1.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold tabular-nums text-white ring-2 ring-surface" aria-hidden="true">
                      {badgeText(badge)}
                    </span>
                  )}
                </span>
                <span>{tab.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
};
