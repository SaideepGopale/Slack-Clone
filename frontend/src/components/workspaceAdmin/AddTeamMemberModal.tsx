import { Copy, UserPlus } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { errorMessage, invitationsApi, teamManagementApi, toApiError, workspacesApi } from '../../lib/api';
import type { MemberProvisionConflict, MemberProvisionResult } from '../../lib/api/teamManagement';
import { Button, Field, Modal, TextInput } from '../ui';

/**
 * Stage 3 (T.22) — a Team Lead adds a member to one of their workspaces.
 *  - New e-mail: the server creates an ordinary Member account (SUSPENDED
 *    until activation) and returns one-time credentials (onCreated).
 *  - Existing account: never a second account. Offer the existing,
 *    authorized paths instead: add them directly, or share the workspace's
 *    reusable invite link (they sign in and the lead approves the request).
 * Only e-mail and display name are sent — no role of any kind.
 */
export const AddTeamMemberModal = ({
  workspaceId,
  workspaceName,
  onClose,
  onCreated,
  onAddedExisting,
}: {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
  onCreated: (result: MemberProvisionResult) => void;
  onAddedExisting: () => void;
}) => {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<NonNullable<MemberProvisionConflict['user']> | null>(null);
  const [linkState, setLinkState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const ready = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    setExisting(null);
    try {
      const result = await teamManagementApi.addTeamMember(workspaceId, {
        email: email.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      onCreated(result);
    } catch (err) {
      const conflict = toApiError(err).data as MemberProvisionConflict | undefined;
      if (conflict?.existingAccount && conflict.user) setExisting(conflict.user);
      else setError(errorMessage(err, 'Could not add the member.'));
      setSaving(false);
    }
  };

  const existingName = existing ? existing.displayName || existing.username : '';

  const addExisting = async () => {
    if (!existing) return;
    setSaving(true);
    setError(null);
    try {
      await workspacesApi.addWorkspaceMember(workspaceId, existing.id);
      onAddedExisting();
    } catch (err) {
      setError(errorMessage(err, 'Could not add them to the workspace.'));
      setSaving(false);
    }
  };

  const copyInviteLink = async () => {
    try {
      const { url } = await invitationsApi.getInviteLink(workspaceId);
      await navigator.clipboard.writeText(url);
      setLinkState('copied');
    } catch {
      setLinkState('failed');
    }
  };

  return (
    <Modal
      title="Add team member"
      subtitle={`New people get a Member account for ${workspaceName} with a single-use activation link and temporary password. No e-mail is sent.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="add-team-member-form" loading={saving && !existing} disabled={!ready || !!existing} icon={<UserPlus size={15} aria-hidden="true" />}>
            Create member
          </Button>
        </>
      }
    >
      <form id="add-team-member-form" onSubmit={submit} className="space-y-4" noValidate>
        {error && <p role="alert" className="text-sm text-danger bg-danger-soft rounded-lg px-3 py-2">{error}</p>}
        <Field label="E-mail address" hint="Becomes their login. They activate the account themselves.">
          <TextInput type="email" autoComplete="off" autoFocus value={email} onChange={(e) => { setEmail(e.target.value); setExisting(null); }} placeholder="mia@company.com" />
        </Field>
        <Field label="Display name (optional)">
          <TextInput autoComplete="off" maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Mia Chen" />
        </Field>
      </form>
      {existing && (
        <div className="mt-4 rounded-xl border border-line bg-surface-secondary p-4 space-y-3" role="status">
          <p className="text-sm text-fg">
            <strong>{existingName}</strong> already has an account, so no new account is created. Add them to {workspaceName} now, or share the
            workspace's invite link — they sign in and you approve their request.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void addExisting()} loading={saving} icon={<UserPlus size={14} aria-hidden="true" />}>
              {`Add ${existingName} to ${workspaceName}`}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void copyInviteLink()} icon={<Copy size={14} aria-hidden="true" />}>
              Copy invite link
            </Button>
          </div>
          {linkState !== 'idle' && (
            <p className={`text-xs font-semibold ${linkState === 'copied' ? 'text-success' : 'text-danger'}`}>
              {linkState === 'copied' ? 'Invite link copied. It works for existing accounts only.' : 'Could not copy the invite link.'}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
};
