import { FormEvent, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { NAME_MAX } from '../../lib/adminAccess';
import { errorMessage, organizationsApi } from '../../lib/api';
import type { OrganizationDetails } from '../../lib/api';
import { Section } from '../management/PageFrame';
import { Button, Field, TextInput } from '../ui';

interface OrganizationSettingsPanelProps {
  organization: OrganizationDetails;
  onRenamed: (name: string) => void;
}

/**
 * Rename (organization OWNER/ADMIN). Deleting organizations and transferring
 * ownership are not supported by the backend, so they aren't offered.
 */
export const OrganizationSettingsPanel = ({ organization, onRenamed }: OrganizationSettingsPanelProps) => {
  const [name, setName] = useState(organization.name);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live rename by someone else: follow it unless the user is typing.
  useEffect(() => {
    if (!touched) setName(organization.name);
  }, [organization.name, touched]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Organization name is required.');
      return;
    }
    if (trimmed === organization.name) {
      setTouched(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await organizationsApi.renameOrganization(organization.id, trimmed);
      onRenamed(updated.name);
      setTouched(false);
      toast.success('Organization renamed.');
    } catch (err) {
      setError(errorMessage(err, 'Could not rename the organization.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Organization name" description="Shown to everyone in the organization and in the workspace switcher.">
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-start" noValidate>
        <Field label="Name" error={error} className="flex-1">
          <TextInput
            value={name}
            maxLength={NAME_MAX}
            onChange={(e) => {
              setName(e.target.value);
              setTouched(true);
            }}
          />
        </Field>
        <Button type="submit" loading={saving} disabled={!name.trim() || name.trim() === organization.name} className="sm:mt-6">
          Save
        </Button>
      </form>
      <p className="text-xs text-fg-subtle mt-4">Organizations can’t be deleted, and ownership can’t be transferred yet.</p>
    </Section>
  );
};
