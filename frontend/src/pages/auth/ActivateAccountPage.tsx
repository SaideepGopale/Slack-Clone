import { CheckCircle2, KeyRound, ShieldAlert } from 'lucide-react';
import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button, Field, TextInput } from '../../components/ui';
import { errorMessage, teamManagementApi } from '../../lib/api';

/**
 * Stage 2 (T.20) — /activate#token=… : the one-time account activation page.
 *
 * The token arrives in the URL fragment (never sent to any server, so never
 * logged), is read once and immediately removed from the address bar, and is
 * never rendered. Activation sets the person's own password and creates NO
 * session: afterwards they sign in through the normal sign-in page. The
 * temporary password only ever works here.
 */

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIN = 10;
const MAX = 128;

const readToken = (hash: string) => {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? '';
  return TOKEN_PATTERN.test(token) ? token : null;
};

const Card = ({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) => (
  <div className="min-h-screen bg-surface-secondary flex items-center justify-center p-4">
    <main className="bg-surface border border-line rounded-2xl shadow-xl max-w-md w-full p-6 sm:p-8 space-y-6">
      <div className="flex flex-col items-center text-center gap-3">
        <div className="w-12 h-12 rounded-xl bg-brand-muted text-brand flex items-center justify-center" aria-hidden="true">{icon}</div>
        <h1 className="text-2xl font-bold text-fg tracking-tight">{title}</h1>
      </div>
      {children}
    </main>
  </div>
);

export const ActivateAccountPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => readToken(location.hash));
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activatedAs, setActivatedAs] = useState<string | null>(null);

  // Take the token out of the address bar (and history) as soon as it's read.
  useEffect(() => {
    if (location.hash) navigate(location.pathname, { replace: true });
  }, [location.hash, location.pathname, navigate]);

  if (activatedAs) {
    return (
      <Card icon={<CheckCircle2 size={22} />} title="Your account is ready">
        <p className="text-sm text-fg-muted text-center">
          Sign in with <strong className="text-fg">{activatedAs}</strong> and the password you just chose. The temporary password no longer works.
        </p>
        <Link to="/login" className="flex items-center justify-center h-10 rounded-xl bg-brand text-white text-sm font-semibold">
          Go to sign in
        </Link>
      </Card>
    );
  }

  if (!token) {
    return (
      <Card icon={<ShieldAlert size={22} />} title="This activation link is incomplete">
        <p className="text-sm text-fg-muted text-center">
          Open the full link exactly as your administrator shared it, or ask them for a new invitation.
        </p>
        <Link to="/login" className="block text-center text-sm font-semibold text-brand">Back to sign in</Link>
      </Card>
    );
  }

  const tooShort = newPassword.length > 0 && newPassword.length < MIN;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const ready = temporaryPassword.trim().length > 0 && newPassword.length >= MIN && newPassword.length <= MAX && confirmPassword === newPassword;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await teamManagementApi.activateAccount({ token, temporaryPassword: temporaryPassword.trim(), newPassword });
      setActivatedAs(result.loginId);
    } catch (err) {
      setError(errorMessage(err, 'Activation failed. Please try again.'));
      setBusy(false);
    }
  };

  return (
    <Card icon={<KeyRound size={22} />} title="Activate your SmartConnect account">
      <p className="text-sm text-fg-muted text-center">
        Enter the temporary password your administrator gave you, then choose your own password. This link works once.
      </p>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <p role="alert" className="text-sm text-danger bg-danger-soft rounded-lg px-3 py-2">{error}</p>}
        <Field label="Temporary password">
          <TextInput type="password" autoComplete="one-time-code" value={temporaryPassword} onChange={(e) => setTemporaryPassword(e.target.value)} autoFocus />
        </Field>
        <Field label="New password" hint={tooShort ? undefined : `At least ${MIN} characters. Not your e-mail address.`} error={tooShort ? `At least ${MIN} characters.` : null}>
          <TextInput type="password" autoComplete="new-password" maxLength={MAX} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        </Field>
        <Field label="Confirm new password" error={mismatch ? 'The passwords do not match.' : null}>
          <TextInput type="password" autoComplete="new-password" maxLength={MAX} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!ready}>
          Activate account
        </Button>
      </form>
    </Card>
  );
};
