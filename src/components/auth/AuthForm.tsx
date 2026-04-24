import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';
import { motion } from 'motion/react';
import { Circle } from 'lucide-react';

export const AuthForm = () => {
  const { login, register } = useAuth();
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [dbStatus, setDbStatus] = useState<'checking' | 'connected' | 'error'>('checking');

  useEffect(() => {
    const checkDb = async () => {
      try {
        const res = await axios.get('/api/health');
        setDbStatus(res.data.database === 'connected' ? 'connected' : 'error');
      } catch { setDbStatus('error'); }
    };
    checkDb();
    const interval = setInterval(checkDb, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (dbStatus !== 'connected') {
      setError('Database is not connected. Please add DATABASE_URL (PostgreSQL) in the Secrets panel.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      isLogin ? await login(email, password) : await register(username, email, password);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Auth failed. Check your connection.');
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen flex flex-col items-center p-6 bg-white overflow-y-auto">
      <div className="w-full max-w-2xl flex flex-col items-center pt-20 mb-20">
        <div className="flex items-center gap-3 mb-10">
          <div className="w-12 h-12 bg-slack-purple rounded flex items-center justify-center text-white font-black text-2xl shadow-lg">S</div>
          <h1 className="text-4xl font-black text-gray-900 tracking-tight">Slick</h1>
        </div>
        
        <h2 className="text-4xl font-black text-gray-900 mb-4 text-center tracking-tight leading-tight px-4">
          {isLogin ? 'Sign in to Slick' : 'First, enter your details'}
        </h2>

        <div className="flex items-center gap-2 mb-8 bg-gray-50 px-4 py-1.5 rounded-full border border-gray-100">
           <div className={`w-2 h-2 rounded-full ${dbStatus === 'connected' ? 'bg-emerald-500' : 'bg-rose-500 animate-pulse'}`}></div>
           <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
             Database: {dbStatus === 'checking' ? 'Checking...' : dbStatus === 'connected' ? 'Connected' : 'Offline'}
           </span>
        </div>
        
        <p className="text-gray-500 font-medium text-center mb-10 max-w-sm px-4 leading-relaxed">
          We suggest using the <b>email address you use for work.</b>
        </p>
        
        <div className="w-full max-w-sm px-4">
          {error && (
            <div className="bg-rose-50 text-rose-600 p-4 rounded-xl mb-6 text-sm border border-rose-100 flex items-center gap-3 font-medium">
              <Circle size={10} fill="currentColor" stroke="none" />
              {error}
            </div>
          )}
          
          <form onSubmit={handleAuth} className="space-y-4">
            {!isLogin && (
              <input 
                type="text" 
                placeholder="Name" 
                required 
                className="w-full p-4 border-2 border-gray-100 rounded-xl outline-none focus:border-slack-active font-bold text-gray-800 placeholder:text-gray-300 transition-all" 
                value={username} 
                onChange={e => setUsername(e.target.value)} 
              />
            )}
            <input 
              type="email" 
              placeholder="name@work-email.com" 
              required 
              className="w-full p-4 border-2 border-gray-100 rounded-xl outline-none focus:border-slack-active font-bold text-gray-800 placeholder:text-gray-300 transition-all" 
              value={email} 
              onChange={e => setEmail(e.target.value)} 
            />
            <input 
              type="password" 
              placeholder="Password" 
              required 
              className="w-full p-4 border-2 border-gray-100 rounded-xl outline-none focus:border-slack-active font-bold text-gray-800 placeholder:text-gray-300 transition-all" 
              value={password} 
              onChange={e => setPassword(e.target.value)} 
            />
            <button 
              type="submit" 
              disabled={loading}
              className="w-full bg-slack-purple text-white font-black p-4 rounded-xl hover:bg-slack-purple-hover disabled:opacity-50 transition-all active:scale-[0.98] shadow-xl shadow-purple-900/10"
            >
              {loading ? 'Confirming...' : (isLogin ? 'Sign In' : 'Continue')}
            </button>
          </form>
          
          <div className="mt-12 text-center">
             <p className="text-gray-500 font-medium">
              {isLogin ? "New to Slick?" : "Already member?"}
              <button 
                onClick={() => { setIsLogin(!isLogin); setError(''); }} 
                className="ml-2 text-slack-active font-black hover:underline"
              >
                {isLogin ? 'Create an account' : 'Log in instead'}
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
