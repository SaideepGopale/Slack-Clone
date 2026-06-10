import React, { useState, useEffect } from 'react';
import axios from 'axios';

export const ResetPassword: React.FC = () => {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('token');
    setToken(t);
  }, []);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');
    setSuccess('');

    if (!token) {
      setError('Missing reset token');
      return;
    }

    if (!password || password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);

    try {
      const res = await axios.post('/api/auth/reset-password', { token, password });
      setSuccess(res.data?.message || 'Password reset successfully');
      setPassword('');
      setConfirm('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-white">
      <div className="w-full max-w-md p-8 rounded-xl shadow-lg">
        <h2 className="text-2xl font-black mb-4">Reset Password</h2>

        {error && <div className="mb-4 text-rose-600 font-bold">{error}</div>}
        {success && <div className="mb-4 text-emerald-600 font-bold">{success}</div>}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">New password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full p-3 border rounded-lg" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">Confirm password</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="w-full p-3 border rounded-lg" />
          </div>

          <div>
            <button type="submit" disabled={loading} className="w-full py-3 bg-slack-purple text-white font-bold rounded-lg">
              {loading ? 'Processing...' : 'Reset Password'}
            </button>
          </div>
        </form>

      </div>
    </div>
  );
};
