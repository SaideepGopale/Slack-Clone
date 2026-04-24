import { useEffect, useState } from 'react';
import axios from 'axios';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { useSocket } from './hooks/useSocket';
import { Sidebar } from './components/sidebar/Sidebar';
import { ChatArea } from './components/chat/ChatArea';
import { AuthForm } from './components/auth/AuthForm';
import { Channel } from './types';

function MainChat() {
  const { user, token } = useAuth();
  const socket = useSocket(token);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [currentChannel, setCurrentChannel] = useState<Channel | null>(null);
  const [onlineUsers, setOnlineUsers] = useState<any[]>([]);

  useEffect(() => {
    if (token) {
      axios.get('/api/channels', { headers: { Authorization: `Bearer ${token}` } })
        .then(res => {
          setChannels(res.data);
          if (res.data.length > 0) setCurrentChannel(res.data[0]);
        });
    }
  }, [token]);

  useEffect(() => {
    if (socket) {
      socket.on('channel:created', c => setChannels(p => [...p, c]));
      socket.on('user:online', u => setOnlineUsers(u));
      return () => {
        socket.off('channel:created');
        socket.off('user:online');
      };
    }
  }, [socket]);

  if (!user) return <AuthForm />;
  if (!socket) return <div className="h-screen flex items-center justify-center font-bold text-slate-400">Initialising real-time...</div>;

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar channels={channels} currentChannel={currentChannel} onSelectChannel={setCurrentChannel} onlineUsers={onlineUsers} />
      <ChatArea channel={currentChannel!} socket={socket} />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <MainChat />
    </AuthProvider>
  );
}
