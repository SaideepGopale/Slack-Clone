import React from 'react';
import { motion } from 'motion/react';
import { Settings, Shield, Bell, Zap, HelpCircle, LogOut, ChevronRight, User, Globe, Lock } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

interface MoreViewProps {
  onViewChange: (view: any) => void;
}

export const MoreView = ({ onViewChange }: MoreViewProps) => {
  const { user, logout } = useAuth();

  const sections = [
    {
      title: 'Navigation',
      items: [
        { label: 'Activity', icon: Bell, action: () => onViewChange('activity') },
        { label: 'Direct Messages', icon: Zap, action: () => onViewChange('dms') },
        { label: 'Directory', icon: Globe, action: () => onViewChange('directory') },
      ]
    },
    {
      title: 'Workspace Settings',
      items: [
        { label: 'Preferences', icon: Settings, action: () => {} },
        { label: 'Privacy & Permissions', icon: Shield, action: () => {} },
        { label: 'Connections', icon: Lock, action: () => {} },
      ]
    },
    {
      title: 'Support',
      items: [
        { label: 'Help Center', icon: HelpCircle, action: () => {} },
      ]
    }
  ];

  return (
    <div className="flex-1 flex flex-col h-full bg-white overflow-y-auto slack-scrollbar selection:bg-slack-purple/10">
      <div className="max-w-3xl mx-auto w-full p-6 md:p-12">
        <div className="mb-10">
          <h1 className="text-3xl font-black text-gray-900 tracking-tight mb-2">More Options</h1>
          <p className="text-gray-500 font-medium italic">Everything else you might need in your workspace.</p>
        </div>

        <div className="space-y-10">
          {sections.map((section, idx) => (
            <div key={idx}>
              <h3 className="text-[11px] font-black text-gray-400 uppercase tracking-[0.2em] mb-4 pl-1">{section.title}</h3>
              <div className="space-y-1">
                {section.items.map((item, itemIdx) => (
                  <motion.button
                    key={itemIdx}
                    whileHover={{ x: 5, backgroundColor: 'rgba(249, 250, 251, 1)' }}
                    onClick={item.action}
                    className="w-full flex items-center justify-between p-4 rounded-xl transition-all group"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center text-gray-400 group-hover:text-slack-purple transition-colors">
                        <item.icon size={20} />
                      </div>
                      <span className="font-bold text-gray-900">{item.label}</span>
                    </div>
                    <ChevronRight size={18} className="text-gray-300 group-hover:text-gray-900 transition-colors" />
                  </motion.button>
                ))}
              </div>
            </div>
          ))}

          <div className="pt-6 border-t border-gray-100">
            <button 
              onClick={logout}
              className="w-full flex items-center gap-4 p-4 rounded-xl hover:bg-red-50 transition-all group text-red-500"
            >
              <div className="w-10 h-10 bg-red-50 rounded-xl flex items-center justify-center text-red-400 group-hover:text-red-500 transition-colors">
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
