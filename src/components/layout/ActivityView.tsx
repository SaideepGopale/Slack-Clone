import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { motion } from 'motion/react';
import { Bell, Hash, MessageSquare, Clock } from 'lucide-react';
import { format } from 'date-fns';
import { Channel } from '../../types';

interface ActivityViewProps {
  onSelectChannel: (channel: Channel) => void;
  onViewChange: (view: any) => void;
}

export const ActivityView = ({ onSelectChannel, onViewChange }: ActivityViewProps) => {
  const [recentMessages, setRecentMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchActivity = async () => {
      try {
        const channelsRes = await axios.get('/api/channels');
        const channels = channelsRes.data;
        
        // Fetch last few messages from each channel
        const allMessagesRequests = channels.map((c: any) => 
          axios.get(`/api/channels/${c.id}/messages`).then(res => 
            res.data.map((m: any) => ({ ...m, channelName: c.name, channel: c }))
          )
        );
        
        const messagesArrays = await Promise.all(allMessagesRequests);
        const flattenMessages = messagesArrays.flat()
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 30);
          
        setRecentMessages(flattenMessages);
      } catch (err) {
        console.error('Failed to fetch activity:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchActivity();
  }, []);

  return (
    <div className="flex-1 flex flex-col h-full bg-white">
      <div className="h-16 border-b border-gray-100 flex items-center px-6 shrink-0 bg-white/80 backdrop-blur-md sticky top-0 z-10">
        <div>
          <h1 className="text-xl font-black text-gray-900 tracking-tight">Activity</h1>
          <p className="text-[11px] text-gray-400 font-bold uppercase tracking-widest leading-none mt-1">See what's new across your workspace</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 md:p-8">
        <div className="max-w-3xl mx-auto">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="w-10 h-10 border-4 border-gray-100 border-t-slack-purple rounded-full animate-spin mb-4" />
              <p className="text-gray-400 font-black text-xs uppercase tracking-widest">Loading Activity...</p>
            </div>
          ) : recentMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-20 h-20 bg-gray-50 rounded-[2rem] flex items-center justify-center text-gray-300 mb-6">
                <Bell size={40} />
              </div>
              <h3 className="text-xl font-black text-gray-900 mb-2">No activity yet</h3>
              <p className="text-gray-500 max-w-sm">When messages are sent in your channels, they'll show up here.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {recentMessages.map((msg, idx) => (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.03 }}
                  onClick={() => {
                    onViewChange('chat');
                    onSelectChannel(msg.channel);
                  }}
                  className="flex gap-4 p-4 rounded-2xl border border-gray-100 hover:border-slack-purple/20 hover:shadow-lg hover:shadow-purple-900/5 cursor-pointer transition-all bg-white group"
                >
                  <div className="shrink-0 mt-1">
                    <div className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center text-gray-400 group-hover:bg-slack-purple/10 group-hover:text-slack-purple transition-colors">
                      {msg.channel.isDM ? <MessageSquare size={20} /> : <Hash size={20} />}
                    </div>
                  </div>
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-black text-gray-900 text-[14px] truncate">{msg.sender.username}</span>
                      <span className="text-[11px] text-gray-400 font-bold uppercase tracking-tighter">in</span>
                      <span className="text-[11px] font-black text-slack-purple bg-slack-purple/5 px-2 py-0.5 rounded uppercase tracking-widest">{msg.channelName}</span>
                      <span className="text-[10px] text-gray-400 ml-auto font-medium">{format(new Date(msg.createdAt), 'HH:mm')}</span>
                    </div>
                    <p className="text-sm text-gray-600 line-clamp-2 font-medium leading-relaxed">
                      {msg.content || (msg.fileUrl ? 'Sent a file' : 'Sent a message')}
                    </p>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
