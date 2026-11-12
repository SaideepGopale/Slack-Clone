import { Link2, Mail, Send, Unlink } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { useApiQuery } from '../../hooks/useApiQuery';
import { formatDate, INVITATION_STATE_LABEL, INVITATION_STATE_TONE } from '../../lib/adminAccess';
import { errorMessage, invitationsApi } from '../../lib/api';
import type { InvitationState } from '../../lib/api';
import { AccessProblem } from '../management/AccessProblem';
import { Section } from '../management/PageFrame';
import { Badge, Button, EmptyState, Field, LoadingState, TextInput, useConfirm } from '../ui';

const FILTERS: ('all' | InvitationState)[] = ['all', 'pending', 'accepted', 'expired', 'revoked'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface InvitationsPanelProps {
  workspaceId: string;
  /** T.36: false when the server has no e-mail provider (from workspace settings). */
  emailInvitationsAvailable?: boolean;
  /** Reports the number of PENDING invitations (Directory tab badge). */
  onPendingCountChange?: (count: number) => void;
}

/**
 * Invite by e-mail, the invitation history (pending / accepted / expired /
 * revoked, computed server-side) with per-invitation revocation, and the
 * shareable invite link. Per-email invitation tokens never reach this
 * component (lib/api/invitations.ts drops them). The backend emits no events
 * for invitations, so the list refreshes after every action and on focus.
 */
export const InvitationsPanel = ({ workspaceId, emailInvitationsAvailable = true, onPendingCountChange }: InvitationsPanelProps) => {
  const invitations = useApiQuery(() => invitationsApi.listWorkspaceInvitations(workspaceId), [workspaceId], { refetchOnFocus: true });
  const [filter, setFilter] = useState<'all' | InvitationState>('all');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState<'copy' | 'revoke' | null>(null);
  const [manualLink, setManualLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const { confirm, dialog } = useConfirm();

  const list = useMemo(() => invitations.data ?? [], [invitations.data]);
  const counts = useMemo(() => {
    const result: Record<string, number> = { all: list.length };
    for (const inv of list) result[inv.state] = (result[inv.state] ?? 0) + 1;
    return result;
  }, [list]);
  const visible = filter === 'all' ? list : list.filter((inv) => inv.state === filter);

  useEffect(() => {
    if (invitations.data) onPendingCountChange?.(counts.pending ?? 0);
  }, [invitations.data, counts.pending, onPendingCountChange]);

  const sendInvite = async (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!EMAIL_PATTERN.test(value)) {
      setEmailError('Enter a valid e-mail address.');
      return;
    }
    setSending(true);
    setEmailError(null);
    try {
      const result = await invitationsApi.inviteByEmail(workspaceId, value);
      setEmail('');
      if (result.emailSent) toast.success(`Invitation sent to ${value}.`);
      else if (result.emailUnavailable) toast.warning(`Invitation saved for ${value}. No e-mail was sent — e-mail delivery isn't configured on this server.`);
      else toast.warning(`Invitation created for ${value}, but the e-mail couldn't be delivered. Share an invite link instead.`);
      await invitations.reload({ silent: true });
    } catch (err) {
      setEmailError(errorMessage(err, 'Could not send the invitation.'));
    } finally {
      setSending(false);
    }
  };

  const revoke = async (id: string, address: string) => {
    const confirmed = await confirm({
      title: 'Revoke this invitation?',
      message: `${address} will no longer be able to join with it. You can invite them again later.`,
      confirmLabel: 'Revoke invitation',
      tone: 'danger',
    });
    if (!confirmed) return;
    setRevokingId(id);
    try {
      await invitationsApi.revokeInvitation(workspaceId, id);
      invitations.setData((prev) => prev?.map((inv) => (inv.id === id ? { ...inv, state: 'revoked' } : inv)));
      toast.success('Invitation revoked.');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not revoke the invitation.'));
      invitations.reload({ silent: true }).catch(() => undefined);
    } finally {
      setRevokingId(null);
    }
  };

  const copyLink = async () => {
    setLinkBusy('copy');
    setManualLink(null);
    try {
      const link = await invitationsApi.getInviteLink(workspaceId);
      try {
        await navigator.clipboard.writeText(link.url);
        toast.success(`Invite link copied. It works until ${formatDate(link.expiresAt)}.`);
      } catch {
        setManualLink(link); // clipboard blocked: show it for manual copying
      }
    } catch (err) {
      toast.error(errorMessage(err, 'Could not get an invite link.'));
    } finally {
      setLinkBusy(null);
    }
  };

  const revokeLinks = async () => {
    const confirmed = await confirm({
      title: 'Revoke all invite links?',
      message: 'Every invite link shared so far stops working immediately. Pending join requests are not affected. You can create a new link afterwards.',
      confirmLabel: 'Revoke all links',
      tone: 'danger',
    });
    if (!confirmed) return;
    setLinkBusy('revoke');
    setManualLink(null);
    try {
      const { revoked } = await invitationsApi.revokeInviteLinks(workspaceId);
      toast.success(revoked === 1 ? '1 invite link revoked.' : `${revoked} invite links revoked.`);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not revoke the invite links.'));
    } finally {
      setLinkBusy(null);
    }
  };

  if (invitations.error && !invitations.data) {
    return <AccessProblem error={invitations.error} resource="workspace" onRetry={() => invitations.reload()} />;
  }

  return (
    <div className="space-y-6">
      {dialog}
      <Section title="Invite by e-mail" description="They'll join as a member. Invitations expire after 14 days and work only for the invited address.">
        {!emailInvitationsAvailable && (
          <p role="note" className="mb-3 rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-sm text-warning">
            E-mail invitations are unavailable: e-mail delivery isn't configured on this server, so no invitation e-mail can be sent. To add someone
            now, go to Members and use <strong>Add team member</strong> (a new account with a one-time activation link — no e-mail) or{' '}
            <strong>Add people</strong> (existing accounts).
          </p>
        )}
        <form onSubmit={sendInvite} className="flex flex-col gap-2 sm:flex-row sm:items-start" noValidate>
          <Field label="E-mail address" error={emailError} className="flex-1">
            <TextInput type="email" autoComplete="off" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" loading={sending} disabled={!email.trim()} icon={<Send size={14} aria-hidden="true" />} className="sm:mt-6">
            {emailInvitationsAvailable ? 'Send invite' : 'Create invitation'}
          </Button>
        </form>
      </Section>

      <Section
        title="Invite link"
        description="Anyone with the link can ask to join; each request waits for approval under Join requests. Links expire after 7 days."
      >
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={copyLink} loading={linkBusy === 'copy'} disabled={linkBusy !== null} icon={<Link2 size={14} aria-hidden="true" />}>
            Copy invite link
          </Button>
          <Button variant="ghost" onClick={revokeLinks} loading={linkBusy === 'revoke'} disabled={linkBusy !== null} icon={<Unlink size={14} aria-hidden="true" />} className="text-danger">
            Revoke all invite links
          </Button>
        </div>
        {manualLink && (
          <Field label="Invite link" hint={`Copy it manually — it works until ${formatDate(manualLink.expiresAt)}.`} className="mt-3">
            <TextInput readOnly value={manualLink.url} onFocus={(e) => e.currentTarget.select()} />
          </Field>
        )}
      </Section>

      <Section title="Invitations" description="Every e-mail invitation for this workspace, newest first.">
        <div role="group" aria-label="Filter invitations by status" className="flex flex-wrap gap-1.5 mb-4">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                filter === f ? 'bg-brand text-on-brand border-brand' : 'bg-surface text-fg-muted border-line hover:text-fg'
              }`}
            >
              {f === 'all' ? 'All' : INVITATION_STATE_LABEL[f]} <span className="opacity-70">{counts[f] ?? 0}</span>
            </button>
          ))}
        </div>
        {invitations.loading && !invitations.data ? (
          <LoadingState label="Loading invitations" />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<Mail size={28} aria-hidden="true" />}
            title={filter === 'all' ? 'No invitations yet' : `No ${INVITATION_STATE_LABEL[filter as InvitationState].toLowerCase()} invitations`}
            description={filter === 'all' ? 'Invitations you send by e-mail appear here with their status.' : undefined}
          />
        ) : (
          <ul aria-label="Invitations" className="divide-y divide-line border border-line rounded-xl overflow-hidden">
            {visible.map((inv) => (
              <li key={inv.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-sm text-fg break-all">{inv.email}</span>
                    <Badge tone={INVITATION_STATE_TONE[inv.state]}>{INVITATION_STATE_LABEL[inv.state]}</Badge>
                  </div>
                  <p className="text-xs text-fg-muted mt-0.5">
                    Sent {formatDate(inv.createdAt)}
                    {inv.inviter ? ` by ${inv.inviter.username}` : ''}
                    {inv.state === 'pending' ? ` · expires ${formatDate(inv.expiresAt)}` : ''}
                  </p>
                </div>
                {inv.state === 'pending' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => revoke(inv.id, inv.email)}
                    loading={revokingId === inv.id}
                    aria-label={`Revoke invitation for ${inv.email}`}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
};
