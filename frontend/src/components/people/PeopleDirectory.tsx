import axios from 'axios';
import { Loader2, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspaces } from '../../pages/workspace/WorkspacesProvider';
import { WorkspaceMember } from '../../types';
import { AddWorkspaceMemberButton } from '../workspaceAdmin/AddWorkspaceMemberButton';
import { ProfileModal } from './ProfileModal';

interface PeopleDirectoryProps {
  workspaceId: string;
  currentUserId: string;
  onMessage: (userId: string) => void;
}

interface MembersPage {
  members: WorkspaceMember[];
  nextCursor: string | null;
}

const roleBadge = (m: WorkspaceMember) => (m.isOwner ? 'Owner' : m.role === 'ADMIN' ? 'Admin' : null);

/**
 * Workspace-scoped People directory: server-side search and cursor
 * pagination over this workspace's members only (the old directory listed
 * every account on the platform), live presence, and profile cards.
 */
export const PeopleDirectory = ({ workspaceId, currentUserId, onMessage }: PeopleDirectoryProps) => {
  const [query, setQuery] = useState('');
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // F1: management rights come from the server-computed capabilities in the
  // shared workspace list (they include organization OWNER/ADMIN inheritance),
  // instead of being re-derived here from two extra requests.
  const workspace = useWorkspaces().getWorkspace(workspaceId);
  const viewer = {
    canManage: !!workspace && !workspace.isDefault && !!workspace.capabilities?.canManage,
    // May remove admins too: the workspace owner or an organization OWNER/ADMIN.
    isOwner: !!workspace?.isOwner || workspace?.organizationRole === 'OWNER' || workspace?.organizationRole === 'ADMIN',
    // T.36: may add members here (the same right as Workspace settings → Members).
    canAddMembers: !!workspace && !workspace.isDefault && !!workspace.capabilities?.canManageInvitations,
  };
  const requestRef = useRef(0);

  const load = useCallback(
    async (cursor: string | null) => {
      const requestId = ++requestRef.current;
      setLoading(true);
      try {
        const res = await axios.get<MembersPage>(`/api/workspaces/${workspaceId}/members`, {
          params: { q: query.trim() || undefined, cursor: cursor ?? undefined, limit: 30 },
        });
        if (requestId !== requestRef.current) return; // a newer search superseded this one
        setMembers((prev) => (cursor ? [...prev, ...res.data.members] : res.data.members));
        setNextCursor(res.data.nextCursor);
        setError(null);
      } catch {
        if (requestId === requestRef.current) setError('Could not load people.');
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    },
    [workspaceId, query]
  );

  useEffect(() => {
    const timer = setTimeout(() => load(null), 250);
    return () => clearTimeout(timer);
  }, [load]);


  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative block max-w-xl flex-1">
          <span className="sr-only">Search people</span>
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people by name or email"
            className="w-full bg-white border border-gray-200 rounded-xl py-2.5 pl-10 pr-4 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100"
          />
        </label>
        {workspace && (
          <AddWorkspaceMemberButton
            workspaceId={workspaceId}
            workspaceName={workspace.name}
            canManageInvitations={viewer.canAddMembers}
            onChanged={() => load(null)}
          />
        )}
      </div>

      {error && (
        <p className="text-sm text-red-600 mb-4" role="alert">
          {error}
        </p>
      )}

      {!loading && members.length === 0 && !error ? (
        <p className="py-16 text-center text-sm text-gray-400">{query ? `No people match "${query}".` : 'No members yet.'}</p>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" aria-label="Workspace members">
          {members.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => setSelectedId(m.id)}
                className="w-full flex items-center gap-3 p-4 rounded-xl border border-gray-200 bg-white text-left hover:border-violet-300 hover:shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500"
                aria-label={`View profile of ${m.username}`}
              >
                <span className="relative shrink-0">
                  <span className="w-11 h-11 rounded-xl bg-accent-600 text-white flex items-center justify-center font-bold uppercase">
                    {m.username[0]}
                  </span>
                  <span
                    role="img"
                    aria-label={m.presence ? 'Online' : 'Offline'}
                    className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white ${m.presence ? 'bg-emerald-500' : 'bg-gray-300'}`}
                  />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="font-bold text-gray-900 truncate">
                      {m.username}
                      {m.id === currentUserId && <span className="font-normal text-gray-400"> (you)</span>}
                    </span>
                    {roleBadge(m) && (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-violet-700 bg-violet-50 px-1.5 py-0.5 rounded">
                        {roleBadge(m)}
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-gray-500 truncate">{m.title || m.email}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 flex justify-center">
        {loading ? (
          <Loader2 className="animate-spin text-violet-500" size={20} aria-label="Loading people" role="status" />
        ) : (
          nextCursor && (
            <button type="button" onClick={() => load(nextCursor)} className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-semibold hover:bg-gray-50">
              Load more
            </button>
          )
        )}
      </div>

      {selectedId && (
        <ProfileModal
          workspaceId={workspaceId}
          userId={selectedId}
          currentUserId={currentUserId}
          canManage={viewer.canManage}
          viewerIsOwner={viewer.isOwner}
          onClose={() => setSelectedId(null)}
          onMessage={(id) => {
            setSelectedId(null);
            onMessage(id);
          }}
          onRemoved={(id) => {
            setSelectedId(null);
            setMembers((prev) => prev.filter((m) => m.id !== id));
          }}
        />
      )}
    </div>
  );
};
