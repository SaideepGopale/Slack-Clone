import React from 'react';
import { motion } from 'motion/react';
import { MessageSquare, Search, MoreHorizontal, UserPlus } from 'lucide-react';
import { Channel } from '../../types';

interface DMsViewProps {
  channels: Channel[];
  onlineUsers: any[];
  onSelectChannel: (channel: Channel) => void;
  onViewChange: (view: any) => void;
}

export const DMsView = ({ channels, onlineUsers, onSelectChannel, onViewChange }: DMsViewProps) => {
  const dmChannels = channels.filter(c => c.isDM);

  return (
    <div className="flex-1 flex flex-col h-full bg-white">
      <div className="h-16 border-b border-gray-100 flex items-center justify-between px-6 shrink-0 bg-white/80 backdrop-blur-md sticky top-0 z-10">
        <div>
          <h1 className="text-xl font-black text-gray-900 tracking-tight">Direct Messages</h1>
          <p className="text-[11px] text-gray-400 font-bold uppercase tracking-widest leading-none mt-1">Your recent conversations</p>
        </div>
        <div className="flex gap-2">
          <button className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 transition-colors">
            <Search size={20} />
          </button>
          <button className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 transition-colors">
            <UserPlus size={20} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 md:p-8">
        <div className="max-w-4xl mx-auto">
          {dmChannels.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-20 h-20 bg-gray-50 rounded-[2rem] flex items-center justify-center text-gray-300 mb-6">
                <MessageSquare size={40} />
              </div>
              <h3 className="text-xl font-black text-gray-900 mb-2">No messages yet</h3>
              <p className="text-gray-500 max-w-sm mb-8">Direct messages are for private conversations between you and other teammates.</p>
              <button 
                onClick={() => onViewChange('directory')}
                className="px-8 py-3 bg-[#4a154b] text-white font-black rounded-xl hover:bg-[#350d36] transition-all active:scale-95 shadow-xl shadow-purple-900/20"
              >
                Find Teammates
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {dmChannels.map((ch) => {
                const isOnline = onlineUsers.some(ou => ou.username === ch.name); // Simple check based on name (which we map to username)
                
                return (
                  <motion.div
                    key={ch.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    whileHover={{ scale: 1.005, backgroundColor: 'rgba(249, 250, 251, 1)' }}
                    onClick={() => onSelectChannel(ch)}
                    className="flex items-center gap-4 p-4 rounded-2xl border border-transparent hover:border-gray-100 cursor-pointer transition-all group"
                  >
                    <div className="relative shrink-0">
                      <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center text-xl font-black text-gray-500 border-2 border-white shadow-sm ring-1 ring-gray-100 group-hover:scale-105 transition-transform">
                        {ch.name?.[0]?.toUpperCase()}
                      </div>
                      <div className={`absolute -bottom-1 -right-1 w-5 h-5 bg-white rounded-full flex items-center justify-center shadow-md`}>
                        <div className={`w-3 h-3 rounded-full border-2 border-white ${isOnline ? 'bg-slack-green' : 'bg-gray-300'}`} />
                      </div>
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <h4 className="text-base font-black text-gray-900 truncate tracking-tight">{ch.name}</h4>
                        <span className="text-[11px] text-gray-400 font-bold uppercase tracking-widest group-hover:text-gray-900 transition-colors">Open Chat</span>
                      </div>
                      <p className="text-sm text-gray-500 truncate font-medium">Click to continue your conversation with {ch.name}.</p>
                    </div>

                    <button className="p-2 opacity-0 group-hover:opacity-100 hover:bg-gray-200 rounded-lg text-gray-400 transition-all">
                      <MoreHorizontal size={20} />
                    </button>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
