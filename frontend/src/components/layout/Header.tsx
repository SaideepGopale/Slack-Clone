import React from 'react';
import { Search, Bell, User, HelpCircle, Settings, Clock, Menu } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

export const Header = ({ onMenuClick }: { onMenuClick?: () => void }) => {
  const { user } = useAuth();
  return (
    <header className="h-10 bg-[#350d36] flex items-center justify-between px-4 shrink-0 z-[100]">
      <div className="flex-1 flex items-center gap-2">
        <button 
          onClick={onMenuClick}
          className="md:hidden p-1 hover:bg-white/10 rounded text-gray-300 hover:text-white transition-colors"
        >
          <Menu size={18} />
        </button>
        <div className="hidden md:flex flex-1 justify-end pr-4">
          <button className="text-gray-300 hover:text-white transition-colors">
            <Clock size={16} />
          </button>
        </div>
      </div>
      
      <div className="w-full max-w-2xl px-2 md:px-4 relative group">
        <div className="absolute left-5 md:left-7 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-white pointer-events-none transition-colors">
          <Search size={14} />
        </div>
        <input 
          type="text" 
          placeholder="Search Workspace" 
          className="w-full bg-[#5d3d5e] border border-transparent focus:border-[#a094a1] rounded-md py-1 pl-8 md:pl-10 pr-2 md:pr-4 text-xs text-white placeholder-gray-300 outline-none transition-all placeholder:font-medium"
        />
      </div>

      <div className="flex-1 flex justify-end items-center gap-3">
        <button className="hidden sm:block text-gray-300 hover:text-white transition-colors">
          <HelpCircle size={16} />
        </button>
        <div className="w-6 h-6 rounded bg-[#e8912d] border border-white/20 flex items-center justify-center text-[10px] font-bold text-white cursor-pointer hover:border-white transition-colors shrink-0">
          {user?.username?.substring(0, 2).toUpperCase() || '??'}
        </div>
      </div>
    </header>
  );
};
