import axios from 'axios';
import { ArrowRight, Eye, EyeOff, Loader2, Lock, Shield, ShieldCheck, Zap } from 'lucide-react';
import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';

export const AuthForm = () => {
  const { login, register } = useAuth();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string, type: 'error' | 'success' } | null>(null);

  // Admin Portal State
  const [isAdminMode, setIsAdminMode] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    try {
      if (isAdminMode) {
        await login(email, password);
      } else if (isLogin) {
        await login(email, password);
      } else {
        await register(username, email, password);
      }
    } catch (err: any) {
      setMessage({ text: err.response?.data?.error || 'Authentication failed', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email) {
      setMessage({ text: 'Please enter your email address first.', type: 'error' });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const res = await axios.post('/api/auth/forgot-password', { email });
      setMessage({ text: res.data.message || 'Reset link sent to your email!', type: 'success' });
    } catch (err: any) {
      setMessage({ text: err.response?.data?.error || 'Failed to send reset email.', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const toggleAdminMode = () => {
    setIsAdminMode(!isAdminMode);
    setIsLogin(true); 
    setMessage(null);
    setEmail('');
    setPassword('');
  };

  // ==========================================
  // 🏢 PROFESSIONAL ADMIN UI (ENTERPRISE GRADE)
  // ==========================================
  if (isAdminMode) {
    return (
      <div className="min-h-screen bg-[#0B101E] flex flex-col justify-center py-12 sm:px-6 lg:px-8 font-sans selection:bg-indigo-500/30">
        
        <div className="sm:mx-auto sm:w-full sm:max-w-md flex flex-col items-center animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="w-14 h-14 bg-indigo-500/10 border border-indigo-500/20 rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-indigo-500/10">
            <Shield className="text-indigo-400" size={28} strokeWidth={1.5} />
          </div>
          <h2 className="text-center text-3xl font-bold text-white tracking-tight">
            Workspace Administration
          </h2>
          <p className="mt-2 text-center text-sm text-gray-400 font-medium">
            Sign in with your master credentials to continue
          </p>
        </div>

        <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md animate-in fade-in zoom-in-95 duration-500 delay-100">
          <div className="bg-[#121827] py-8 px-4 shadow-2xl sm:rounded-2xl sm:px-10 border border-[#1F2937] relative overflow-hidden">
            
            {/* Subtle top gradient accent */}
            <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-indigo-500 to-transparent opacity-40" />

            {message && (
              <div className={`p-4 rounded-xl mb-6 text-sm font-medium flex items-center gap-3 border ${message.type === 'error' ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-green-500/10 text-green-400 border-green-500/20'}`}>
                <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${message.type === 'error' ? 'bg-red-400' : 'bg-green-400'}`} />
                {message.text}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Admin Email Address
                </label>
                <div className="mt-1">
                  <input 
                    required 
                    type="email" 
                    value={email} 
                    onChange={(e) => setEmail(e.target.value)} 
                    className="appearance-none block w-full px-4 py-3 border border-[#374151] rounded-xl shadow-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-[#0B101E] text-white text-sm transition-all" 
                    placeholder="admin@slick.com" 
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Security Password
                </label>
                <div className="mt-1 relative">
                  <input 
                    required 
                    type={showPassword ? 'text' : 'password'} 
                    value={password} 
                    onChange={(e) => setPassword(e.target.value)} 
                    className="appearance-none block w-full pl-4 pr-12 py-3 border border-[#374151] rounded-xl shadow-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-[#0B101E] text-white text-sm transition-all" 
                    placeholder="••••••••" 
                  />
                  <button 
                    type="button" 
                    onClick={() => setShowPassword(!showPassword)} 
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <div className="pt-2">
                <button 
                  disabled={loading} 
                  type="submit" 
                  className="w-full flex justify-center items-center gap-2 py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-600 focus:ring-offset-[#121827] transition-all disabled:opacity-70 disabled:cursor-not-allowed"
                >
                  {loading ? <Loader2 size={18} className="animate-spin" /> : <><Lock size={16} /> Authenticate Session</>}
                </button>
              </div>
            </form>

            <div className="mt-8 pt-6 border-t border-[#1F2937]">
              <button 
                type="button" 
                onClick={toggleAdminMode} 
                className="w-full text-center text-sm font-medium text-gray-400 hover:text-white transition-colors flex items-center justify-center gap-2"
              >
                <ArrowRight size={14} className="rotate-180" /> Return to User Sign In
              </button>
            </div>

          </div>
        </div>
      </div>
    );
  }

  // ==========================================
  // 🌟 NORMAL USER UI (CLEAN & MODERN)
  // ==========================================
  return (
    <div className="min-h-screen bg-[#faf9fa] flex items-center justify-center p-4 md:p-8 font-sans">
      <div className="max-w-5xl w-full grid md:grid-cols-2 gap-12 lg:gap-24 items-center animate-in fade-in zoom-in-95 duration-500">
        
        {/* Left Side Info */}
        <div className="hidden md:flex flex-col gap-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-[#350d36] rounded-xl flex items-center justify-center text-white font-black text-xl shadow-lg">S</div>
            <span className="text-2xl font-black text-gray-900 tracking-tight">Slick</span>
          </div>
          <div>
            <h1 className="text-4xl lg:text-5xl font-black text-gray-900 tracking-tight leading-[1.1] mb-6">Welcome back to<br />the workspace.</h1>
            <p className="text-gray-500 text-base font-medium max-w-md leading-relaxed">Ditch the noise. Connect with your team in a beautifully designed space that facilitates focus and creativity.</p>
          </div>
          <div className="flex flex-col gap-6 mt-4">
            <div className="flex items-start gap-4">
              <div className="p-2.5 bg-green-50 text-green-600 rounded-xl shrink-0"><ShieldCheck size={20} /></div>
              <div><h3 className="font-bold text-gray-900 text-sm mb-1">Secure Database</h3><p className="text-xs text-gray-500 font-medium">Encryption at rest and in transit.</p></div>
            </div>
            <div className="flex items-start gap-4">
              <div className="p-2.5 bg-blue-50 text-blue-600 rounded-xl shrink-0"><Zap size={20} /></div>
              <div><h3 className="font-bold text-gray-900 text-sm mb-1">Instant Sync</h3><p className="text-xs text-gray-500 font-medium">Built on ultra-fast WebSocket cores.</p></div>
            </div>
          </div>
        </div>

        {/* Right Side Form */}
        <div className="bg-white p-8 lg:p-10 rounded-[2rem] shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05)] border border-gray-100 relative">
          
          <div className="flex p-1 bg-gray-50 rounded-xl mb-8">
            <button type="button" onClick={() => { setIsLogin(true); setMessage(null); }} className={`flex-1 py-2.5 text-sm font-black rounded-lg transition-all ${isLogin ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>Login</button>
            <button type="button" onClick={() => { setIsLogin(false); setMessage(null); }} className={`flex-1 py-2.5 text-sm font-black rounded-lg transition-all ${!isLogin ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>Sign Up</button>
          </div>

          <div className="mb-8">
            <h2 className="text-2xl font-black text-gray-900 tracking-tight mb-2">{isLogin ? 'Sign In' : 'Create Account'}</h2>
            <p className="text-sm text-gray-400 font-medium">Enter your details to continue.</p>
          </div>

          {message && (
            <div className={`p-4 rounded-xl mb-6 text-sm font-bold flex items-center gap-2 ${message.type === 'error' ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'}`}>
              <div className={`w-1.5 h-1.5 rounded-full ${message.type === 'error' ? 'bg-red-600' : 'bg-green-600'}`} />
              {message.text}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {!isLogin && (
              <div>
                <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 block">Full Name</label>
                <input required type="text" value={username} onChange={(e) => setUsername(e.target.value)} className="w-full bg-gray-50 border border-transparent focus:border-gray-200 focus:bg-white rounded-xl px-4 py-3 text-sm font-bold text-gray-900 outline-none transition-all placeholder:font-medium placeholder:text-gray-400" placeholder="Samarth Karale" />
              </div>
            )}
            
            <div>
              <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 block">Email Address</label>
              <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full bg-gray-50 border border-transparent focus:border-gray-200 focus:bg-white rounded-xl px-4 py-3 text-sm font-bold text-gray-900 outline-none transition-all placeholder:font-medium placeholder:text-gray-400" placeholder="samarth@example.com" />
            </div>

            <div className="relative">
              <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 block">Secret Password</label>
              <input required type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-gray-50 border border-transparent focus:border-gray-200 focus:bg-white rounded-xl pl-4 pr-12 py-3 text-sm font-bold text-gray-900 outline-none transition-all placeholder:font-medium placeholder:text-gray-400" placeholder="••••••••" />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-4 top-[30px] text-gray-400 hover:text-gray-600 transition-colors">
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>

            {isLogin && (
              <div className="flex justify-end mt-2">
                <button type="button" onClick={handleForgotPassword} disabled={loading} className="text-xs font-bold text-[#350d36] hover:text-purple-900 transition-colors">
                  Forgot Password?
                </button>
              </div>
            )}

            <button disabled={loading} type="submit" className="w-full py-3.5 bg-[#350d36] hover:bg-[#4a154b] text-white rounded-xl font-black text-sm flex items-center justify-center gap-2 transition-all active:scale-[0.98] mt-6 shadow-lg shadow-purple-900/20 disabled:opacity-70">
              {loading ? <Loader2 size={18} className="animate-spin" /> : <>{isLogin ? 'Sign In' : 'Create Workspace'} <ArrowRight size={16} /></>}
            </button>
          </form>
          
          {/* Admin Portal Entry Point */}
          <div className="mt-8 flex justify-center items-center gap-3 border-t border-gray-100 pt-6">
            <button type="button" onClick={toggleAdminMode} className="text-[10px] font-bold text-gray-400 hover:text-gray-800 uppercase tracking-widest transition-colors">
              Access Admin Portal
            </button>
          </div>

        </div>
      </div>
    </div>
  );
};