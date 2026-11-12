import { Building2, ClipboardList, Hash, HardDrive, LayoutDashboard, LogOut, MessageSquareOff, ShieldAlert, UserCog, Users } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { BrandMark } from '../ui/Brand';
import { AdminDashboard } from './AdminDashboard';
import { AuditLogViewer } from './AuditLogViewer';
import { ChannelManagement } from './ChannelManagement';
import { CompanyOverview } from './CompanyOverview'; // 👇 Naya import add ho gaya
import { FileStorageManagement } from './FileStorageManagement';
import { MessageModeration } from './MessageModeration';
import { TeamManagement } from './TeamManagement';
import { UserManagement } from './UserManagement';

type AdminTab = 'dashboard' | 'users' | 'team' | 'company' | 'channels' | 'audit' | 'moderation' | 'files';

export const AdminLayout = () => {
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard');
  const { logout } = useAuth();

  // 👇 YE RAHA TERA renderContent FUNCTION 👇
  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return <AdminDashboard />;
      case 'users':
        return <UserManagement />;
      case 'team':
        return <TeamManagement />; // Stage 2: Company Admin → Team Lead provisioning
      case 'company':
        return <CompanyOverview />; // Stage 4: read-only company workspace overview
      case 'channels':
        return <ChannelManagement />; // 👇 Ab ye naya component call karega
      case 'audit':
        return <AuditLogViewer />;
      case 'moderation':
        return <MessageModeration />;
      case 'files':
        return <FileStorageManagement />;
      default:
        return <AdminDashboard />;
    }
  };

  // T.32: data-driven navigation (one style, aria-current), the brand, and a
  // phone layout. "Exit Admin" was removed — administrator accounts always
  // land in this console (routes/ProtectedRoute.tsx), so it only reloaded it;
  // the decorative "System Active" badge was not backed by any health check.
  const groups: { label: string; items: { id: AdminTab; label: string; icon: typeof Users }[] }[] = [
    {
      label: 'Overview',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { id: 'users', label: 'User Management', icon: Users },
        { id: 'team', label: 'Team Management', icon: UserCog },
      ],
    },
    {
      label: 'Company',
      items: [
        { id: 'company', label: 'Workspace Overview', icon: Building2 },
        { id: 'channels', label: 'Channel Management', icon: Hash },
      ],
    },
    {
      label: 'Security & compliance',
      items: [
        { id: 'audit', label: 'Audit Logs', icon: ClipboardList },
        { id: 'moderation', label: 'Content Moderation', icon: MessageSquareOff },
        { id: 'files', label: 'File Storage', icon: HardDrive },
      ],
    },
  ];
  const allItems = groups.flatMap((g) => g.items);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-surface-secondary font-sans text-fg md:flex-row">
      {/* Sidebar (desktop) */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface md:flex" aria-label="Administration">
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-4">
          <BrandMark size={26} />
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight tracking-[-0.01em]">SmartConnect</p>
            <p className="flex items-center gap-1 text-[11px] leading-tight text-fg-subtle">
              <ShieldAlert size={11} aria-hidden="true" /> Company administration
            </p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto app-scrollbar px-2 py-3">
          {groups.map((group) => (
            <div key={group.label} className="mb-4">
              <p className="px-2.5 pb-1 text-[11px] font-medium text-fg-subtle">{group.label}</p>
              {group.items.map((item) => {
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveTab(item.id)}
                    aria-current={active ? 'page' : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
                      active ? 'bg-brand-soft font-medium text-brand' : 'text-fg-muted hover:bg-surface-tertiary hover:text-fg'
                    }`}
                  >
                    <item.icon size={16} aria-hidden="true" /> {item.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-line p-2">
          <button
            type="button"
            onClick={logout}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-danger transition-colors hover:bg-danger-soft"
          >
            <LogOut size={16} aria-hidden="true" /> Sign out
          </button>
        </div>
      </aside>

      {/* Top bar (phones and small tablets) */}
      <div className="shrink-0 border-b border-line bg-surface md:hidden">
        <div className="flex h-12 items-center justify-between px-3">
          <span className="flex items-center gap-2">
            <BrandMark size={22} />
            <span className="text-sm font-semibold">Administration</span>
          </span>
          <button type="button" onClick={logout} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-danger hover:bg-danger-soft">
            <LogOut size={14} aria-hidden="true" /> Sign out
          </button>
        </div>
        <nav aria-label="Administration" className="no-scrollbar flex gap-1 overflow-x-auto px-2 pb-2">
          {allItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              aria-current={activeTab === item.id ? 'page' : undefined}
              className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${activeTab === item.id ? 'bg-brand-soft font-medium text-brand' : 'text-fg-muted hover:bg-surface-tertiary'}`}
            >
              <item.icon size={13} aria-hidden="true" /> {item.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div key={activeTab} className="relative flex-1 overflow-y-auto app-scrollbar animate-fade-in">
          {renderContent()}
        </div>
      </main>
    </div>
  );
};