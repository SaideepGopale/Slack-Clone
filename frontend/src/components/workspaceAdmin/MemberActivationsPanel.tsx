import { RotateCcw, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { errorMessage, teamManagementApi } from '../../lib/api';
import type { InvitationStatus, MemberInvitation, MemberProvisionResult } from '../../lib/api/teamManagement';
import { Badge, Button, OneTimeCredentialsModal, useConfirm } from '../ui';
import type { BadgeTone } from '../ui';

/**
 * Stage 3 (T.22) — the activation status of members a Team Lead provisioned
 * into this workspace: revoke pending invitations, reissue expired or revoked
 * ones (new credentials shown once). Server-side: the lead must manage this
 * workspace, and an invitation is only reachable through its own workspace.
 */
const STATUS: Record<InvitationStatus, { label: string; tone: BadgeTone }> = {
  PENDING: { label: 'Pending', tone: 'warning' },
  ACCEPTED: { label: 'Accepted', tone: 'success' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  REVOKED: { label: 'Revoked', tone: 'danger' },
};
const nameOf = (i: MemberInvitation) => i.account.displayName || i.account.username;
const formatDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const MemberActivationsPanel = ({ workspaceId, refreshKey = 0 }: { workspaceId: string; refreshKey?: number }) => {
  const [invitations, setInvitations] = useState<MemberInvitation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState<MemberProvisionResult | null>(null);
  const { confirm, dialog } = useConfirm();

  const load = useCallback(async () => {
    try {
      setInvitations((await teamManagementApi.listMemberInvitations(workspaceId)).invitations);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Could not load member invitations.'));
    }
  }, [workspaceId]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const replace = (old: string, next: MemberInvitation) => setInvitations((list) => (list ?? []).map((i) => (i.id === old ? next : i)));

  const revoke = async (invitation: MemberInvitation) => {
    const ok = await confirm({
      title: 'Revoke invitation?',
      message: `${nameOf(invitation)}'s activation link and temporary password will stop working immediately. You can issue a new one later.`,
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(invitation.id);
    try {
      replace(invitation.id, (await teamManagementApi.revokeMemberInvitation(workspaceId, invitation.id)).invitation);
    } catch (err) {
      setError(errorMessage(err, 'Could not revoke the invitation.'));
    } finally {
      setBusy(null);
    }
  };

  const reissue = async (invitation: MemberInvitation) => {
    setBusy(invitation.id);
    try {
      const result = await teamManagementApi.reissueMemberInvitation(workspaceId, invitation.id);
      replace(invitation.id, result.invitation);
      setShown(result);
    } catch (err) {
      setError(errorMessage(err, 'Could not reissue the invitation.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Member activations" className="bg-surface border border-line rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-line flex items-center justify-between">
        <h3 className="text-sm font-bold text-fg">Member activations</h3>
        <span className="text-xs text-fg-subtle">New members join this workspace once they activate their account.</span>
      </div>
      {error && <p role="alert" className="text-sm text-danger bg-danger-soft px-4 py-2">{error}</p>}
      {invitations && invitations.length === 0 && <p className="px-4 py-6 text-sm text-fg-muted">No member invitations yet.</p>}
      {invitations && invitations.length > 0 && (
        <ul className="divide-y divide-line">
          {invitations.map((invitation) => {
            const status = STATUS[invitation.status];
            const awaiting = invitation.account.status === 'SUSPENDED' && invitation.status !== 'ACCEPTED';
            return (
              <li key={invitation.id} className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-fg truncate">{nameOf(invitation)}</span>
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <Badge tone={awaiting ? 'neutral' : invitation.account.status === 'ACTIVE' ? 'success' : 'warning'}>
                      {awaiting ? 'Awaiting activation' : invitation.account.status === 'ACTIVE' ? 'Active' : 'Suspended'}
                    </Badge>
                  </div>
                  <div className="text-xs text-fg-muted truncate">{invitation.account.loginId}</div>
                  <div className="text-xs text-fg-subtle">
                    {invitation.status === 'ACCEPTED' && invitation.acceptedAt ? `Activated ${formatDate(invitation.acceptedAt)}` : `Expires ${formatDate(invitation.expiresAt)}`}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  {invitation.status === 'PENDING' && (
                    <Button size="sm" variant="secondary" icon={<XCircle size={14} aria-hidden="true" />} aria-label={`Revoke invitation for ${nameOf(invitation)}`} loading={busy === invitation.id} onClick={() => void revoke(invitation)}>
                      Revoke
                    </Button>
                  )}
                  {(invitation.status === 'EXPIRED' || invitation.status === 'REVOKED') && (
                    <Button size="sm" variant="secondary" icon={<RotateCcw size={14} aria-hidden="true" />} aria-label={`Reissue invitation for ${nameOf(invitation)}`} loading={busy === invitation.id} onClick={() => void reissue(invitation)}>
                      Reissue
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {shown && (
        <OneTimeCredentialsModal
          title="Member invitation"
          subtitle={`For ${nameOf(shown.invitation)}. Share it privately — anyone with both the link and the temporary password can activate this account.`}
          intro="You've been added to SmartConnect as a team member."
          credentials={shown.credentials}
          onClose={() => setShown(null)}
        />
      )}
      {dialog}
    </section>
  );
};
