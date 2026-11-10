import axios from 'axios';
import { Check, Loader2, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { WorkspaceMember } from '../../types';

interface MemberPickerProps {
  workspaceId: string;
  selected: WorkspaceMember[];
  onChange: (selected: WorkspaceMember[]) => void;
  // Ids that must not be offered (yourself, people already in the conversation).
  excludeIds?: string[];
  max?: number;
  label?: string;
}

/** Server-side search over the workspace's members, with multi-select. */
export const MemberPicker = ({ workspaceId, selected, onChange, excludeIds = [], max = Infinity, label = 'Search people' }: MemberPickerProps) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WorkspaceMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const excludeKey = excludeIds.join(',');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      axios
        .get<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspaceId}/members`, { params: { q: query || undefined, limit: 25 } })
        .then((res) => {
          if (cancelled) return;
          const excluded = new Set(excludeKey ? excludeKey.split(',') : []);
          setResults(res.data.members.filter((m) => !excluded.has(m.id)));
          setError(null);
        })
        .catch(() => !cancelled && setError('Could not load people.'))
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [workspaceId, query, excludeKey]);

  const selectedIds = new Set(selected.map((m) => m.id));
  const toggle = (member: WorkspaceMember) => {
    if (selectedIds.has(member.id)) onChange(selected.filter((m) => m.id !== member.id));
    else if (selected.length < max) onChange([...selected, member]);
  };

  return (
    <div>
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 mb-3" aria-label="Selected people">
          {selected.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => toggle(m)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-violet-100 text-violet-800 text-xs font-semibold hover:bg-violet-200"
                aria-label={`Remove ${m.username}`}
              >
                {m.username} <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="relative block">
        <span className="sr-only">{label}</span>
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or email"
          className="w-full bg-white border border-gray-200 rounded-lg py-2.5 pl-9 pr-3 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100"
        />
      </label>
      <div className="mt-2 max-h-64 overflow-y-auto" aria-live="polite">
        {loading ? (
          <p className="py-6 flex items-center justify-center gap-2 text-sm text-gray-400" role="status">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Searching…
          </p>
        ) : error ? (
          <p className="py-6 text-center text-sm text-red-600" role="alert">{error}</p>
        ) : results.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-400">No people found.</p>
        ) : (
          <ul className="flex flex-col" aria-label="People">
            {results.map((m) => {
              const isSelected = selectedIds.has(m.id);
              const disabled = !isSelected && selected.length >= max;
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => toggle(m)}
                    disabled={disabled}
                    aria-pressed={isSelected}
                    className="w-full flex items-center gap-3 px-2 py-2 rounded-lg text-left hover:bg-gray-50 disabled:opacity-40"
                  >
                    <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 text-white flex items-center justify-center text-xs font-bold uppercase shrink-0">
                      {m.username[0]}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold text-gray-900 truncate">{m.username}</span>
                      <span className="block text-xs text-gray-500 truncate">{m.title || m.email}</span>
                    </span>
                    {isSelected && <Check size={16} className="text-violet-600" aria-hidden="true" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};
