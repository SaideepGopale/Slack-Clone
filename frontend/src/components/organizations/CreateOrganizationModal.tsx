import { FormEvent, useState } from 'react';
import { NAME_MAX } from '../../lib/adminAccess';
import { errorMessage, organizationsApi } from '../../lib/api';
import type { OrganizationDetails } from '../../lib/api';
import { Button, Field, Modal, TextInput } from '../ui';

interface CreateOrganizationModalProps {
  onClose: () => void;
  onCreated: (organization: OrganizationDetails) => void;
}

/** POST /api/organizations — the creator becomes its OWNER. */
export const CreateOrganizationModal = ({ onClose, onCreated }: CreateOrganizationModalProps) => {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Organization name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onCreated(await organizationsApi.createOrganization(trimmed));
    } catch (err) {
      setError(errorMessage(err, 'Could not create the organization.'));
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Create an organization"
      subtitle="Group workspaces and manage them together"
      onClose={() => !saving && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="create-organization-form" loading={saving} disabled={!name.trim()}>
            Create organization
          </Button>
        </>
      }
    >
      <form id="create-organization-form" onSubmit={submit} noValidate>
        <Field label="Organization name" error={error} hint="You'll be its owner. You can add workspaces to it next.">
          <TextInput value={name} maxLength={NAME_MAX} placeholder="Acme Inc." onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
};
