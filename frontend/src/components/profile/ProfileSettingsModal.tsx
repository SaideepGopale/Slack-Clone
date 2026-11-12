import axios from 'axios';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { UserProfileSettings } from '../../types';
import { Modal } from '../ui/Modal';

interface ProfileSettingsModalProps {
  onClose: () => void;
}

const timeZones = (): string[] => {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
};

/**
 * Collaboration profile (title, bio, time zone) and preferences (read
 * receipts). Account credentials are intentionally not editable here.
 */
export const ProfileSettingsModal = ({ onClose }: ProfileSettingsModalProps) => {
  const [form, setForm] = useState<UserProfileSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(timeZones, []);

  useEffect(() => {
    axios
      .get<UserProfileSettings>('/api/users/me/profile')
      .then((res) => setForm(res.data))
      .catch(() => setError('Could not load your profile.'));
  }, []);

  const update = <K extends keyof UserProfileSettings>(key: K, value: UserProfileSettings[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const res = await axios.patch<UserProfileSettings>('/api/users/me/profile', {
        title: form.title ?? '',
        bio: form.bio ?? '',
        timezone: form.timezone ?? '',
        readReceiptsEnabled: form.readReceiptsEnabled,
      });
      setForm(res.data);
      toast.success('Profile saved');
      onClose();
    } catch (err: unknown) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not save your profile.');
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100';

  return (
    <Modal
      title="Profile & preferences"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!form || saving}
            className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Save
          </button>
        </>
      }
    >
      {!form && !error && (
        <p className="py-8 flex justify-center text-gray-400" role="status">
          <Loader2 className="animate-spin" size={20} aria-label="Loading profile" />
        </p>
      )}
      {error && (
        <p className="mb-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      {form && (
        <div className="space-y-4">
          <label className="block">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Title</span>
            <input value={form.title ?? ''} onChange={(e) => update('title', e.target.value)} maxLength={80} placeholder="e.g. Product Designer" className={inputClass} />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">About</span>
            <textarea value={form.bio ?? ''} onChange={(e) => update('bio', e.target.value)} maxLength={500} rows={3} className={`${inputClass} resize-none`} />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Time zone</span>
            {zones.length > 0 ? (
              <select value={form.timezone ?? ''} onChange={(e) => update('timezone', e.target.value || null)} className={inputClass}>
                <option value="">Not set</option>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            ) : (
              <input value={form.timezone ?? ''} onChange={(e) => update('timezone', e.target.value)} placeholder="e.g. Asia/Kolkata" className={inputClass} />
            )}
          </label>
          <label className="flex items-start gap-3 p-3 rounded-lg bg-gray-50">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.readReceiptsEnabled}
              onChange={(e) => update('readReceiptsEnabled', e.target.checked)}
            />
            <span>
              <span className="block text-sm font-semibold text-gray-900">Read receipts</span>
              <span className="block text-xs text-gray-500">
                Let people in direct messages see when you've read their messages. If you turn this off, you won't see theirs either.
              </span>
            </span>
          </label>
        </div>
      )}
    </Modal>
  );
};
