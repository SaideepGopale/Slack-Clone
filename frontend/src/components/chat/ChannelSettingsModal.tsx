import axios from 'axios';
import { Archive, ArchiveRestore, Crown, Hash, Lock, Megaphone, Search, Shield, UserMinus } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { ROLE_LABELS } from '../../lib/channels';
import type { ChannelDetails, ChannelMemberInfo, ChannelRole, ChannelVisibility } from '../../types';
import { Modal } from '../ui/Modal';

interface ChannelSettingsModalProps {
  details: ChannelDetails;
  currentUserId: string;
  onClose: () => void;
  /** Called with fresh details after any change (the parent re-renders header/composer). */
  onChanged: (details: ChannelDetails) => void;
}

const errorMessage = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

/**
 * Channel settings (Batch 3/D): about/type, archive/restore, members and
 * roles. Every control is shown or enabled from the server-computed
 * `capabilities`; the backend (lib/policy) re-checks every request.
 */
export const ChannelSettingsModal = ({ details, currentUserId, onClose, onChanged }: ChannelSettingsModalProps) => {
  const caps = details.capabilities;
  const [tab, setTab] = useState<'about' | 'members'>('about');
  const [name, setName] = useState(details.name);
  const [topic, setTopic] = useState(details.topic ?? '');
  const [description, setDescription] = useState(details.description ?? '');
  const [visibility, setVisibility] = useState<ChannelVisibility>(details.visibility);
  const [isAnnouncement, setIsAnnouncement] = useState(details.isAnnouncement);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [members, setMembers] = useState<ChannelMemberInfo[] | null>(null);

  const loadMembers = useCallback(async () => {
    try {
      const res = await axios.get<{ members: ChannelMemberInfo[] }>(`/api/channels/${details.id}/members`, {
        params: query.trim() ? { q: query.trim(), limit: 100 } : { limit: 100 },
      });
      setMembers(res.data.members);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not load members.'));
    }
  }, [details.id, query]);

  useEffect(() => {
    if (tab !== 'members') return;
    const timer = setTimeout(loadMembers, 200);
    return () => clearTimeout(timer);
  }, [tab, loadMembers]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (caps.canUpdateSettings && !details.isGeneral && name.trim() !== details.name) body.name = name.trim();
    if (caps.canUpdateInfo && topic.trim() !== (details.topic ?? '')) body.topic = topic.trim();
    if (caps.canUpdateInfo && description.trim() !== (details.description ?? '')) body.description = description.trim();
    if (caps.canChangeType && visibility !== details.visibility) body.visibility = visibility;
    if (caps.canChangeType && isAnnouncement !== details.isAnnouncement) body.isAnnouncement = isAnnouncement;
    if (Object.keys(body).length === 0) return onClose();
    if (body.visibility === 'PRIVATE' && !window.confirm('Make this channel private? People who are not members will no longer see it.')) return;
    setSaving(true);
    try {
      const res = await axios.patch<ChannelDetails>(`/api/channels/${details.id}`, body);
      onChanged(res.data);
      toast.success('Channel updated.');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not update the channel.'));
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async () => {
    const archiving = !details.archived;
    if (archiving && !window.confirm(`Archive #${details.name}? It becomes read-only and leaves channel discovery. Nothing is deleted.`)) return;
    try {
      const res = await axios.post<ChannelDetails>(`/api/channels/${details.id}/${archiving ? 'archive' : 'restore'}`);
      onChanged(res.data);
      toast.success(archiving ? 'Channel archived.' : 'Channel restored.');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not change the archive state.'));
    }
  };

  const changeRole = async (member: ChannelMemberInfo, role: ChannelRole) => {
    if (role === 'admin' && !window.confirm(`Make ${member.user.username} the channel owner? Current owners become moderators.`)) return;
    try {
      await axios.patch(`/api/channels/${details.id}/members/${member.userId}`, { role });
      await loadMembers();
      const fresh = await axios.get<ChannelDetails>(`/api/channels/${details.id}/details`);
      onChanged(fresh.data);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not change the role.'));
    }
  };

  const remove = async (member: ChannelMemberInfo) => {
    if (!window.confirm(`Remove ${member.user.username} from #${details.name}?`)) return;
    try {
      await axios.delete(`/api/channels/${details.id}/members/${member.userId}`);
      await loadMembers();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not remove that person.'));
    }
  };

  const editable = caps.canUpdateInfo || caps.canUpdateSettings;
  const inputClass =
    'w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-violet-500 disabled:bg-gray-50 disabled:text-gray-500';

  return (
    <Modal title={`#${details.name}`} subtitle={details.archived ? 'Archived channel' : 'Channel settings'} onClose={onClose} size="lg">
      <div role="tablist" className="flex gap-1 px-6 border-b border-gray-100">
        {(['about', 'members'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-semibold border-b-2 -mb-px ${tab === t ? 'border-violet-600 text-violet-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}
          >
            {t === 'about' ? 'About' : `Members (${details.memberCount})`}
          </button>
        ))}
      </div>

      {tab === 'about' ? (
        <form onSubmit={save} className="p-6 space-y-4 overflow-y-auto">
          <label className="block">
            <span className="text-xs font-bold text-gray-500">Name</span>
            <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={!caps.canUpdateSettings || details.isGeneral} />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-gray-500">Topic</span>
            <input className={inputClass} value={topic} maxLength={250} placeholder="What's happening right now?" onChange={(e) => setTopic(e.target.value)} disabled={!caps.canUpdateInfo} />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-gray-500">Description</span>
            <textarea className={`${inputClass} resize-none`} rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!caps.canUpdateInfo} />
          </label>

          <fieldset disabled={!caps.canChangeType} className="space-y-2">
            <legend className="text-xs font-bold text-gray-500">Type{details.isGeneral ? ' (General is always public and open)' : ''}</legend>
            <div className="flex gap-2">
              {([['PUBLIC', Hash, 'Public'], ['PRIVATE', Lock, 'Private']] as const).map(([value, Icon, label]) => (
                <label key={value} className={`flex-1 flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold ${visibility === value ? 'border-violet-500 bg-violet-50' : 'border-gray-200'}`}>
                  <input type="radio" name="visibility" checked={visibility === value} onChange={() => setVisibility(value)} className="accent-violet-600" />
                  <Icon size={14} aria-hidden="true" /> {label}
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm font-semibold text-gray-800">
              <input type="checkbox" checked={isAnnouncement} onChange={(e) => setIsAnnouncement(e.target.checked)} className="accent-violet-600" />
              <Megaphone size={14} aria-hidden="true" /> Announcement channel
            </label>
          </fieldset>

          <div className="flex items-center justify-between gap-3 pt-2">
            {caps.canArchive ? (
              <button type="button" onClick={toggleArchive} className="flex items-center gap-2 text-sm font-semibold text-gray-600 hover:text-red-600">
                {details.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                {details.archived ? 'Restore channel' : 'Archive channel'}
              </button>
            ) : (
              <span />
            )}
            {editable && !details.archived && (
              <button type="submit" disabled={saving} className="px-5 py-2.5 bg-violet-600 text-white text-sm font-bold rounded-xl hover:bg-violet-700 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="p-6 space-y-3 overflow-y-auto">
          <label className="flex items-center gap-2 border border-gray-200 rounded-xl px-3 py-2">
            <Search size={14} className="text-gray-400" aria-hidden="true" />
            <input aria-label="Search members" className="flex-1 outline-none text-sm" placeholder="Search members" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {members === null ? (
            <p className="text-sm text-gray-400" role="status">Loading members…</p>
          ) : members.length === 0 ? (
            <p className="text-sm text-gray-400">No members match.</p>
          ) : (
            <ul className="divide-y divide-gray-100" aria-label="Channel members">
              {members.map((m) => {
                const isMe = m.userId === currentUserId;
                const canEditRole = caps.canChangeRoles && !isMe && m.role !== 'admin';
                const canRemove = caps.canRemoveMembers && !isMe && m.role !== 'admin' && (caps.canChangeRoles || m.role === 'member');
                return (
                  <li key={m.userId} className="flex items-center gap-3 py-2">
                    <span className="flex-1 min-w-0 truncate text-sm font-semibold text-gray-900">
                      {m.user.username}
                      {isMe && <span className="text-gray-400 font-normal"> (you)</span>}
                    </span>
                    {canEditRole ? (
                      <>
                        <select
                          aria-label={`Role of ${m.user.username}`}
                          value={m.role}
                          onChange={(e) => changeRole(m, e.target.value as ChannelRole)}
                          className="text-xs border border-gray-200 rounded-lg px-2 py-1"
                        >
                          <option value="member">{ROLE_LABELS.member}</option>
                          <option value="moderator">{ROLE_LABELS.moderator}</option>
                        </select>
                        <button type="button" title="Make owner" aria-label={`Make ${m.user.username} the owner`} onClick={() => changeRole(m, 'admin')} className="p-1.5 text-gray-400 hover:text-amber-600">
                          <Crown size={14} />
                        </button>
                      </>
                    ) : (
                      <span className="flex items-center gap-1 text-xs font-semibold text-gray-500">
                        {m.role === 'admin' ? <Crown size={12} aria-hidden="true" /> : m.role === 'moderator' ? <Shield size={12} aria-hidden="true" /> : null}
                        {ROLE_LABELS[m.role]}
                      </span>
                    )}
                    {canRemove && (
                      <button type="button" aria-label={`Remove ${m.user.username}`} onClick={() => remove(m)} className="p-1.5 text-gray-400 hover:text-red-600">
                        <UserMinus size={14} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
};
