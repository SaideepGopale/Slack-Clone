import { KeyRound, RotateCcw, ShieldCheck, UserPlus, Users, XCircle } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { errorMessage, teamManagementApi } from '../../lib/api';
import type { InvitationStatus, ProvisionResult, TeamLead } from '../../lib/api/teamManagement';
import { Badge, Button, EmptyState, ErrorState, Field, LoadingState, Modal, OneTimeCredentialsModal, TextInput, useConfirm } from '../ui';
import type { BadgeTone } from '../ui';

/**
 * Stage 2 (T.20) — Admin → Team Management. The Company Admin adds Team Leads
 * (never ordinary members, never admins) and hands each one a single-use
 * activation link plus a temporary password. Separate from, and independent
 * of, the existing "Create user" in User Management.
 *
 * One-time credentials live only in this component's state while their
 * dialog is open — never in storage, never re-fetched (the server can't
 * return them again: it keeps only hashes).
 */

const INVITATION_BADGE: Record<InvitationStatus, { label: string; tone: BadgeTone }> = {
  PENDING: { label: 'Pending', tone: 'warning' },
  ACCEPTED: { label: 'Accepted', tone: 'success' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  REVOKED: { label: 'Revoked', tone: 'danger' },
};
const ACCOUNT_BADGE: Record<TeamLead['status'], { label: string; tone: BadgeTone }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  SUSPENDED: { label: 'Suspended', tone: 'warning' },
  BANNED: { label: 'Banned', tone: 'danger' },
};
const REVOKED_REASON: Record<string, string> = {
  ADMIN: 'revoked by an admin',
  TOO_MANY_ATTEMPTS: 'locked after too many wrong temporary passwords',
  REISSUED: 'replaced by a newer invitation',
  TEAM_LEAD: 'revoked by the team lead',
};

const formatDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const nameOf = (lead: TeamLead) => lead.displayName || lead.username;

const AddTeamLeadModal = ({ onClose, onCreated }: { onClose: () => void; onCreated: (result: ProvisionResult) => void }) => {
  const [form, setForm] = useState({ email: '', displayName: '', teamLabel: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const email = form.email.trim();
  const ready = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await teamManagementApi.addTeamLead({
        email,
        ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
        ...(form.teamLabel.trim() ? { teamLabel: form.teamLabel.trim() } : {}),
      });
      onCreated(result);
    } catch (err) {
      setError(errorMessage(err, 'Could not add the Team Lead.'));
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add Team Lead"
      subtitle="Creates a Team Lead account with a single-use activation link and temporary password. No e-mail is sent."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="add-team-lead-form" loading={saving} disabled={!ready} icon={<UserPlus size={15} aria-hidden="true" />}>
            Create Team Lead
          </Button>
        </>
      }
    >
      <form id="add-team-lead-form" onSubmit={submit} className="space-y-4" noValidate>
        {error && <p role="alert" className="text-sm text-danger bg-danger-soft rounded-lg px-3 py-2">{error}</p>}
        <Field label="E-mail address" hint="Becomes their login. They activate the account themselves.">
          <TextInput type="email" autoComplete="off" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} autoFocus placeholder="priya@company.com" />
        </Field>
        <Field label="Display name (optional)">
          <TextInput autoComplete="off" maxLength={80} value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} placeholder="Priya Sharma" />
        </Field>
        <Field label="Team label (optional)" hint="For your reference, e.g. the team they will lead.">
          <TextInput autoComplete="off" maxLength={80} value={form.teamLabel} onChange={(e) => setForm((f) => ({ ...f, teamLabel: e.target.value }))} placeholder="Design" />
        </Field>
      </form>
    </Modal>
  );
};

export const TeamManagement = () => {
  const [leads, setLeads] = useState<TeamLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<ProvisionResult | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setLeads((await teamManagementApi.listTeamLeads()).teamLeads);
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load Team Leads.'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const upsert = (lead: TeamLead) => setLeads((list) => [lead, ...list.filter((l) => l.id !== lead.id)]);

  const revoke = async (lead: TeamLead) => {
    if (!lead.invitation) return;
    const ok = await confirm({
      title: 'Revoke invitation?',
      message: `${nameOf(lead)}'s activation link and temporary password will stop working immediately. You can issue a new invitation later.`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!ok) return;
    setBusyId(lead.id);
    try {
      const { invitation } = await teamManagementApi.revokeInvitation(lead.invitation.id);
      setLeads((list) => list.map((l) => (l.id === lead.id ? { ...l, invitation } : l)));
      setNotice({ tone: 'success', text: `Revoked the invitation for ${nameOf(lead)}.` });
    } catch (err) {
      setNotice({ tone: 'danger', text: errorMessage(err, 'Could not revoke the invitation.') });
    } finally {
      setBusyId(null);
    }
  };

  const reissue = async (lead: TeamLead) => {
    setBusyId(lead.id);
    try {
      const result = await teamManagementApi.reissueInvitation(lead.id);
      upsert(result.teamLead);
      setShown(result);
    } catch (err) {
      setNotice({ tone: 'danger', text: errorMessage(err, 'Could not reissue the invitation.') });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="h-full flex flex-col bg-surface-secondary p-4 sm:p-8 gap-6 overflow-y-auto">
      <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-fg tracking-tight">Team Management</h1>
          <p className="text-sm text-fg-muted mt-1">
            Add Team Leads. Each one activates their own account with a single-use link and temporary password, then creates and runs their team's workspaces.
          </p>
        </div>
        <Button icon={<UserPlus size={15} aria-hidden="true" />} onClick={() => setAdding(true)}>Add Team Lead</Button>
      </header>

      {notice && (
        <p role="status" className={`text-sm rounded-xl px-4 py-3 ${notice.tone === 'success' ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}>
          {notice.text}
        </p>
      )}

      <section className="bg-surface border border-line rounded-2xl shadow-sm overflow-hidden" aria-label="Team Leads">
        <div className="px-4 py-3 border-b border-line text-xs font-semibold text-fg-subtle uppercase tracking-wider">
          {loading ? 'Loading Team Leads…' : `${leads.length} Team Lead${leads.length === 1 ? '' : 's'}`}
        </div>
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => void load()} />
        ) : loading && leads.length === 0 ? (
          <LoadingState label="Loading Team Leads" />
        ) : leads.length === 0 ? (
          <EmptyState icon={<Users size={24} />} title="No Team Leads yet" description="Add the first Team Lead to get started." />
        ) : (
          <ul className="divide-y divide-line">
            {leads.map((lead) => {
              const invitation = lead.invitation;
              const badge = invitation ? INVITATION_BADGE[invitation.status] : null;
              // T.21: provisioned accounts stay SUSPENDED until activation — show
              // that as "Awaiting activation", not as an admin suspension.
              const awaitingActivation = lead.status === 'SUSPENDED' && !!invitation && invitation.status !== 'ACCEPTED';
              const account = awaitingActivation ? { label: 'Awaiting activation', tone: 'neutral' as const } : ACCOUNT_BADGE[lead.status];
              const canReissue = invitation && (invitation.status === 'EXPIRED' || invitation.status === 'REVOKED');
              return (
                <li key={lead.id} className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="w-10 h-10 shrink-0 rounded-xl bg-brand-muted text-brand flex items-center justify-center" aria-hidden="true">
                      <ShieldCheck size={18} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-fg truncate">{nameOf(lead)}</span>
                        {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
                        <Badge tone={account.tone}>{account.label}</Badge>
                      </div>
                      <div className="text-xs text-fg-muted truncate">{lead.loginId}</div>
                      <div className="text-xs text-fg-subtle">
                        {invitation?.teamLabel ? `${invitation.teamLabel} · ` : ''}
                        {!invitation
                          ? 'No invitation on record'
                          : invitation.status === 'PENDING'
                            ? `Invitation expires ${formatDate(invitation.expiresAt)}`
                            : invitation.status === 'ACCEPTED'
                              ? `Activated ${formatDate(invitation.acceptedAt ?? invitation.createdAt)}`
                              : invitation.status === 'EXPIRED'
                                ? `Invitation lapsed ${formatDate(invitation.expiresAt)}`
                                : `Invitation ${REVOKED_REASON[invitation.revokedReason ?? 'ADMIN'] ?? 'revoked'}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {invitation?.status === 'PENDING' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<XCircle size={14} aria-hidden="true" />}
                        aria-label={`Revoke invitation for ${nameOf(lead)}`}
                        loading={busyId === lead.id}
                        onClick={() => void revoke(lead)}
                      >
                        Revoke
                      </Button>
                    )}
                    {canReissue && (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<RotateCcw size={14} aria-hidden="true" />}
                        aria-label={`Reissue invitation for ${nameOf(lead)}`}
                        loading={busyId === lead.id}
                        onClick={() => void reissue(lead)}
                      >
                        Reissue
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="text-xs text-fg-subtle flex items-center gap-1.5">
        <KeyRound size={13} aria-hidden="true" />
        Temporary passwords never work on the sign-in page, and are stored only as one-way hashes.
      </p>

      {adding && (
        <AddTeamLeadModal
          onClose={() => setAdding(false)}
          onCreated={(result) => {
            setAdding(false);
            upsert(result.teamLead);
            setShown(result);
            setNotice({ tone: 'success', text: `Added ${nameOf(result.teamLead)} as a Team Lead.` });
          }}
        />
      )}
      {shown && (
        <OneTimeCredentialsModal
          title="Team Lead invitation"
          subtitle={`For ${nameOf(shown.teamLead)}. Share it privately — anyone with both the link and the temporary password can activate this account.`}
          intro="You've been added to SmartConnect as a Team Lead."
          credentials={shown.credentials}
          onClose={() => setShown(null)}
        />
      )}
      {dialog}
    </div>
  );
};
