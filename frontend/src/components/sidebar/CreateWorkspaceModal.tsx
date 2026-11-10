import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { NAME_MAX } from '../../lib/adminAccess';
import { errorMessage, organizationsApi, workspacesApi } from '../../lib/api';
import type { OrganizationSummary } from '../../lib/api';
import { Workspace } from '../../types';
import { Button, Field, Modal, TextArea, TextInput } from '../ui';

interface CreateWorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (workspace: Workspace) => void;
  /**
   * Create inside this organization (organization page). Without it the user
   * chooses: a new organization (previous behaviour) or one they manage.
   */
  organization?: { id: string; name: string };
}

const NEW_ORGANIZATION = '';

/**
 * F2: organization-aware workspace creation on the accessible ui/Modal.
 * Only organizations whose server capabilities allow creating workspaces are
 * offered; the server re-checks (organization OWNER/ADMIN).
 */
export const CreateWorkspaceModal = ({ isOpen, onClose, onCreated, organization }: CreateWorkspaceModalProps) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState(''); // Stage 3 (T.22): optional
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [organizationId, setOrganizationId] = useState<string>(organization?.id ?? NEW_ORGANIZATION);
  const navigate = useNavigate();

  useEffect(() => {
    if (!isOpen) return;
    setOrganizationId(organization?.id ?? NEW_ORGANIZATION);
    if (organization) return;
    let cancelled = false;
    organizationsApi
      .listOrganizations()
      .then((list) => {
        if (!cancelled) setOrganizations(list.filter((o) => o.capabilities?.canCreateWorkspace));
      })
      .catch(() => {
        if (!cancelled) setOrganizations([]); // still possible: a new organization
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, organization]);

  if (!isOpen) return null;

  const resetAndClose = () => {
    setName('');
    setDescription('');
    setError(null);
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Workspace name is required.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const trimmedDescription = description.trim();
      const res = await workspacesApi.createWorkspace({
        name: trimmedName,
        ...(organizationId ? { organizationId } : {}),
        ...(trimmedDescription ? { description: trimmedDescription } : {}),
      });
      onCreated?.(res.workspace);
      resetAndClose();
      // The workspace's own index route resolves straight into its General
      // channel (see WorkspaceIndex.tsx) — no need to know the channel id here.
      navigate(`/${res.workspace.id}`);
      toast.success(`"${res.workspace.name}" created!`);
    } catch (err) {
      setError(errorMessage(err, 'Failed to create workspace.'));
    } finally {
      setCreating(false);
    }
  };

  const target = organization ?? organizations.find((o) => o.id === organizationId);

  return (
    <Modal
      title="Create a workspace"
      subtitle={organization ? `In ${organization.name}` : 'A new home for your team'}
      onClose={resetAndClose}
      footer={
        <>
          <Button variant="secondary" onClick={resetAndClose} disabled={creating}>
            Cancel
          </Button>
          <Button type="submit" form="create-workspace-form" loading={creating} disabled={!name.trim()}>
            Create Workspace
          </Button>
        </>
      }
    >
      <form id="create-workspace-form" onSubmit={handleSubmit} className="space-y-4">
        <Field
          label="Workspace name"
          error={error}
          hint={`You'll be its owner, and we'll set up a "General" channel automatically.`}
        >
          <TextInput autoFocus maxLength={NAME_MAX} placeholder="Acme Corp" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description (optional)" hint="What this team works on. Up to 500 characters.">
          <TextArea maxLength={500} rows={2} placeholder="Where the design team works" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {!organization && organizations.length > 0 && (
          <Field
            label="Organization"
            hint={target ? `Organization admins of ${target.name} will be able to manage it.` : 'A new organization with the same name, owned by you.'}
          >
            <select
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
              className="w-full bg-surface border border-line rounded-xl px-3 py-2.5 text-sm text-fg outline-none focus:border-brand focus:ring-2 focus:ring-brand-muted"
            >
              <option value={NEW_ORGANIZATION}>New organization</option>
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </form>
    </Modal>
  );
};
