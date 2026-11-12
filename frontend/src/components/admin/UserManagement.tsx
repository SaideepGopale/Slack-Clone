import axios from 'axios';
import {
  Ban,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Mail,
  MoreVertical,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../hooks/useSocket';
import { adminUsersApi, errorMessage } from '../../lib/api';
import type { AccountStatus, AdminUser, AdminUserDetails } from '../../lib/api/adminUsers';
import { Badge, Button, EmptyState, ErrorState, Field, LoadingState, Menu, Modal, TextInput, useConfirm } from '../ui';
import type { MenuItem } from '../ui';

/**
 * Platform user management (P2). Platform admins create accounts directly
 * (no e-mail, OTP or invitation link), search them server-side, inspect
 * workspace memberships and manage status, role and credentials. Workspace
 * membership itself is managed by each workspace's own admins.
 */

interface PresenceUser {
  id: string;
  status: string;
}

const STATUS_TONE: Record<AccountStatus, 'success' | 'warning' | 'danger'> = { ACTIVE: 'success', SUSPENDED: 'warning', BANNED: 'danger' };
const STATUS_FILTERS: { value: AccountStatus | ''; label: string }[] = [
  { value: '', label: 'All accounts' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'BANNED', label: 'Banned' },
];
const PASSWORD_MIN = 6;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,38}[A-Za-z0-9]$/;

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const initials = (u: { displayName: string | null; username: string }) => (u.displayName || u.username).trim().charAt(0).toUpperCase() || '?';

const PasswordInput = ({ id, value, onChange, autoFocus }: { id?: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) => {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <TextInput
        id={id}
        type={visible ? 'text' : 'password'}
        autoComplete="new-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        className="pr-10"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-fg-subtle hover:text-fg"
        aria-label={visible ? 'Hide password' : 'Show password'}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
};

const CreateUserModal = ({ onClose, onCreated }: { onClose: () => void; onCreated: (user: AdminUser) => void }) => {
  const [form, setForm] = useState({ username: '', loginId: '', password: '', displayName: '', status: 'ACTIVE' as 'ACTIVE' | 'SUSPENDED' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const problems = {
    username: form.username && !USERNAME_PATTERN.test(form.username.trim()) ? '3–40 letters, numbers, ".", "_" or "-".' : null,
    loginId: form.loginId && (/\s/.test(form.loginId.trim()) || form.loginId.trim().length < 3) ? 'At least 3 characters, no spaces.' : null,
    password: form.password && form.password.length < PASSWORD_MIN ? `At least ${PASSWORD_MIN} characters.` : null,
  };
  const ready = USERNAME_PATTERN.test(form.username.trim()) && form.loginId.trim().length >= 3 && !problems.loginId && form.password.length >= PASSWORD_MIN;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const user = await adminUsersApi.createUser({
        username: form.username.trim(),
        loginId: form.loginId.trim(),
        password: form.password,
        status: form.status,
        ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
      });
      onCreated(user);
    } catch (err) {
      setError(errorMessage(err, 'Could not create the account.'));
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Create user"
      subtitle="The account can sign in immediately with these credentials. No e-mail is sent."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="create-user-form" loading={saving} disabled={!ready} icon={<UserPlus size={15} aria-hidden="true" />}>
            Create user
          </Button>
        </>
      }
    >
      <form id="create-user-form" onSubmit={submit} className="space-y-4" noValidate>
        {error && <p role="alert" className="text-sm text-danger bg-danger-soft rounded-lg px-3 py-2">{error}</p>}
        <Field label="Username" hint="Shown to colleagues. Letters, numbers, dots, dashes, underscores." error={problems.username}>
          <TextInput autoComplete="off" value={form.username} onChange={(e) => set('username')(e.target.value)} autoFocus placeholder="sam" />
        </Field>
        <Field label="Login (e-mail or identifier)" hint="What the person types to sign in." error={problems.loginId}>
          <TextInput autoComplete="off" value={form.loginId} onChange={(e) => set('loginId')(e.target.value)} placeholder="sam@2003" />
        </Field>
        <Field label="Password" hint={`At least ${PASSWORD_MIN} characters. Share it with the person securely.`} error={problems.password}>
          <PasswordInput value={form.password} onChange={set('password')} />
        </Field>
        <Field label="Display name (optional)">
          <TextInput autoComplete="off" value={form.displayName} maxLength={80} onChange={(e) => set('displayName')(e.target.value)} placeholder="Sam Patel" />
        </Field>
        <Field label="Initial status">
          <select
            value={form.status}
            onChange={(e) => set('status')(e.target.value)}
            className="w-full h-10 rounded-xl border border-line bg-surface text-fg text-sm px-3"
          >
            <option value="ACTIVE">Active — can sign in now</option>
            <option value="SUSPENDED">Suspended — cannot sign in yet</option>
          </select>
        </Field>
      </form>
    </Modal>
  );
};

const UserDetailsModal = ({ userId, onClose, onChanged }: { userId: string; onClose: () => void; onChanged: () => void }) => {
  const [details, setDetails] = useState<AdminUserDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'name' | 'password' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    adminUsersApi
      .getUser(userId)
      .then((d) => {
        setDetails(d);
        setDisplayName(d.displayName ?? '');
      })
      .catch((err) => setError(errorMessage(err, 'Could not load this account.')));
  }, [userId]);
  useEffect(load, [load]);

  const saveName = async () => {
    setBusy('name');
    setNotice(null);
    try {
      setDetails(await adminUsersApi.updateProfile(userId, displayName));
      setNotice('Display name saved.');
      onChanged();
    } catch (err) {
      setNotice(errorMessage(err, 'Could not save the display name.'));
    } finally {
      setBusy(null);
    }
  };

  const savePassword = async () => {
    setBusy('password');
    setNotice(null);
    try {
      await adminUsersApi.setPassword(userId, password);
      setPassword('');
      setNotice('New password set. Their open sessions were signed out of live updates.');
    } catch (err) {
      setNotice(errorMessage(err, 'Could not set the password.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title={details ? details.displayName || details.username : 'Account'} subtitle={details ? `@${details.username}` : undefined} onClose={onClose} size="lg">
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !details ? (
        <LoadingState label="Loading account" />
      ) : (
        <div className="space-y-6">
          {notice && <p role="status" className="text-sm text-fg bg-surface-tertiary rounded-lg px-3 py-2">{notice}</p>}
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div><dt className="text-fg-subtle text-xs uppercase tracking-wider">Login</dt><dd className="text-fg font-medium break-all">{details.loginId}</dd></div>
            <div><dt className="text-fg-subtle text-xs uppercase tracking-wider">Status</dt><dd><Badge tone={STATUS_TONE[details.status]}>{details.status}</Badge></dd></div>
            <div><dt className="text-fg-subtle text-xs uppercase tracking-wider">Platform role</dt><dd className="text-fg">{details.role === 'ADMIN' ? 'Platform admin' : 'User'}</dd></div>
            <div>
              <dt className="text-fg-subtle text-xs uppercase tracking-wider">Created</dt>
              <dd className="text-fg">{formatDate(details.createdAt)} · {details.createdBy ? `by ${details.createdBy}` : 'self-registered'}</dd>
            </div>
          </dl>

          <section aria-labelledby="ws-heading">
            <h3 id="ws-heading" className="text-xs font-bold uppercase tracking-wider text-fg-subtle mb-2">Workspaces ({details.workspaces.length})</h3>
            {details.workspaces.length === 0 ? (
              <p className="text-sm text-fg-muted">Not a member of any workspace yet.</p>
            ) : (
              <ul className="divide-y divide-line border border-line rounded-xl overflow-hidden">
                {details.workspaces.map((w) => (
                  <li key={w.workspaceId} className="flex items-center justify-between gap-3 px-3 py-2 bg-surface">
                    <span className="text-sm text-fg truncate">{w.name}</span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {w.shared && <Badge tone="brand">Shared</Badge>}
                      <Badge>{w.role.toLowerCase()}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Field label="Display name">
                <TextInput value={displayName} maxLength={80} onChange={(e) => setDisplayName(e.target.value)} />
              </Field>
              <Button size="sm" variant="secondary" loading={busy === 'name'} onClick={saveName}>Save name</Button>
            </div>
            <div className="space-y-2">
              <Field label="Set a new password" hint={`At least ${PASSWORD_MIN} characters.`}>
                <PasswordInput value={password} onChange={setPassword} />
              </Field>
              <Button size="sm" variant="secondary" icon={<KeyRound size={14} aria-hidden="true" />} loading={busy === 'password'} disabled={password.length < PASSWORD_MIN} onClick={savePassword}>
                Set password
              </Button>
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
};

export const UserManagement = () => {
  const { token, user: currentUser } = useAuth();
  const socket = useSocket(token);
  const { confirm, dialog } = useConfirm();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<AccountStatus | ''>('');
  const [online, setOnline] = useState<Map<string, PresenceUser>>(new Map());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async (append = false, cursor: string | null = null) => {
    const ticket = ++requestRef.current;
    append ? setLoadingMore(true) : setLoading(true);
    try {
      const page = await adminUsersApi.listUsers({ q: query.trim(), status, cursor });
      if (ticket !== requestRef.current) return; // a newer search superseded this one
      setUsers((prev) => (append ? [...prev, ...page.users] : page.users));
      setNextCursor(page.nextCursor);
      setLoadError(null);
    } catch (err) {
      if (ticket === requestRef.current) setLoadError(errorMessage(err, 'Could not load accounts.'));
    } finally {
      if (ticket === requestRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [query, status]);

  useEffect(() => {
    const timer = setTimeout(() => load(false), 250); // debounce typing
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const init = (data: { users: PresenceUser[] }) => setOnline(new Map(data.users.map((u) => [u.id, u])));
    const up = (u: PresenceUser) => setOnline((prev) => new Map(prev).set(u.id, u));
    const down = ({ id }: { id: string }) =>
      setOnline((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    socket.on('presence:init', init);
    socket.on('user:online', up);
    socket.on('user:offline', down);
    return () => {
      socket.off('presence:init', init);
      socket.off('user:online', up);
      socket.off('user:offline', down);
    };
  }, [socket]);

  const flash = (tone: 'success' | 'danger', text: string) => {
    setNotice({ tone, text });
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 4000);
  };

  const run = async (u: AdminUser, action: () => Promise<unknown>, done: string) => {
    setBusyId(u.id);
    try {
      await action();
      flash('success', done);
      await load(false);
    } catch (err) {
      flash('danger', errorMessage(err, 'That action failed.'));
    } finally {
      setBusyId(null);
    }
  };

  const exportCsv = async () => {
    try {
      const res = await axios.get('/api/admin/export/users', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'users.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      flash('danger', 'Could not export users.');
    }
  };

  const menuFor = (u: AdminUser): MenuItem[] => [
    { id: 'details', label: 'View details', icon: <Users size={15} />, onSelect: () => setViewing(u.id) },
    {
      id: 'role',
      label: u.role === 'ADMIN' ? 'Remove platform admin' : 'Make platform admin',
      icon: <ShieldCheck size={15} />,
      onSelect: async () => {
        if (await confirm({ title: u.role === 'ADMIN' ? 'Remove platform admin?' : 'Make platform admin?', message: `${u.username} ${u.role === 'ADMIN' ? 'will lose' : 'will gain'} access to platform administration.`, confirmLabel: 'Confirm' })) {
          run(u, () => adminUsersApi.toggleRole(u.id), `${u.username}'s platform role was updated.`);
        }
      },
    },
    ...(u.status === 'ACTIVE'
      ? [
          { id: 'suspend', label: 'Suspend', icon: <UserMinus size={15} />, onSelect: () => run(u, () => adminUsersApi.setStatus(u.id, 'SUSPENDED'), `${u.username} is suspended.`) },
          {
            id: 'ban',
            label: 'Ban',
            icon: <Ban size={15} />,
            danger: true,
            onSelect: async () => {
              if (await confirm({ title: `Ban ${u.username}?`, message: 'They are signed out of live sessions and can no longer sign in.', confirmLabel: 'Ban', tone: 'danger' })) {
                run(u, () => adminUsersApi.setStatus(u.id, 'BANNED'), `${u.username} is banned.`);
              }
            },
          },
        ]
      : [{ id: 'reactivate', label: 'Reactivate', icon: <RotateCcw size={15} />, onSelect: () => run(u, () => adminUsersApi.setStatus(u.id, 'ACTIVE'), `${u.username} is active again.`) }]),
    { id: 'password', label: 'Set password…', icon: <KeyRound size={15} />, onSelect: () => setViewing(u.id) },
    { id: 'reset-email', label: 'Send reset e-mail', icon: <Mail size={15} />, onSelect: () => run(u, () => adminUsersApi.sendResetEmail(u.id), `A reset e-mail was requested for ${u.username}.`) },
    {
      id: 'delete',
      label: 'Delete account',
      icon: <Trash2 size={15} />,
      danger: true,
      onSelect: async () => {
        if (await confirm({ title: `Delete ${u.username}?`, message: 'Their messages are kept under "deleted user". This cannot be undone.', confirmLabel: 'Delete', tone: 'danger' })) {
          run(u, () => adminUsersApi.deleteUser(u.id), `${u.username} was deleted.`);
        }
      },
    },
  ];

  const presenceOf = (id: string) => {
    const p = online.get(id);
    if (!p) return { label: 'Offline', dot: 'bg-fg-subtle' };
    if (p.status === 'away') return { label: 'Away', dot: 'bg-amber-400' };
    if (p.status === 'in_meeting') return { label: 'In a meeting', dot: 'bg-rose-500' };
    return { label: 'Online', dot: 'bg-emerald-500' };
  };

  const summary = useMemo(() => (loading ? 'Loading accounts…' : `${users.length}${nextCursor ? '+' : ''} account${users.length === 1 ? '' : 's'}`), [loading, users.length, nextCursor]);

  return (
    <div className="h-full flex flex-col bg-surface-secondary p-4 sm:p-8 gap-6 overflow-y-auto">
      <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-fg tracking-tight">Users</h1>
          <p className="text-sm text-fg-muted mt-1">Create and manage platform accounts. Each workspace's admins decide who joins their workspace.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Download size={15} aria-hidden="true" />} onClick={exportCsv}>Export CSV</Button>
          <Button icon={<UserPlus size={15} aria-hidden="true" />} onClick={() => setCreating(true)}>Create user</Button>
        </div>
      </header>

      {notice && (
        <p role="status" className={`text-sm rounded-xl px-4 py-3 ${notice.tone === 'success' ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}>
          {notice.text}
        </p>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <label className="relative flex-1">
          <span className="sr-only">Search accounts</span>
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
          <TextInput type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, username or login" className="pl-9" />
        </label>
        <label className="sm:w-52">
          <span className="sr-only">Filter by status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as AccountStatus | '')} className="w-full h-10 rounded-xl border border-line bg-surface text-fg text-sm px-3">
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </label>
      </div>

      <section className="bg-surface border border-line rounded-2xl shadow-sm overflow-hidden" aria-label="Accounts">
        <div className="px-4 py-3 border-b border-line text-xs font-semibold text-fg-subtle uppercase tracking-wider">{summary}</div>
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => load(false)} />
        ) : loading && users.length === 0 ? (
          <LoadingState label="Loading accounts" />
        ) : users.length === 0 ? (
          <EmptyState
            icon={<Users size={24} />}
            title={query || status ? 'No matching accounts' : 'No accounts yet'}
            description={query || status ? 'Try a different search or filter.' : 'Create the first account to get started.'}
          />
        ) : (
          <ul className="divide-y divide-line">
            {users.map((u) => {
              const isSelf = u.id === currentUser?.id;
              const presence = presenceOf(u.id);
              return (
                <li key={u.id} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-secondary transition-colors">
                  <div className="relative shrink-0">
                    <div className="w-10 h-10 rounded-xl bg-brand-muted text-brand font-bold flex items-center justify-center" aria-hidden="true">{initials(u)}</div>
                    <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-surface ${presence.dot}`} title={presence.label} />
                  </div>
                  <button type="button" onClick={() => setViewing(u.id)} className="min-w-0 flex-1 text-left rounded-lg">
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-fg truncate">{u.displayName || u.username}</span>
                      {u.displayName && <span className="text-xs text-fg-subtle">@{u.username}</span>}
                      {isSelf && <Badge tone="brand">You</Badge>}
                      {u.role === 'ADMIN' && <Badge tone="brand"><ShieldCheck size={10} aria-hidden="true" /> Admin</Badge>}
                    </span>
                    <span className="block text-xs text-fg-muted truncate">
                      {u.loginId} · {u.workspaceCount} workspace{u.workspaceCount === 1 ? '' : 's'} · joined {formatDate(u.createdAt)}
                    </span>
                  </button>
                  <Badge tone={STATUS_TONE[u.status]} className="hidden sm:inline-flex">{u.status}</Badge>
                  {isSelf ? (
                    <span className="w-8" aria-hidden="true" />
                  ) : (
                    <Menu
                      label={`Actions for ${u.username}`}
                      items={menuFor(u)}
                      trigger={<MoreVertical size={16} aria-hidden="true" />}
                      align="right"
                      triggerClassName={`p-2 rounded-lg text-fg-muted hover:text-fg hover:bg-surface-tertiary ${busyId === u.id ? 'opacity-50 pointer-events-none' : ''}`}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {nextCursor && !loadError && (
          <div className="p-3 border-t border-line flex justify-center">
            <Button variant="secondary" size="sm" loading={loadingMore} onClick={() => load(true, nextCursor)}>Load more</Button>
          </div>
        )}
      </section>

      {creating && (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onCreated={(user) => {
            setCreating(false);
            flash('success', `${user.username} was created and can sign in now.`);
            load(false);
          }}
        />
      )}
      {viewing && <UserDetailsModal userId={viewing} onClose={() => setViewing(null)} onChanged={() => load(false)} />}
      {dialog}
    </div>
  );
};
