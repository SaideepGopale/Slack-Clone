import React from 'react';
import { motion } from 'motion/react';
import { Shield, Zap, MessageSquare, Users, Star, ArrowRight } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { Channel } from '../../types';

interface HomeViewProps {
  channels: Channel[];
  onSelectChannel: (channel: Channel) => void;
  onViewChange: (view: any) => void;
}

export const HomeView = ({ channels, onSelectChannel, onViewChange }: HomeViewProps) => {
  const { user } = useAuth();
  const publicChannels = channels.filter(c => !c.isDM);
  const dmChannels = channels.filter(c => c.isDM);

  return (
    <div className="flex-1 flex flex-col h-full bg-white overflow-y-auto slack-scrollbar selection:bg-slack-purple/10">
      <div className="max-w-5xl mx-auto w-full p-6 md:p-12">
        {/* Welcome Header */}
        <div className="mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-slack-purple/5 text-slack-purple rounded-full text-[10px] font-black uppercase tracking-widest mb-4">
            <Zap size={12} className="fill-slack-purple" />
            <span>Workspace Productivity</span>
          </div>
          <h1 className="text-4xl md:text-5xl font-black text-gray-900 tracking-tight mb-4">
            Welcome back, <span className="text-slack-purple">{user?.username}</span>
          </h1>
          <p className="text-lg text-gray-500 font-medium max-w-2xl leading-relaxed">
            Everything you need to collaborate with your team is right here. Stay connected, stay productive.
          </p>
        </div>

        {/* Quick Stats/Actions */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          <motion.div 
            whileHover={{ y: -5 }}
            className="p-6 rounded-3xl bg-gray-50 border border-transparent hover:border-gray-200 transition-all flex flex-col gap-4"
          >
            <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-slack-purple shadow-sm ring-1 ring-gray-100">
              <MessageSquare size={24} />
            </div>
            <div>
              <h3 className="font-black text-gray-900 tracking-tight">Active Channels</h3>
              <p className="text-sm text-gray-500 font-medium">{publicChannels.length} collaboration spaces</p>
            </div>
            <button onClick={() => onViewChange('directory')} className="mt-2 text-xs font-black text-slack-purple uppercase tracking-widest flex items-center gap-2 hover:gap-3 transition-all">
              Join More <ArrowRight size={14} />
            </button>
          </motion.div>

          <motion.div 
            whileHover={{ y: -5 }}
            className="p-6 rounded-3xl bg-[#4a154b] text-white transition-all flex flex-col gap-4 shadow-xl shadow-purple-900/10"
          >
            <div className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center backdrop-blur-md border border-white/20">
              <Users size={24} />
            </div>
            <div>
              <h3 className="font-black tracking-tight">Direct Messages</h3>
              <p className="text-sm text-purple-100/70 font-medium">{dmChannels.length} private conversations</p>
            </div>
            <button onClick={() => onViewChange('dms')} className="mt-2 text-xs font-black text-white uppercase tracking-widest flex items-center gap-2 hover:gap-3 transition-all">
              View All <ArrowRight size={14} />
            </button>
          </motion.div>

          <motion.div 
            whileHover={{ y: -5 }}
            className="p-6 rounded-3xl bg-gray-50 border border-transparent hover:border-gray-200 transition-all flex flex-col gap-4"
          >
            <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-orange-500 shadow-sm ring-1 ring-gray-100">
              <Star size={24} />
            </div>
            <div>
              <h3 className="font-black text-gray-900 tracking-tight">Important</h3>
              <p className="text-sm text-gray-500 font-medium group-hover:text-gray-900">Check your latest activity</p>
            </div>
            <button onClick={() => onViewChange('activity')} className="mt-2 text-xs font-black text-gray-900 uppercase tracking-widest flex items-center gap-2 hover:gap-3 transition-all">
              Go to Activity <ArrowRight size={14} />
            </button>
          </motion.div>
        </div>

        {/* Featured Channels */}
        <div>
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-black text-gray-900 tracking-tight">Your Channels</h2>
            <button onClick={() => onViewChange('directory')} className="text-[11px] font-black text-gray-400 uppercase tracking-widest hover:text-gray-900 transition-colors">See all</button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {publicChannels.slice(0, 4).map(ch => (
              <div 
                key={ch.id}
                onClick={() => onSelectChannel(ch)}
                className="p-4 rounded-2xl border border-gray-100 hover:border-slack-purple/20 hover:shadow-lg transition-all cursor-pointer group flex items-center gap-4 bg-white"
              >
                <div className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center text-gray-400 group-hover:bg-slack-purple/10 group-hover:text-slack-purple transition-all">
                  <Shield size={20} />
                </div>
                <div>
                  <h4 className="font-black text-gray-900 tracking-tight truncate group-hover:text-slack-purple transition-colors">#{ch.name}</h4>
                  <p className="text-[11px] text-gray-400 font-bold uppercase tracking-widest">Public Space</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
