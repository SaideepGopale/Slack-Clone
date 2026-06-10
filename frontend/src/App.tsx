import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Zap } from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ResetPassword } from './components/auth/ResetPassword';
import { useSocket } from './hooks/useSocket';
import { Sidebar } from './components/sidebar/Sidebar';
import { ChatArea } from './components/chat/ChatArea';
import { AuthForm } from './components/auth/AuthForm';
import { Header } from './components/layout/Header';
import { Directory } from './components/layout/Directory';
import { DMsView } from './components/layout/DMsView';
import { ActivityView } from './components/layout/ActivityView';
import { HomeView } from './components/layout/HomeView';
import { MoreView } from './components/layout/MoreView';
import { Channel, User } from './types';

type ActiveView = 'chat' | 'directory' | 'home' | 'dms' | 'activity' | 'more';

function MainChat() {
  const { user, token, loading } = useAuth();
  const socket = useSocket(token);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [currentChannel, setCurrentChannel] = useState<Channel | null>(null);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [onlineUsers, setOnlineUsers] = useState<User[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [activeView, setActiveView] = useState<ActiveView>('chat');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const fetchChannels = useCallback((onComplete?: (chans: Channel[]) => void) => {
    if (!token) return;
    axios.get<Channel[]>('/api/channels')
      .then(res => {
        setChannels(res.data);
        if (res.data.length > 0 && !currentChannel) {
          setCurrentChannel(res.data.find(c => !c.isDM) ?? res.data[0]);
        }
        onComplete?.(res.data);
      })
      .catch(err => console.error('fetchChannels error:', err));
  }, [token, currentChannel]);

  const onStartDM = async (userId: string) => {
    try {
      const res = await axios.post<Channel>('/api/channels/dm', { targetUserId: userId });
      fetchChannels((updatedChans) => {
        const found = updatedChans.find(c => c.id === res.data.id);
        setCurrentChannel(found ?? res.data);
        setActiveView('chat');
      });
    } catch (err) {
      console.error('Failed to start DM:', err);
    }
  };

  useEffect(() => {
    fetchChannels();
    if (token) {
      axios.get<User[]>('/api/users').then(res => setUsers(res.data));
    }
  }, [token]);

  useEffect(() => {
    if (socket) {
      socket.on('channel:created', (c: Channel) => setChannels(p => [...p, c]));
      socket.on('user:online', (u: User[]) => setOnlineUsers(u));

      const handleNewMessage = (msg: { senderId: string; channelId: string }) => {
        if (msg.senderId !== user?.id) {
          if (activeView !== 'chat' || (currentChannel && currentChannel.id !== msg.channelId)) {
            setUnreadCounts(prev => ({
              ...prev,
              [msg.channelId]: (prev[msg.channelId] || 0) + 1
            }));
          }
        }
      };

      socket.on('message:received', handleNewMessage);

      return () => {
        socket.off('channel:created');
        socket.off('user:online');
        socket.off('message:received', handleNewMessage);
      };
    }
  }, [socket, activeView, currentChannel, user]);

  // Clear unreads when switching to a channel
  useEffect(() => {
    if (activeView === 'chat' && currentChannel) {
      setUnreadCounts(prev => {
        if (prev[currentChannel.id]) {
          const next = { ...prev };
          delete next[currentChannel.id];
          return next;
        }
        return prev;
      });
    }
  }, [activeView, currentChannel]);

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

  // Check for reset-password path and render the reset page regardless of auth
  if (typeof window !== 'undefined' && window.location.pathname === '/reset-password') {
    return <ResetPassword />;
  }

  const renderContent = () => {
    switch (activeView) {
      case 'directory':
        return <Directory onChannelJoined={fetchChannels} onlineUsers={onlineUsers} onSelectUser={onStartDM} />;
      case 'activity':
        return (
          <ActivityView 
            onSelectChannel={(ch) => {
              setCurrentChannel(ch);
              setActiveView('chat');
            }}
            onViewChange={setActiveView}
          />
        );
      case 'dms':
        return (
          <DMsView 
            channels={channels} 
            onlineUsers={onlineUsers} 
            onSelectChannel={(ch) => {
              setCurrentChannel(ch);
              setActiveView('chat');
            }} 
            onViewChange={setActiveView}
          />
        );
      case 'chat':
        return currentChannel ? (
          <ChatArea channel={currentChannel} socket={socket} onlineUsers={onlineUsers} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 font-medium">Select a channel or teammate to start chatting</div>
        );
      case 'home':
        return (
          <HomeView 
            channels={channels} 
            onSelectChannel={(ch) => {
              setCurrentChannel(ch);
              setActiveView('chat');
            }}
            onViewChange={setActiveView}
          />
        );
      case 'more':
        return <MoreView onViewChange={setActiveView} />;
      default:
        return (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-10">
            <div className="w-20 h-20 bg-gray-50 rounded-[2rem] flex items-center justify-center text-gray-300 mb-6 shrink-0">
              <Zap size={40} />
            </div>
            <h2 className="text-2xl font-black text-gray-900 mb-2 capitalize tracking-tight">{activeView} view</h2>
            <p className="text-gray-500 max-w-sm font-medium">This view is currently being optimized for your workspace.</p>
            <button 
              onClick={() => setActiveView('chat')}
              className="mt-8 px-8 py-3 bg-slack-purple text-white font-black rounded-xl hover:bg-slack-purple-hover transition-all active:scale-95 shadow-xl shadow-purple-900/10"
            >
              Return Home
            </button>
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
            unreadCounts={unreadCounts}
            onSelectChannel={(ch: Channel) => {
              setCurrentChannel(ch);
              setActiveView('chat');
              setIsSidebarOpen(false);
            }} 
            onlineUsers={onlineUsers}
            allUsers={users}
            activeView={activeView}
            onStartDM={onStartDM}
            onViewChange={(view: ActiveView, newChannels?: Channel[]) => {
              setActiveView(view);
              if (newChannels) setChannels(newChannels);
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

