import { useEffect, useState } from 'react';
import axios from 'axios';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { useSocket } from './hooks/useSocket';
import { Sidebar } from './components/sidebar/Sidebar';
import { ChatArea } from './components/chat/ChatArea';
import { AuthForm } from './components/auth/AuthForm';
import { Header } from './components/layout/Header';
import { Directory } from './components/layout/Directory';
import { Channel } from './types';

function MainChat() {
  const { user, token, loading } = useAuth();
  const socket = useSocket(token);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [currentChannel, setCurrentChannel] = useState<Channel | null>(null);
  const [onlineUsers, setOnlineUsers] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [activeView, setActiveView] = useState<'chat' | 'directory' | 'home' | 'dms' | 'activity' | 'more'>('chat');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const fetchChannels = () => {
    if (token) {
      axios.get('/api/channels')
        .then(res => {
          setChannels(res.data);
          if (res.data.length > 0 && !currentChannel) setCurrentChannel(res.data[0]);
        });
    }
  };

  useEffect(() => {
    fetchChannels();
    if (token) {
      axios.get('/api/users')
        .then(res => {
          setUsers(res.data);
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

  if (loading) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-white">
        <div className="w-12 h-12 bg-slack-purple rounded-xl flex items-center justify-center text-white font-black text-2xl shadow-lg mb-4 animate-pulse">S</div>
        <p className="text-gray-400 font-bold text-sm tracking-widest uppercase">Loading Slick...</p>
      </div>
    );
  }

  if (!user) return <AuthForm />;
  if (!socket) return <div className="h-screen flex items-center justify-center font-bold text-slate-400">Initialising real-time...</div>;

  const renderContent = () => {
    switch (activeView) {
      case 'directory':
        return <Directory onChannelJoined={fetchChannels} />;
      case 'chat':
        return currentChannel ? (
          <ChatArea channel={currentChannel} socket={socket} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 font-medium">Select a channel to start chatting</div>
        );
      default:
        return (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-10">
            <h2 className="text-2xl font-black text-gray-900 mb-2 capitalize tracking-tight">{activeView} view</h2>
            <p className="text-gray-500 max-w-sm">This section is currently under development to match the full Slick experience.</p>
          </div>
        );
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#3f0e40]">
      <Header onMenuClick={() => setIsSidebarOpen(!isSidebarOpen)} />
      <div className="flex flex-1 overflow-hidden relative">
        {/* Mobile Backdrop */}
        {isSidebarOpen && (
          <div 
            className="fixed inset-0 bg-black/50 z-40 md:hidden backdrop-blur-sm"
            onClick={() => setIsSidebarOpen(false)}
          />
        )}
        
        {/* Sidebar container with mobile sliding logic */}
        <div className={`
          fixed md:relative inset-y-0 left-0 z-50 md:z-0
          transition-transform duration-300 ease-in-out transform
          ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
          w-[280px] md:w-[300px] bg-[#3f0e40]
        `}>
          <Sidebar 
            channels={channels} 
            currentChannel={currentChannel} 
            onSelectChannel={(ch: any) => {
              setCurrentChannel(ch);
              setIsSidebarOpen(false);
            }} 
            onlineUsers={onlineUsers}
            allUsers={users}
            activeView={activeView}
            onViewChange={(view: any) => {
              setActiveView(view);
              setIsSidebarOpen(false);
            }}
          />
        </div>

        <main className="flex-1 flex flex-col overflow-hidden bg-white md:rounded-tl-xl shadow-2xl relative z-10">
          {renderContent()}
        </main>
      </div>
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

