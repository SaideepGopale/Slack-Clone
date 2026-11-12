import React from 'react';
import { motion } from 'motion/react';
import { Settings, Bell, Zap, LogOut, ChevronRight, Globe, Building2, FolderKanban, ListChecks } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

interface MoreViewProps {
  onViewChange: (view: any) => void;
  /** T.39: phone-only content shown first (account, theme, workspace switch). */
  header?: React.ReactNode;
}

export const MoreView = ({ onViewChange, header }: MoreViewProps) => {
  const { user, logout } = useAuth();

  const sections = [
    {
      title: 'Navigation',
      items: [
        { label: 'Activity', icon: Bell, action: () => onViewChange('activity') },
        { label: 'Direct Messages', icon: Zap, action: () => onViewChange('dms') },
        { label: 'Directory', icon: Globe, action: () => onViewChange('directory') },
        { label: 'Projects', icon: FolderKanban, action: () => onViewChange('projects') },
        { label: 'My tasks', icon: ListChecks, action: () => onViewChange('tasks') },
      ]
    },
    {
      // F2: administration entry points (also in the workspace menu and rail).
      title: 'Administration',
      items: [
        { label: 'Workspace settings', icon: Settings, action: () => onViewChange('settings') },
        { label: 'Organizations', icon: Building2, action: () => onViewChange('organizations') },
      ]
    },
    // F1 removed the "Workspace Settings" (Preferences, Privacy & Permissions,
    // Connections) and "Support" (Help Center) items: they did nothing.
  ];

  return (
    <div className="flex-1 flex flex-col h-full bg-surface overflow-y-auto slack-scrollbar selection:bg-brand-soft">
      <div className="max-w-3xl mx-auto w-full p-6 md:p-12">
        {header}
        <div className="mb-10">
          <h1 className="text-3xl font-semibold text-fg tracking-tight mb-2">More Options</h1>
          <p className="text-fg-muted font-medium">Everything else you might need in your workspace.</p>
        </div>

        <div className="space-y-10">
          {sections.map((section, idx) => (
            <div key={idx}>
              <h3 className="text-[11px] font-semibold text-fg-subtle uppercase tracking-[0.2em] mb-4 pl-1">{section.title}</h3>
              <div className="space-y-1">
                {section.items.map((item, itemIdx) => (
                  <motion.button
                    key={itemIdx}
                    whileHover={{ x: 5 }}
                    onClick={item.action}
                    className="w-full flex items-center justify-between p-4 rounded-xl transition-all group hover:bg-surface-secondary"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 bg-surface-secondary rounded-xl flex items-center justify-center text-fg-subtle group-hover:text-brand transition-colors">
                        <item.icon size={20} />
                      </div>
                      <span className="font-bold text-fg">{item.label}</span>
                    </div>
                    <ChevronRight size={18} className="text-fg-subtle group-hover:text-fg transition-colors" />
                  </motion.button>
                ))}
              </div>
            </div>
          ))}

          <div className="pt-6 border-t border-line">
            <button 
              onClick={logout}
              className="w-full flex items-center gap-4 p-4 rounded-xl hover:bg-danger-soft transition-all group text-danger"
            >
              <div className="w-10 h-10 bg-danger-soft rounded-xl flex items-center justify-center text-danger transition-colors">
                <LogOut size={20} />
              </div>
              <span className="font-bold">Sign Out of Workspace</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
