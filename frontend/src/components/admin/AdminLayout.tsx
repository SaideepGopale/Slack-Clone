import { ArrowLeft, ClipboardList, Hash, HardDrive, LayoutDashboard, LogOut, MessageSquareOff, ShieldAlert, Users } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { AdminDashboard } from './AdminDashboard';
import { AuditLogViewer } from './AuditLogViewer';
import { ChannelManagement } from './ChannelManagement'; // 👇 Naya import add ho gaya
import { FileStorageManagement } from './FileStorageManagement';
import { MessageModeration } from './MessageModeration';
import { UserManagement } from './UserManagement';

type AdminTab = 'dashboard' | 'users' | 'channels' | 'audit' | 'moderation' | 'files';

export const AdminLayout = () => {
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard');
  const { logout } = useAuth();

  // 👇 YE RAHA TERA renderContent FUNCTION 👇
  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return <AdminDashboard />;
      case 'users':
        return <UserManagement />;
      case 'channels':
        return <ChannelManagement />; // 👇 Ab ye naya component call karega
      case 'audit':
        return <AuditLogViewer />;
      case 'moderation':
        return <MessageModeration />;
      case 'files':
        return <FileStorageManagement />;
      default:
        return <AdminDashboard />;
    }
  };
  // 👆 --------------------------------- 👆

  return (
    <div className="flex h-screen w-screen bg-white font-sans overflow-hidden selection:bg-blue-100">
      
      {/* ─── ADMIN SIDEBAR ─── */}
      <div className="w-72 bg-white border-r border-gray-200 flex flex-col relative z-20 shadow-sm">
        
        {/* Logo/Brand */}
        <div className="h-20 flex items-center px-6 border-b border-gray-200 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center text-white shadow-md">
              <ShieldAlert size={20} />
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-900 tracking-tight uppercase">Admin Panel</h1>
              <div className="flex items-center gap-1.5 mt-0.5">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                <span className="text-[10px] font-medium text-green-700 uppercase tracking-wider">System Active</span>
              </div>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <div className="flex-1 py-6 px-4 flex flex-col gap-2 overflow-y-auto">
          <div className="text-[10px] font-bold text-gray-600 uppercase tracking-wider mb-2 px-3">
            Core Modules
          </div>
          
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg font-semibold text-sm transition-all duration-300 ${
              activeTab === 'dashboard' 
                ? 'bg-blue-50 text-blue-700 border border-blue-200 shadow-sm' 
                : 'text-gray-700 hover:text-blue-600 hover:bg-gray-50 border border-transparent'
            }`}
          >
            <LayoutDashboard size={18} /> Dashboard
          </button>

          <button
            onClick={() => setActiveTab('users')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg font-semibold text-sm transition-all duration-300 ${
              activeTab === 'users' 
                ? 'bg-blue-50 text-blue-700 border border-blue-200 shadow-sm' 
                : 'text-gray-700 hover:text-blue-600 hover:bg-gray-50 border border-transparent'
            }`}
          >
            <Users size={18} /> User Management
          </button>

          <button
            onClick={() => setActiveTab('channels')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg font-semibold text-sm transition-all duration-300 ${
              activeTab === 'channels' 
                ? 'bg-blue-50 text-blue-700 border border-blue-200 shadow-sm' 
                : 'text-gray-700 hover:text-blue-600 hover:bg-gray-50 border border-transparent'
            }`}
          >
            <Hash size={18} /> Channel Management
          </button>

          <div className="text-[10px] font-bold text-gray-600 uppercase tracking-wider mt-4 mb-2 px-3">
            Security & Compliance
          </div>

          <button
            onClick={() => setActiveTab('audit')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg font-semibold text-sm transition-all duration-300 ${
              activeTab === 'audit'
                ? 'bg-blue-50 text-blue-700 border border-blue-200 shadow-sm'
                : 'text-gray-700 hover:text-blue-600 hover:bg-gray-50 border border-transparent'
            }`}
          >
            <ClipboardList size={18} /> Audit Logs
          </button>

          <button
            onClick={() => setActiveTab('moderation')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg font-semibold text-sm transition-all duration-300 ${
              activeTab === 'moderation'
                ? 'bg-blue-50 text-blue-700 border border-blue-200 shadow-sm'
                : 'text-gray-700 hover:text-blue-600 hover:bg-gray-50 border border-transparent'
            }`}
          >
            <MessageSquareOff size={18} /> Content Moderation
          </button>

          <button
            onClick={() => setActiveTab('files')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg font-semibold text-sm transition-all duration-300 ${
              activeTab === 'files'
                ? 'bg-blue-50 text-blue-700 border border-blue-200 shadow-sm'
                : 'text-gray-700 hover:text-blue-600 hover:bg-gray-50 border border-transparent'
            }`}
          >
            <HardDrive size={18} /> File Storage
          </button>
        </div>

        {/* Bottom Actions */}
        <div className="p-4 border-t border-gray-200 flex flex-col gap-2 shrink-0">
          <button 
            onClick={() => window.location.href = '/'} 
            className="flex items-center justify-center gap-2 w-full py-3 rounded-lg text-xs font-semibold text-gray-700 hover:text-gray-900 uppercase tracking-wider border border-gray-300 hover:bg-gray-50 transition-all"
          >
            <ArrowLeft size={16} /> Exit Admin
          </button>
          
          <button 
            onClick={logout} 
            className="flex items-center justify-center gap-2 w-full py-3 rounded-lg text-xs font-semibold text-red-600 hover:text-white uppercase tracking-wider border border-red-200 hover:bg-red-600 hover:border-red-600 transition-all"
          >
            <LogOut size={16} /> Logout
          </button>
        </div>
      </div>

      {/* ─── MAIN CONTENT AREA ─── */}
      <div className="flex-1 relative overflow-hidden flex flex-col bg-white">
        {/* Dynamic Content */}
        <div className="flex-1 overflow-y-auto relative z-10 custom-scrollbar">
          {renderContent()}
        </div>
      </div>

    </div>
  );
};