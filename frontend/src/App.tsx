import axios from 'axios';
import { Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AdminLayout } from './components/admin/AdminLayout';
import { AuthForm } from './components/auth/AuthForm';
import { ResetPassword } from './components/auth/ResetPassword';
import { CallOverlay, IncomingCallBanner } from './components/chat/CallOverlay'; // 👇 Naya import
import { ChatArea } from './components/chat/ChatArea';
import { ActivityView } from './components/layout/ActivityView';
import { Directory } from './components/layout/Directory';
import { DMsView } from './components/layout/DMsView';
import { Header } from './components/layout/Header';
import { HomeView } from './components/layout/HomeView';
import { MoreView } from './components/layout/MoreView';
import { Sidebar } from './components/sidebar/Sidebar';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { useSocket } from './hooks/useSocket';
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
  const [incomingCall, setIncomingCall] = useState<{ channelId: string, callerName: string, callType: 'audio' | 'video' } | null>(null);
  const [activeCall, setActiveCall] = useState<{ channelId: string, callType: 'audio' | 'video' } | null>(null);

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

  // 👇 YAHAN HAI TERA NAYA useEffect JO CALLS SUNTA HAI 👇
  useEffect(() => {
    if (socket) {
      socket.on('channel:created', (c: Channel) => setChannels(p => [...p, c]));
      socket.on('user:online', (u: User[]) => setOnlineUsers(u));

      // Incoming call sune ke liye
      socket.on('call:incoming', (data: { channelId: string, callerName: string, callType: 'audio' | 'video' }) => {
        // Agar main pehle se kisi call mein nahi hu, toh ringing banner dikhao
        if (!activeCall) {
          setIncomingCall(data);
        }
      });

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
        socket.off('call:incoming'); // Cleanup
        socket.off('message:received', handleNewMessage);
      };
    }
  }, [socket, activeView, currentChannel, user, activeCall]);

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
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-gradient-to-br from-white via-gray-50 to-blue-50 dark:from-[#111215] dark:via-[#1A1D21] dark:to-[#0f1419] transition-colors">
        <div className="relative">
          <div className="w-20 h-20 bg-gradient-to-br from-blue-600 to-purple-600 rounded-2xl flex items-center justify-center text-white font-black text-3xl shadow-2xl mb-6 animate-pulse">
            S
          </div>
          <div className="absolute -inset-2 bg-gradient-to-r from-blue-600 to-purple-600 rounded-2xl blur-xl opacity-30 animate-pulse"></div>
        </div>
        <div className="flex flex-col items-center gap-3">
          <p className="text-gray-600 dark:text-gray-400 font-bold text-base tracking-wide">Loading Workspace...</p>
          <div className="flex gap-1.5">
            <div className="w-2 h-2 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
            <div className="w-2 h-2 bg-purple-600 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
            <div className="w-2 h-2 bg-pink-600 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
          </div>
        </div>
      </div>
    );
  }

  // FIX: Is check ko humne Auth check ke upar kar diya hai taaki logged-out bande ko bhi ye page dikhe
  if (typeof window !== 'undefined' && window.location.pathname === '/reset-password') {
    return <ResetPassword />;
  }
  
  if (!user) return <AuthForm />;
  
  // 👇 MASTER ADMIN ROUTE LOGIC 👇 SlickAdmin2026
  if (user.email === 'admin@slack.com') {
    return <AdminLayout />;
  }

  if (!socket) return <div className="h-screen flex items-center justify-center font-bold text-slate-400 dark:bg-[#111215] transition-colors">Initialising real-time...</div>;
  
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
          <ChatArea 
            channel={currentChannel} 
            socket={socket} 
            onlineUsers={onlineUsers} 
            // 👇 NAYA: ChatArea se call initiate karne ke liye prop pass kiya
            onStartCall={(type: 'audio' | 'video') => {
              setActiveCall({ channelId: currentChannel.id, callType: type });
              socket?.emit('call:initiate', { channelId: currentChannel.id, callerName: user?.username || 'User', callType: type });
            }}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500 font-medium bg-white dark:bg-[#111215] transition-colors">
            Select a channel or teammate to start chatting
          </div>
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
          <div className="flex-1 flex flex-col items-center justify-center text-center p-10 bg-white dark:bg-[#111215] transition-colors">
            <div className="w-20 h-20 bg-gray-50 dark:bg-white/5 rounded-[2rem] flex items-center justify-center text-gray-300 dark:text-gray-600 mb-6 shrink-0">
              <Zap size={40} />
            </div>
            <h2 className="text-2xl font-black text-gray-900 dark:text-white mb-2 capitalize tracking-tight">{activeView} view</h2>
            <p className="text-gray-500 dark:text-gray-400 max-w-sm font-medium">This view is currently being optimized for your workspace.</p>
            <button 
              onClick={() => setActiveView('chat')}
              className="mt-8 px-8 py-3 bg-blue-600 text-white font-black rounded-xl hover:bg-blue-700 transition-all active:scale-95 shadow-xl shadow-blue-900/20"
            >
              Return Home
            </button>
          </div>
        );
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-gradient-to-br from-gray-50 via-white to-gray-100 dark:bg-[#1A1D21] transition-all duration-300 text-gray-900 dark:text-gray-100 font-sans">
      
      {/* 👇 NAYA: OVERLAYS (Incoming Call aur Active Call) 👇 */}
      {incomingCall && (
        <IncomingCallBanner
          callerName={incomingCall.callerName}
          callType={incomingCall.callType}
          onAccept={() => {
            setActiveCall({ channelId: incomingCall.channelId, callType: incomingCall.callType });
            setIncomingCall(null);
          }}
          onDecline={() => setIncomingCall(null)}
        />
      )}

      {activeCall && (
        <CallOverlay
          channelId={activeCall.channelId}
          callType={activeCall.callType}
          onEndCall={() => setActiveCall(null)}
        />
      )}
      {/* 👆 OVERLAYS END 👆 */}

      <Header onMenuClick={() => setIsSidebarOpen(!isSidebarOpen)} />
      
      <div className="flex flex-1 overflow-hidden relative">
        {isSidebarOpen && (
          <div 
            className="fixed inset-0 bg-black/40 z-40 md:hidden backdrop-blur-sm animate-fade-in"
            onClick={() => setIsSidebarOpen(false)}
          />
        )}
        
        <div className={`
          fixed md:relative inset-y-0 left-0 z-50 md:z-0
          transition-all duration-300 ease-out
          ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
          w-[280px] md:w-auto bg-slack-sidebar shadow-2xl md:shadow-none
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

        <main className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-[#111215] md:rounded-tl-3xl shadow-professional-xl dark:shadow-[-10px_0_30px_rgba(0,0,0,0.5)] relative z-10 transition-all duration-300 border-l border-gray-200 dark:border-gray-800">
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