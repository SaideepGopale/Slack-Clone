import type { MemberProvisionResult } from '../../lib/api/teamManagement';
import { OneTimeCredentialsModal } from '../ui/OneTimeCredentialsModal';

/**
 * The one-time result of adding a new team member (Stage 3 provisioning),
 * shared by Workspace settings → Members and the People page (T.36): what
 * happened, and the link, login and temporary password to hand over. No
 * e-mail is involved; the temporary password works only on the activation
 * link, where the member chooses their own password before signing in.
 */
export const MemberCredentialsModal = ({ result, workspaceName, onClose }: { result: MemberProvisionResult; workspaceName: string; onClose: () => void }) => {
  const name = result.invitation.account.displayName || result.invitation.account.username;
  return (
    <OneTimeCredentialsModal
      title="Member invitation"
      subtitle={`Account created for ${name}. They join ${workspaceName} when they activate it — no e-mail is sent. Share these privately: anyone with both the link and the temporary password can activate this account.`}
      intro={`You've been added to SmartConnect as a member of ${workspaceName}.`}
      credentials={result.credentials}
      onClose={onClose}
    />
  );
};
