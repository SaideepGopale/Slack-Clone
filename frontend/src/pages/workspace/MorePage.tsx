import { ArrowLeftRight, ClipboardList, LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MoreView } from '../../components/layout/MoreView';
import { Avatar } from '../../components/ui/Avatar';
import { useAuth } from '../../contexts/AuthContext';
import { getThemePreference, setThemePreference, ThemePreference } from '../../lib/theme';
import { openNavigationDrawer } from './ChatsPage';
import { useWorkspace } from './WorkspaceContext';
import { useWorkspaces } from './WorkspacesProvider';

const THEMES: { id: ThemePreference; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
];

/**
 * T.39 — the phone's "More" tab: who is signed in, appearance, switching
 * workspace and (for leads) Team Tasks — then the existing More options.
 * Phones only (md:hidden); tablets and desktop are unchanged.
 */
const PhoneAccountPanel = ({ onNavigate }: { onNavigate: (view: string) => void }) => {
  const { user, logout } = useAuth();
  const { workspaceId } = useWorkspace();
  const workspace = useWorkspaces().getWorkspace(workspaceId);
  const [theme, setTheme] = useState<ThemePreference>(() => getThemePreference());
  const leads = !!workspace && !workspace.isDefault && !!workspace.capabilities?.canManage;
  const row = 'flex min-h-12 w-full select-none items-center gap-3 px-4 text-left text-[15px] text-fg active:bg-surface-tertiary';
  return (
    <div className="-mx-2 mb-8 space-y-4 md:hidden">
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface-secondary p-4">
        <Avatar name={user?.username ?? '?'} size="lg" presence="online" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-fg">{user?.username}</p>
          <p className="truncate text-sm text-fg-muted">{user?.email}</p>
        </div>
      </div>
      <section aria-labelledby="more-appearance" className="rounded-2xl border border-line p-3">
        <h2 id="more-appearance" className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
          Appearance
        </h2>
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-1 rounded-xl bg-surface-secondary p-1">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={theme === t.id}
              onClick={() => {
                setThemePreference(t.id);
                setTheme(t.id);
              }}
              className={`flex min-h-10 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-colors ${theme === t.id ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted'}`}
            >
              <t.icon size={15} aria-hidden="true" /> {t.label}
            </button>
          ))}
        </div>
      </section>
      <div className="overflow-hidden rounded-2xl border border-line">
        <button type="button" className={row} onClick={openNavigationDrawer}>
          <ArrowLeftRight size={19} className="shrink-0" aria-hidden="true" />
          <span className="shrink-0 whitespace-nowrap">Switch workspace</span>
          <span className="ml-auto min-w-0 truncate text-sm text-fg-subtle">{workspace?.name}</span>
        </button>
        {leads && (
          <button type="button" className={`${row} border-t border-line`} onClick={() => onNavigate('team-tasks')}>
            <ClipboardList size={19} aria-hidden="true" /> Team tasks
          </button>
        )}
        <button type="button" className={`${row} border-t border-line text-danger`} onClick={logout}>
          <LogOut size={19} aria-hidden="true" /> Sign out
        </button>
      </div>
    </div>
  );
};

export const MorePage = () => {
  const { workspaceId } = useWorkspace();
  const navigate = useNavigate();
  const go = (view: string) => navigate(`/${workspaceId}/${view}`);
  return <MoreView onViewChange={go} header={<PhoneAccountPanel onNavigate={go} />} />;
};
