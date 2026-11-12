import { AlertTriangle } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { errorMessage, workspacesApi } from '../../lib/api';
import { useWorkspaces } from '../../pages/workspace/WorkspacesProvider';
import { Button, Field, Modal, TextInput } from '../ui';

interface DeleteWorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceId: string;
  workspaceName: string;
  /** Where to go afterwards. Default: "/" (WorkspaceRedirect picks the next workspace). */
  onDeleted?: () => void;
}

/**
 * Irreversible: deletion is owner-level on the server (workspace OWNER or
 * organization OWNER/ADMIN, never the Default Workspace). F2: accessible
 * dialog (ui/Modal) and the workspace name must be typed to confirm.
 */
export const DeleteWorkspaceModal = ({ isOpen, onClose, workspaceId, workspaceName, onDeleted }: DeleteWorkspaceModalProps) => {
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { remove } = useWorkspaces();

  if (!isOpen) return null;

  const matches = typed.trim() === workspaceName.trim();
  const close = () => {
    if (deleting) return;
    setTyped('');
    setError(null);
    onClose();
  };

  const handleDelete = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!matches || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await workspacesApi.deleteWorkspace(workspaceId);
      // Drop it from the shared list first, or "/" would redirect straight back (F1).
      remove(workspaceId);
      toast.success(`"${workspaceName}" deleted.`);
      setTyped('');
      setDeleting(false);
      onClose();
      if (onDeleted) onDeleted();
      else navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Failed to delete workspace.'));
      setDeleting(false);
    }
  };

  return (
    <Modal
      title={`Delete "${workspaceName}"?`}
      subtitle="This cannot be undone"
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => handleDelete()} loading={deleting} disabled={!matches}>
            Delete Workspace
          </Button>
        </>
      }
    >
      <form onSubmit={handleDelete} className="space-y-4">
        <div className="flex gap-3 rounded-xl bg-danger-soft p-3 text-sm text-danger">
          <AlertTriangle size={18} aria-hidden="true" className="shrink-0 mt-0.5" />
          <p>
            Every channel, message, membership and pending invitation in this workspace will be deleted. Everyone in it loses
            access immediately.
          </p>
        </div>
        <Field label={`Type "${workspaceName}" to confirm`} error={error}>
          <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
      </form>
    </Modal>
  );
};
