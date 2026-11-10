import { formatDistanceToNow } from 'date-fns';
import { Search, X } from 'lucide-react';
import { KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { activityApi, ApiError, channelsApi, errorMessage } from '../../lib/api';
import { conversationLabel } from '../../lib/api/activity';
import { MessageFocusTarget, requestMessageFocus } from '../../lib/messageFocus';
import { htmlToText, truncate } from '../../lib/messages';
import { Spinner } from '../ui';

export interface SearchScope {
  id: string;
  name: string;
  isDM: boolean;
}

const MIN_QUERY = 2;
const DEBOUNCE_MS = 300;

// One shape for both search modes.
interface Hit {
  id: string;
  parentId: string | null;
  createdAt: string;
  sender: string;
  snippet: string;
  channelId: string;
  /** Set in workspace mode: which conversation the match is in. */
  where?: string;
}

/**
 * Header search, scoped to the open channel or DM (approved F1 decision:
 * there is no global search API, so none is invented). Uses the existing
 * membership-checked GET /api/channels/:id/search. ARIA combobox + listbox;
 * choosing a result asks ChatArea to show that message.
 */
interface ChannelSearchProps {
  scope: SearchScope | null;
  /**
   * P2 Phase I: when given, the box can also search every conversation the
   * caller belongs to in this workspace (and does so when none is open).
   */
  workspace?: { id: string; name: string } | null;
  /** Opens a match in another conversation (navigate + focus). */
  onOpenResult?: (target: MessageFocusTarget) => void;
}

export const ChannelSearch = ({ scope, workspace = null, onOpenResult }: ChannelSearchProps) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Hit[] | null>(null);
  const [everywhere, setEverywhere] = useState(false);
  const workspaceMode = !!workspace && (everywhere || !scope);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const requestRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A different conversation starts a fresh search.
  useEffect(() => {
    setQuery('');
    setResults(null);
    setError(null);
    setOpen(false);
    setEverywhere(false);
  }, [scope?.id]);

  useEffect(() => {
    const q = query.trim();
    if ((!scope && !workspaceMode) || q.length < MIN_QUERY) {
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }
    const requestId = ++requestRef.current;
    setLoading(true);
    const timer = setTimeout(() => {
      const search: Promise<Hit[]> = workspaceMode
        ? activityApi.searchWorkspace(workspace!.id, q).then((res) =>
            res.results.map((r) => ({
              id: r.id,
              parentId: r.parentId,
              createdAt: r.createdAt,
              sender: r.sender.username,
              snippet: r.preview,
              channelId: r.channel.id,
              where: conversationLabel(r.channel),
            }))
          )
        : channelsApi.searchChannelMessages(scope!.id, q).then((found) =>
            found.map((m) => ({
              id: m.id,
              parentId: m.parentId ?? null,
              createdAt: m.createdAt,
              sender: m.sender?.username ?? 'Unknown',
              snippet: truncate(htmlToText(m.content) || (m.fileName ? `Attachment: ${m.fileName}` : 'Message'), 140),
              channelId: scope!.id,
            }))
          );
      search
        .then((found) => {
          if (requestId !== requestRef.current) return;
          setResults(found);
          setError(null);
          setActive(found.length ? 0 : -1);
        })
        .catch((err: unknown) => {
          if (requestId !== requestRef.current) return;
          setResults(null);
          setError(
            !workspaceMode && err instanceof ApiError && (err.isForbidden || err.isNotFound)
              ? 'Join this channel to search its messages.'
              : errorMessage(err, 'Search failed. Please try again.')
          );
        })
        .finally(() => {
          if (requestId === requestRef.current) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, scope, workspaceMode, workspace]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const choose = (hit: Hit) => {
    const target = { channelId: hit.channelId, messageId: hit.id, parentId: hit.parentId };
    if (hit.channelId === scope?.id) requestMessageFocus(target);
    else if (onOpenResult) onOpenResult(target);
    else return;
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const count = results?.length ?? 0;
    if (e.key === 'ArrowDown' && count) {
      setOpen(true);
      setActive((i) => (i + 1) % count);
    } else if (e.key === 'ArrowUp' && count) {
      setActive((i) => (i - 1 + count) % count);
    } else if (e.key === 'Enter' && results && active >= 0 && results[active]) {
      choose(results[active]);
    } else if (e.key === 'Escape') {
      if (open) setOpen(false);
      else setQuery('');
    } else {
      return;
    }
    e.preventDefault();
  };

  const scopeLabel = workspaceMode ? workspace!.name : scope ? (scope.isDM ? scope.name : `#${scope.name}`) : null;
  const showPanel = open && (!!scope || workspaceMode) && query.trim().length >= MIN_QUERY;
  // The listbox exists only when there is something to choose from.
  const showList = showPanel && !loading && !error && !!results?.length;
  const optionId = (index: number) => `${listId}-option-${index}`;

  return (
    <div ref={containerRef} className="w-full max-w-2xl px-2 md:px-4 relative group">
      <div className="absolute left-6 md:left-8 top-1/2 -translate-y-1/2 text-gray-300 group-focus-within:text-white pointer-events-none transition-all z-10">
        <Search size={16} aria-hidden="true" />
      </div>
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label={scopeLabel ? `Search messages in ${scopeLabel}` : 'Search messages'}
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? optionId(active) : undefined}
        disabled={!scope && !workspaceMode}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={scopeLabel ? `Search messages in ${scopeLabel}` : 'Open a channel or conversation to search it'}
        className="w-full bg-white/10 backdrop-blur-sm border border-white/20 focus:border-white/40 focus:bg-white/20 rounded-xl py-2.5 pl-10 md:pl-12 pr-9 text-sm text-white placeholder-gray-300 outline-none transition-all placeholder:font-normal shadow-inner disabled:opacity-60 disabled:cursor-not-allowed [&::-webkit-search-cancel-button]:hidden"
      />
      {query && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setQuery('');
            inputRef.current?.focus();
          }}
          className="absolute right-4 md:right-6 top-1/2 -translate-y-1/2 p-1 rounded text-gray-300 hover:text-white"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}

      {showPanel && (
        <div className="absolute left-2 right-2 md:left-4 md:right-4 top-full mt-2 bg-surface text-fg rounded-xl shadow-2xl border border-line z-50 max-h-[60vh] overflow-y-auto">
          {workspace && scope && (
            <div className="flex items-center gap-1 px-3 pt-3 pb-1" role="group" aria-label="Search in">
              {[
                { all: false, label: scope.isDM ? scope.name : `#${scope.name}` },
                { all: true, label: `All of ${workspace.name}` },
              ].map((option) => (
                <button
                  key={String(option.all)}
                  type="button"
                  aria-pressed={everywhere === option.all}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setEverywhere(option.all)}
                  className={`px-2.5 py-1 rounded-md text-xs font-semibold truncate max-w-[50%] ${
                    everywhere === option.all ? 'bg-brand text-on-brand' : 'text-fg-muted hover:bg-surface-tertiary'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          {loading && (
            <div className="flex items-center gap-2 px-4 py-3 text-sm text-fg-muted">
              <Spinner size={16} label="Searching" /> Searching {scopeLabel}…
            </div>
          )}
          {!loading && error && (
            <p role="alert" className="px-4 py-3 text-sm text-danger">
              {error}
            </p>
          )}
          {!loading && !error && results && results.length === 0 && (
            <p className="px-4 py-3 text-sm text-fg-muted">No messages in {scopeLabel} match "{query.trim()}".</p>
          )}
          {showList && (
          <ul id={listId} role="listbox" aria-label={`Messages in ${scopeLabel} matching ${query.trim()}`} className="py-1">
            {results!.map((m, index) => (
                <li
                  key={m.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(m)}
                  className={`px-4 py-2.5 cursor-pointer ${index === active ? 'bg-brand-soft' : ''}`}
                >
                  <div className="flex items-center gap-2 text-xs text-fg-muted">
                    {/* Explicit spaces: flex gaps add none to the accessible name. */}
                    <span className="font-bold text-fg">{m.sender}</span>{' '}
                    {m.where && <><span className="font-semibold text-fg-muted truncate">in {m.where}</span>{' '}</>}
                    <span>{formatDistanceToNow(new Date(m.createdAt), { addSuffix: true })}</span>
                    {m.parentId && <>{' '}<span className="text-fg-subtle">· in a thread</span></>}
                  </div>
                  <p className="text-sm text-fg mt-0.5 break-words">{m.snippet}</p>
                </li>
              ))}
          </ul>
          )}
        </div>
      )}
    </div>
  );
};
