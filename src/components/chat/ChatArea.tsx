import React, { useState, useEffect, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { Paperclip, Send, Hash, Plus } from 'lucide-react';
import axios from 'axios';
import { format } from 'date-fns';
import { useAuth } from '../../contexts/AuthContext';
import { Channel, Message } from '../../types';

export const ChatArea = ({ channel, socket }: { channel: Channel, socket: Socket }) => {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [content, setContent] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!channel) return;
    const fetch = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await axios.get(`/api/channels/${channel.id}/messages`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        setMessages(res.data);
        socket.emit('channel:join', channel.id);
      } catch (err) { console.error(err); }
    };
    fetch();

    const handleMsg = (msg: Message) => {
      if (msg.channelId === channel.id) {
        setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
      }
    };
    socket.on('message:received', handleMsg);
    return () => { socket.off('message:received', handleMsg); };
  }, [channel, socket]);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages]);

  const handleSend = (e: any) => {
    e.preventDefault();
    if (!content.trim()) return;
    socket.emit('message:send', { channelId: channel.id, content });
    setContent('');
  };

  if (!channel) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-gray-50 text-gray-400 p-12">
        <div className="w-24 h-24 bg-gray-100 rounded-full flex items-center justify-center mb-6">
          <Hash size={48} className="opacity-20" strokeWidth={1.5} />
        </div>
        <h2 className="text-2xl font-black text-gray-800 tracking-tight mb-2">Welcome to your workspace</h2>
        <p className="text-gray-500 font-medium max-w-sm text-center leading-relaxed">Select a channel from the sidebar to start collaborating with your team.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-white overflow-hidden h-full">
      <div className="h-16 border-b border-gray-100 flex items-center justify-between px-6 bg-white shrink-0 z-10">
        <div className="flex flex-col">
          <div className="flex items-center gap-2 font-black text-xl text-gray-900 tracking-tight">
            <span className="text-gray-300 font-bold">#</span>
            {channel.name}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-1 slack-scrollbar">
        {messages.map((m, idx) => {
          const isSameUserAsPrev = idx > 0 && messages[idx - 1].sender.username === m.sender.username;
          const timeDiff = idx > 0 ? (new Date(m.createdAt).getTime() - new Date(messages[idx - 1].createdAt).getTime()) : 0;
          const shouldCompact = isSameUserAsPrev && timeDiff < 300000; // 5 mins

          return (
            <div key={m.id} className={`group flex gap-4 px-4 hover:bg-gray-50 transition-colors ${shouldCompact ? 'py-0.5' : 'py-3 mt-4'}`}>
              {!shouldCompact ? (
                <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center font-black text-gray-600 shrink-0 text-lg shadow-sm border border-gray-200 uppercase">
                  {m.sender.username[0]}
                </div>
              ) : (
                <div className="w-10 shrink-0 flex items-center justify-end pr-2">
                  <span className="text-[10px] text-gray-400 font-bold opacity-0 group-hover:opacity-100 transition-opacity">
                    {format(new Date(m.createdAt), 'h:mm')}
                  </span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                {!shouldCompact && (
                  <div className="flex items-baseline gap-2 mb-0.5">
                    <span className="font-bold text-gray-900 hover:underline cursor-pointer">{m.sender.username}</span>
                    <span className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">{format(new Date(m.createdAt), 'h:mm a')}</span>
                  </div>
                )}
                <p className="text-gray-800 leading-relaxed break-words text-[15px]">{m.content}</p>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <div className="p-6 pt-2 shrink-0">
        <form onSubmit={handleSend} className="relative flex flex-col border-2 border-gray-200 rounded-xl focus-within:border-gray-400 transition-all bg-white shadow-sm overflow-hidden">
          <div className="flex-1 bg-gray-50/50 flex items-start">
             <textarea 
              rows={1}
              value={content} 
              onChange={e => {
                setContent(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${e.target.scrollHeight}px`;
              }} 
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(e); } }}
              placeholder={`Message #${channel.name}`} 
              className="flex-1 bg-transparent py-3 px-4 outline-none text-gray-800 resize-none min-h-[44px] max-h-[30vh] font-medium" 
            />
          </div>
          <div className="flex items-center justify-between p-2 bg-white border-t border-gray-100">
            <div className="flex gap-1">
               <button type="button" className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-all"><Plus size={18} /></button>
            </div>
            <button 
              disabled={!content.trim()} 
              className={`p-2 rounded transition-all ${content.trim() ? 'bg-slack-green text-white shadow-lg active:scale-95' : 'text-gray-300'}`}
            >
              <Send size={18} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
