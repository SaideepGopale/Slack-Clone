import axios from 'axios';
import { ArrowRight, CheckCircle2, Eye, EyeOff, Loader2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { BrandMark } from '../ui/Brand';

const PASSWORD_MIN = 6;

/**
 * Reset password from an e-mailed link (/reset-password?token=…&id=…).
 * T.32: the token is read once and then removed from the address bar and the
 * browser history, so it does not linger after use (audit FE-13). The server
 * applies the same password rule as everywhere else and signs out every
 * other session of the account once the password changes.
 */
export const ResetPassword = () => {
  const [{ token, id }] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    return { token: query.get('token'), id: query.get('id') };
  });
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'error' | 'success' } | null>(null);

  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
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
    if (newPassword.length < PASSWORD_MIN) {
      setMessage({ text: `Password must be at least ${PASSWORD_MIN} characters long.`, type: 'error' });
      return;
    }

    setLoading(true);
    setMessage(null);
    try {
      const res = await axios.post('/api/auth/reset-password', { id, token, newPassword });
      setMessage({ text: res.data.message, type: 'success' });
      setTimeout(() => {
        window.location.href = '/';
      }, 3000);
    } catch (err: unknown) {
      setMessage({ text: (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to reset password', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const fieldClass =
    'block h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg outline-none transition-colors placeholder:text-fg-subtle focus:border-brand disabled:cursor-not-allowed disabled:bg-surface-tertiary';

  if (message?.type === 'success') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-secondary p-4">
        <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8 text-center shadow-sm animate-fade-in" role="status">
          <span className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-success-soft text-success">
            <CheckCircle2 size={24} aria-hidden="true" />
          </span>
          <h2 className="text-lg font-semibold text-fg">Password updated</h2>
          <p className="mt-1.5 text-sm text-fg-muted">{message.text}</p>
          <p className="mt-6 text-xs text-fg-subtle">Taking you to sign in…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-secondary p-4 font-sans">
      <div className="w-full max-w-[400px] rounded-2xl border border-line bg-surface p-8 shadow-sm animate-fade-in">
        <div className="mb-6 flex items-center gap-2.5">
          <BrandMark size={28} />
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-fg">SmartConnect</span>
        </div>
        <h2 className="text-[22px] font-semibold tracking-[-0.015em] text-fg">Create a new password</h2>
        <p className="mt-1.5 text-sm text-fg-muted">Choose a password you have not used here before. You will be signed out on your other devices.</p>

        {message && (
          <div role="alert" className="mt-5 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2.5 text-sm text-danger">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" aria-hidden="true" />
            {message.text}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="reset-new" className="mb-1.5 block text-xs font-medium text-fg-muted">New password</label>
            <div className="relative">
              <input id="reset-new" required type={show ? 'text' : 'password'} autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={!token || !id} className={`${fieldClass} pr-10`} placeholder="••••••••" />
              <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-fg-subtle hover:text-fg">
                {show ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-fg-subtle">At least {PASSWORD_MIN} characters.</p>
          </div>
          <div>
            <label htmlFor="reset-confirm" className="mb-1.5 block text-xs font-medium text-fg-muted">Confirm password</label>
            <input id="reset-confirm" required type={show ? 'text' : 'password'} autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} disabled={!token || !id} className={fieldClass} placeholder="••••••••" />
          </div>
          <button
            disabled={loading || !token || !id}
            type="submit"
            className="mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-brand text-sm font-semibold text-on-brand transition-colors hover:bg-brand-hover disabled:opacity-70"
          >
            {loading ? <Loader2 size={16} className="animate-spin" aria-label="Working" /> : <>Reset password <ArrowRight size={15} aria-hidden="true" /></>}
          </button>
        </form>
      </div>
    </div>
  );
};
