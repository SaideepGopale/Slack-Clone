import { Check, Search, UserPlus, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorMessage, workspacesApi } from '../../lib/api';
import type { MemberCandidate } from '../../lib/api/workspaces';
import { Button, EmptyState, Spinner, TextInput } from '../ui';
import { Modal } from '../ui/Modal';

/**
 * P2: a workspace manager adds existing registered accounts directly — no
 * e-mail and no invitation link. Only this workspace is granted; the server
 * re-checks the manager's rights and refuses duplicates or inactive accounts.
 */
export const AddMembersModal = ({ workspaceId, workspaceName, onClose, onAdded }: {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
  onAdded: () => void;
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemberCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, 'adding' | 'added' | string>>({});
  const ticket = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    const mine = ++ticket.current;
    setSearching(true);
    const timer = setTimeout(() => {
      workspacesApi
        .searchMemberCandidates(workspaceId, q)
        .then((res) => {
          if (mine !== ticket.current) return;
          setResults(res.users);
          setError(null);
        })
        .catch((err) => mine === ticket.current && setError(errorMessage(err, 'Search failed.')))
        .finally(() => mine === ticket.current && setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, workspaceId]);

  const add = async (candidate: MemberCandidate) => {
    setState((s) => ({ ...s, [candidate.id]: 'adding' }));
    try {
      await workspacesApi.addWorkspaceMember(workspaceId, candidate.id);
      setState((s) => ({ ...s, [candidate.id]: 'added' }));
      onAdded();
    } catch (err) {
      setState((s) => ({ ...s, [candidate.id]: errorMessage(err, 'Could not add this person.') }));
    }
  };

  return (
    <Modal title="Add people" subtitle={`Add registered colleagues to ${workspaceName}. They get access right away.`} onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <div className="space-y-4">
        <label className="relative block">
          <span className="sr-only">Search people</span>
          <Search size={16} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <TextInput type="search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, username or exact login" className="pl-9" />
        </label>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {!query.trim() ? (
          <p className="text-sm text-fg-muted">Type a name to find people who aren't in this workspace yet.</p>
        ) : searching && results.length === 0 ? (
          <div className="flex justify-center py-6"><Spinner label="Searching" /></div>
        ) : results.length === 0 ? (
          <EmptyState icon={<Users size={24} aria-hidden="true" />} title="No one found" description="They may already be a member, or their account may not be active." />
        ) : (
          <ul aria-label="People you can add" className="divide-y divide-line border border-line rounded-xl overflow-hidden">
            {results.map((c) => {
              const status = state[c.id];
              const failed = status && status !== 'adding' && status !== 'added' ? status : null;
              return (
                <li key={c.id} className="flex items-center gap-3 px-3 py-2.5 bg-surface">
                  <div className="w-9 h-9 rounded-lg bg-brand-muted text-brand font-bold flex items-center justify-center shrink-0" aria-hidden="true">
                    {(c.displayName || c.username).charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-fg truncate">{c.displayName || c.username}</div>
                    <div className="text-xs text-fg-subtle truncate">@{c.username}</div>
                    {failed && <div role="alert" className="text-xs text-danger mt-0.5">{failed}</div>}
                  </div>
                  {status === 'added' ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-success"><Check size={14} aria-hidden="true" /> Added</span>
                  ) : (
                    <Button size="sm" variant="secondary" loading={status === 'adding'} icon={<UserPlus size={14} aria-hidden="true" />} onClick={() => add(c)} aria-label={`Add ${c.username}`}>
                      Add
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
};
