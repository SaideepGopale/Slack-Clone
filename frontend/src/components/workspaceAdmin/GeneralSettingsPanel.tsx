import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import { DESCRIPTION_MAX, formatDate, NAME_MAX, WorkspaceAdminAccess } from '../../lib/adminAccess';
import { errorMessage, workspacesApi } from '../../lib/api';
import type { ChannelCreationPolicy, WorkspaceSettings } from '../../lib/api';
import { Section } from '../management/PageFrame';
import { Button, Field, TextArea, TextInput } from '../ui';

interface FormValues {
  name: string;
  description: string;
  channelCreationPolicy: ChannelCreationPolicy;
}

const fromSettings = (s: WorkspaceSettings): FormValues => ({
  name: s.name,
  description: s.description ?? '',
  channelCreationPolicy: s.channelCreationPolicy,
});
const same = (a: FormValues, b: FormValues) =>
  a.name === b.name && a.description === b.description && a.channelCreationPolicy === b.channelCreationPolicy;

interface GeneralSettingsPanelProps {
  settings: WorkspaceSettings;
  access: WorkspaceAdminAccess;
  /** Link target for the organization, when it can be shown. */
  organizationPath?: string | null;
  onSaved: (settings: WorkspaceSettings) => void;
}

const POLICIES: { value: ChannelCreationPolicy; label: string; hint: string }[] = [
  { value: 'MEMBERS', label: 'Everyone in the workspace', hint: 'Any member can create channels.' },
  { value: 'ADMINS', label: 'Only admins', hint: 'The owner, workspace admins and organization admins.' },
];

/**
 * Name, description and channel-creation policy. Read-only unless the server
 * says `canUpdateSettings`. Live `workspace:updated` changes (passed in via
 * `settings`) replace the form while it's untouched; if the user is editing,
 * they're told instead of having their input overwritten.
 */
export const GeneralSettingsPanel = ({ settings, access, organizationPath, onSaved }: GeneralSettingsPanelProps) => {
  const [values, setValues] = useState<FormValues>(() => fromSettings(settings));
  const [baseline, setBaseline] = useState<FormValues>(() => fromSettings(settings));
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; description?: string; form?: string }>({});
  const dirty = !same(values, baseline);
  const latest = useRef({ dirty, baseline });
  latest.current = { dirty, baseline };
  const readOnly = !access.canEditSettings;

  useEffect(() => {
    const incoming = fromSettings(settings);
    if (same(latest.current.baseline, incoming)) return;
    if (latest.current.dirty) {
      setRemoteChanged(true);
      return;
    }
    setValues(incoming);
    setBaseline(incoming);
  }, [settings]);

  const discard = () => {
    const incoming = fromSettings(settings);
    setValues(incoming);
    setBaseline(incoming);
    setRemoteChanged(false);
    setErrors({});
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || !dirty) return;
    const name = values.name.trim();
    const description = values.description.trim();
    const nextErrors: typeof errors = {};
    if (!name) nextErrors.name = 'Workspace name is required.';
    else if (name.length > NAME_MAX) nextErrors.name = `Use ${NAME_MAX} characters or fewer.`;
    if (description.length > DESCRIPTION_MAX) nextErrors.description = `Use ${DESCRIPTION_MAX} characters or fewer.`;
    setErrors(nextErrors);
    if (nextErrors.name || nextErrors.description) return;

    const patch: Parameters<typeof workspacesApi.updateWorkspaceSettings>[1] = {};
    if (name !== baseline.name) patch.name = name;
    if (description !== baseline.description) patch.description = description || null;
    if (values.channelCreationPolicy !== baseline.channelCreationPolicy) patch.channelCreationPolicy = values.channelCreationPolicy;
    if (Object.keys(patch).length === 0) {
      setValues(baseline);
      return;
    }
    setSaving(true);
    try {
      const updated = await workspacesApi.updateWorkspaceSettings(settings.id, patch);
      const next = fromSettings(updated);
      setBaseline(next);
      setValues(next);
      setRemoteChanged(false);
      onSaved(updated);
      toast.success('Workspace settings saved.');
    } catch (err) {
      setErrors({ form: errorMessage(err, 'Could not save the settings.') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Section
        title="Workspace details"
        description={readOnly ? 'Only the workspace owner, workspace admins and organization admins can change these settings.' : undefined}
      >
        <form onSubmit={submit} className="space-y-5" noValidate>
          {remoteChanged && (
            <div role="status" className="flex flex-col gap-2 rounded-xl bg-warning-soft p-3 text-sm text-warning sm:flex-row sm:items-center sm:justify-between">
              <span>Someone else changed these settings while you were editing.</span>
              <Button size="sm" variant="secondary" onClick={discard}>
                Load their changes
              </Button>
            </div>
          )}
          <Field label="Name" error={errors.name}>
            <TextInput
              value={values.name}
              maxLength={NAME_MAX}
              disabled={readOnly}
              onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
            />
          </Field>
          <Field label="Description" error={errors.description} hint={`${values.description.length}/${DESCRIPTION_MAX}`}>
            <TextArea
              rows={3}
              value={values.description}
              maxLength={DESCRIPTION_MAX}
              disabled={readOnly}
              placeholder={readOnly ? 'No description' : 'What is this workspace for?'}
              onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))}
            />
          </Field>
          <fieldset disabled={readOnly} className="space-y-2">
            <legend className="text-xs font-bold text-fg-muted mb-1">Who can create channels</legend>
            {POLICIES.map((policy) => (
              <label key={policy.value} className="flex items-start gap-2.5 rounded-xl border border-line p-3 cursor-pointer has-[:checked]:border-brand has-[:checked]:bg-brand-soft has-[:disabled]:cursor-default">
                <input
                  type="radio"
                  name="channelCreationPolicy"
                  value={policy.value}
                  checked={values.channelCreationPolicy === policy.value}
                  onChange={() => setValues((v) => ({ ...v, channelCreationPolicy: policy.value }))}
                  className="mt-0.5 accent-[var(--color-brand)]"
                />
                <span>
                  <span className="block text-sm font-semibold text-fg">{policy.label}</span>
                  <span className="block text-xs text-fg-muted">{policy.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {errors.form && (
            <p role="alert" className="text-sm font-semibold text-danger">
              {errors.form}
            </p>
          )}
          {!readOnly && (
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={discard} disabled={!dirty || saving}>
                Discard
              </Button>
              <Button type="submit" loading={saving} disabled={!dirty}>
                Save changes
              </Button>
            </div>
          )}
        </form>
      </Section>

      <Section title="About">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-bold text-fg-muted">Organization</dt>
            <dd className="text-fg">
              {settings.organization ? (
                organizationPath ? (
                  <Link to={organizationPath} className="text-brand hover:underline">
                    {settings.organization.name}
                  </Link>
                ) : (
                  settings.organization.name
                )
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-bold text-fg-muted">Owner</dt>
            <dd className="text-fg">{settings.owner?.username ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold text-fg-muted">Members</dt>
            <dd className="text-fg">{settings._count.members}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold text-fg-muted">Created</dt>
            <dd className="text-fg">{formatDate(settings.createdAt)}</dd>
          </div>
        </dl>
      </Section>
    </div>
  );
};
