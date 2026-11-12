import axios from 'axios';
import { KeyRound, Laptop, LogOut, Smartphone } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { useAuth } from '../../contexts/AuthContext';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { Modal } from '../ui/Modal';

/**
 * Password & security (T.32, audit H1 — the user-facing half): change your
 * password (other devices are signed out), see where you are signed in, end
 * one session, or sign out everywhere. Everything is enforced by the server
 * (POST /api/auth/change-password, GET/DELETE /api/auth/sessions,
 * POST /api/auth/logout-all).
 */
interface SessionInfo {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
}

const PASSWORD_MIN = 6;

const describeDevice = (ua: string | null) => {
  if (!ua) return { label: 'Unknown device', mobile: false };
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return { label: os ? `${browser} on ${os}` : browser, mobile: /iPhone|Android|Mobile/.test(ua) };
};

const errorText = (err: unknown, fallback: string) => (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

export const SecuritySettingsModal = ({ onClose }: { onClose: () => void }) => {
  const { logout } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [ending, setEnding] = useState<string | null>(null);

  const loadSessions = useCallback(() => {
    setSessionsError(null);
    axios
      .get<SessionInfo[]>('/api/auth/sessions')
      .then((res) => setSessions(res.data))
      .catch((err) => setSessionsError(errorText(err, 'Could not load your sessions.')));
  }, []);

  useEffect(loadSessions, [loadSessions]);

  const problem =
    next && next.length < PASSWORD_MIN ? `At least ${PASSWORD_MIN} characters.` : repeat && next !== repeat ? 'The new passwords do not match.' : null;

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (!current || !next || problem || next !== repeat) return;
    setSaving(true);
    setFormError(null);
    try {
      const res = await axios.post<{ message: string; endedSessions: number }>('/api/auth/change-password', { currentPassword: current, newPassword: next });
      toast.success(res.data.endedSessions ? `Password changed. ${res.data.endedSessions} other session${res.data.endedSessions === 1 ? ' was' : 's were'} signed out.` : 'Password changed.');
      setCurrent('');
      setNext('');
      setRepeat('');
      loadSessions();
    } catch (err) {
      setFormError(errorText(err, 'Your password could not be changed.'));
    } finally {
      setSaving(false);
    }
  };

  const endSession = async (session: SessionInfo) => {
    setEnding(session.id);
    try {
      await axios.delete(`/api/auth/sessions/${encodeURIComponent(session.id)}`);
      setSessions((prev) => prev?.filter((s) => s.id !== session.id) ?? prev);
      toast.success('Session ended');
    } catch (err) {
      toast.error(errorText(err, 'The session could not be ended.'));
    } finally {
      setEnding(null);
    }
  };

  const signOutEverywhere = async () => {
    const ok = await confirm({
      title: 'Sign out everywhere?',
      message: 'Every device signed in to your account — including this one — is signed out right away.',
      confirmLabel: 'Sign out everywhere',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await axios.post('/api/auth/logout-all');
    } catch {
      // The local sign-out below happens either way.
    }
    logout();
  };

  const inputClass = 'mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg outline-none focus:border-brand';

  return (
    <Modal title="Password & security" onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      {dialog}
      <div className="space-y-7">
        <section aria-labelledby="pw-heading">
          <h3 id="pw-heading" className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
            <KeyRound size={15} className="text-fg-subtle" aria-hidden="true" /> Change password
          </h3>
          <form onSubmit={changePassword} className="space-y-3" noValidate>
            <label className="block text-xs font-medium text-fg-muted">
              Current password
              <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={inputClass} />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium text-fg-muted">
                New password
                <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={inputClass} aria-describedby="pw-hint" />
              </label>
              <label className="block text-xs font-medium text-fg-muted">
                Repeat new password
                <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} className={inputClass} />
              </label>
            </div>
            <p id="pw-hint" className={`text-xs ${problem || formError ? 'text-danger' : 'text-fg-subtle'}`} role={problem || formError ? 'alert' : undefined}>
              {formError ?? problem ?? `At least ${PASSWORD_MIN} characters. Your other devices will be signed out.`}
            </p>
            <Button type="submit" size="sm" loading={saving} disabled={!current || !next || !repeat || !!problem}>
              Change password
            </Button>
          </form>
        </section>

        <section aria-labelledby="sessions-heading">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 id="sessions-heading" className="text-sm font-semibold text-fg">Where you’re signed in</h3>
            <Button size="sm" variant="ghost" icon={<LogOut size={14} aria-hidden="true" />} onClick={() => void signOutEverywhere()}>
              Sign out everywhere
            </Button>
          </div>
          {sessionsError ? (
            <p className="text-sm text-danger" role="alert">{sessionsError}</p>
          ) : sessions === null ? (
            <div className="space-y-2" aria-label="Loading sessions">
              <div className="skeleton h-12 rounded-lg" />
              <div className="skeleton h-12 rounded-lg" />
            </div>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {sessions.map((s) => {
                const device = describeDevice(s.userAgent);
                return (
                  <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-tertiary text-fg-muted" aria-hidden="true">
                      {device.mobile ? <Smartphone size={15} /> : <Laptop size={15} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-fg">
                        {device.label} {s.current && <span className="ml-1 rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success">This device</span>}
                      </p>
                      <p className="text-xs text-fg-subtle">
                        Signed in {new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · active {new Date(s.lastUsedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </p>
                    </div>
                    {!s.current && (
                      <Button size="sm" variant="secondary" loading={ending === s.id} onClick={() => void endSession(s)} aria-label={`Sign out ${device.label}`}>
                        Sign out
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
};
