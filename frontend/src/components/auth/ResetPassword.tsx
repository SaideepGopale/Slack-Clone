import axios from 'axios';
import { ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';

export const ResetPassword = () => {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string, type: 'error' | 'success' } | null>(null);
  
  // URL se token aur ID nikalne ka logic
  const query = new URLSearchParams(window.location.search);
  const token = query.get('token');
  const id = query.get('id');

  useEffect(() => {
    if (!token || !id) {
      setMessage({ text: 'Invalid or missing reset token. Please request a new link.', type: 'error' });
    }
  }, [token, id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setMessage({ text: 'Passwords do not match!', type: 'error' });
      return;
    }
    if (newPassword.length < 6) {
      setMessage({ text: 'Password must be at least 6 characters long.', type: 'error' });
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const res = await axios.post('/api/auth/reset-password', {
        id,
        token,
        newPassword
      });
      setMessage({ text: res.data.message, type: 'success' });
      
      // 3 second baad login page pe redirect
      setTimeout(() => {
        window.location.href = '/'; 
      }, 3000);
      
    } catch (err: any) {
      setMessage({ text: err.response?.data?.error || 'Failed to reset password', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  // Agar success ho gaya, toh UI thoda alag dikhao
  if (message?.type === 'success') {
    return (
      <div className="min-h-screen bg-[#faf9fa] flex items-center justify-center p-4">
        <div className="bg-white p-8 rounded-[2rem] shadow-xl max-w-md w-full text-center border border-gray-100">
          <div className="w-16 h-16 bg-green-50 text-green-500 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 size={32} />
          </div>
          <h2 className="text-2xl font-black text-gray-900 mb-2">Password Updated!</h2>
          <p className="text-gray-500 font-medium text-sm mb-8">{message.text}</p>
          <p className="text-xs text-gray-400 font-bold uppercase tracking-widest animate-pulse">Redirecting to Login...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#faf9fa] flex items-center justify-center p-4 font-sans">
      <div className="bg-white p-8 lg:p-10 rounded-[2rem] shadow-xl max-w-md w-full border border-gray-100 relative">
        <div className="flex items-center justify-center mb-8">
          <div className="w-12 h-12 bg-[#350d36] rounded-xl flex items-center justify-center text-white font-black text-xl shadow-lg">S</div>
        </div>
        
        <div className="text-center mb-8">
          <h2 className="text-2xl font-black text-gray-900 tracking-tight mb-2">Create New Password</h2>
          <p className="text-sm text-gray-400 font-medium">Your new password must be different from previous used passwords.</p>
        </div>

        {message && (
          <div className={`p-4 rounded-xl mb-6 text-sm font-bold flex items-center gap-2 ${message.type === 'error' ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'}`}>
            <div className={`w-1.5 h-1.5 rounded-full ${message.type === 'error' ? 'bg-red-600' : 'bg-green-600'}`} />
            {message.text}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 block">New Password</label>
            <input 
              required 
              type="password" 
              value={newPassword} 
              onChange={(e) => setNewPassword(e.target.value)} 
              disabled={!token || !id}
              className="w-full bg-gray-50 border border-transparent focus:border-gray-200 focus:bg-white rounded-xl px-4 py-3 text-sm font-bold text-gray-900 outline-none transition-all" 
              placeholder="••••••••" 
            />
          </div>

          <div>
            <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 block">Confirm Password</label>
            <input 
              required 
              type="password" 
              value={confirmPassword} 
              onChange={(e) => setConfirmPassword(e.target.value)} 
              disabled={!token || !id}
              className="w-full bg-gray-50 border border-transparent focus:border-gray-200 focus:bg-white rounded-xl px-4 py-3 text-sm font-bold text-gray-900 outline-none transition-all" 
              placeholder="••••••••" 
            />
          </div>

          <button 
            disabled={loading || !token || !id} 
            type="submit" 
            className="w-full py-3.5 bg-[#350d36] hover:bg-[#4a154b] text-white rounded-xl font-black text-sm flex items-center justify-center gap-2 transition-all active:scale-[0.98] mt-6 shadow-lg shadow-purple-900/20 disabled:opacity-70"
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : <>Reset Password <ArrowRight size={16} /></>}
          </button>
        </form>
      </div>
    </div>
  );
};