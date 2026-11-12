import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'react-toastify';
import { useHierarchy } from '../../hooks/useHierarchy';
import type { MemberProvisionResult } from '../../lib/api/teamManagement';
import { Button } from '../ui';
import { AddMembersModal } from './AddMembersModal';
import { AddTeamMemberModal } from './AddTeamMemberModal';
import { MemberCredentialsModal } from './MemberCredentialsModal';

/**
 * T.36 — "Add member" on a workspace's People page, opening the same flows as
 * Workspace settings → Members:
 *  - a Team Lead who manages the workspace: create a Member account (one-time
 *    activation link and temporary password, no e-mail), or — for an address
 *    that already has an account — add that account directly;
 *  - any other manager: add existing accounts.
 * Shown only to people who may add members; the server enforces every rule.
 */
export const AddWorkspaceMemberButton = ({
  workspaceId,
  workspaceName,
  canManageInvitations,
  onChanged,
}: {
  workspaceId: string;
  workspaceName: string;
  canManageInvitations: boolean;
  onChanged: () => void;
}) => {
  const hierarchy = useHierarchy();
  const canProvision = canManageInvitations && hierarchy?.canProvisionMembers === true;
  const [open, setOpen] = useState(false);
  const [provisioned, setProvisioned] = useState<MemberProvisionResult | null>(null);
  if (!canManageInvitations) return null;

  return (
    <>
      <Button icon={<UserPlus size={15} aria-hidden="true" />} onClick={() => setOpen(true)}>
        Add member
      </Button>
      {open && canProvision && (
        <AddTeamMemberModal
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          onClose={() => setOpen(false)}
          onCreated={(result) => {
            setOpen(false);
            setProvisioned(result);
          }}
          onAddedExisting={() => {
            setOpen(false);
            onChanged();
            toast.success(`Added to ${workspaceName}.`);
          }}
        />
      )}
      {open && !canProvision && <AddMembersModal workspaceId={workspaceId} workspaceName={workspaceName} onClose={() => setOpen(false)} onAdded={onChanged} />}
      {provisioned && <MemberCredentialsModal result={provisioned} workspaceName={workspaceName} onClose={() => setProvisioned(null)} />}
    </>
  );
};
