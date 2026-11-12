import { CheckSquare, FileText, FolderKanban, Hash, Home, Inbox, Lock, MessageSquare, Search, Settings, User, Users, X } from 'lucide-react';
import { KeyboardEvent, ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { searchWorkspace, WorkspaceSearchResult } from '../../lib/api/activity';
import { http, seg } from '../../lib/api/http';
import { requestMessageFocusAfterNavigation } from '../../lib/messageFocus';
import { htmlToText, truncate } from '../../lib/messages';

/**
 * T.33 — command palette (⌘K / Ctrl+K): jump anywhere and search the
 * workspace — tasks, projects, channels, people, messages and files — with
 * the keyboard. Results come from the server, already limited to what the
 * caller may see (GET /api/workspaces/:id/search/all and /search).
 */
export interface EverythingResults {
  channels: { id: string; name: string | null; visibility: 'PUBLIC' | 'PRIVATE'; archived: boolean; isMember: boolean }[];
  people: { id: string; username: string; displayName: string | null; title: string | null }[];
  projects: { id: string; name: string; key: string | null; status: string; archived: boolean }[];
  tasks: { id: string; identifier: string; title: string; status: string; projectId: string; project?: { name: string } }[];
  files: { id: string; name: string; channelId: string | null; messageId: string | null; channelName: string | null }[];
}

export const searchEverything = (workspaceId: string, q: string) =>
  http.get<EverythingResults>(`/api/workspaces/${seg(workspaceId)}/search/all`, { q });

interface Item {
  key: string;
  group: string;
  icon: ReactNode;
  label: string;
  hint?: string;
  run: () => void;
}

const MIN_QUERY = 2;
const DEBOUNCE_MS = 200;

interface CommandPaletteProps {
  workspaceId: string;
  /** Opens a DM with a person (WorkspaceContext.startDM). */
  onMessagePerson: (userId: string) => Promise<void> | void;
}

export const CommandPalette = ({ workspaceId, onMessagePerson }: CommandPaletteProps) => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{ everything: EverythingResults | null; messages: WorkspaceSearchResult[] }>({ everything: null, messages: [] });
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const listId = useId();

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setResults({ everything: null, messages: [] });
    returnFocus.current?.focus?.();
  }, []);

  // ⌘K / Ctrl+K anywhere in the workspace; also opened by the header button event.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        returnFocus.current = document.activeElement as HTMLElement | null;
        setOpen((o) => !o);
      }
    };
    const onOpen = () => {
      returnFocus.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('smartconnect:open-palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('smartconnect:open-palette', onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    setActive(0);
    if (!open || q.length < MIN_QUERY) {
      setResults({ everything: null, messages: [] });
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      Promise.allSettled([searchEverything(workspaceId, q), searchWorkspace(workspaceId, q)]).then(([everything, messages]) => {
        if (cancelled) return;
        setLoading(false);
        setResults({
          everything: everything.status === 'fulfilled' ? everything.value : null,
          messages: messages.status === 'fulfilled' ? messages.value.results : [],
        });
        setError(everything.status === 'rejected' && messages.status === 'rejected' ? 'Search is unavailable right now. Please try again.' : null);
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open, workspaceId]);

  const go = useCallback(
    (path: string) => {
      close();
      navigate(path);
    },
    [close, navigate]
  );

  const items = useMemo<Item[]>(() => {
    const base = `/${workspaceId}`;
    const q = query.trim();
    if (q.length < MIN_QUERY) {
      const nav: [string, ReactNode, string][] = [
        ['Home', <Home size={16} />, 'home'],
        ['My tasks', <CheckSquare size={16} />, 'tasks'],
        ['Projects', <FolderKanban size={16} />, 'projects'],
        ['Activity', <Inbox size={16} />, 'activity'],
        ['Direct messages', <MessageSquare size={16} />, 'dms'],
        ['People', <Users size={16} />, 'directory'],
        ['Workspace settings', <Settings size={16} />, 'settings'],
      ];
      return nav.map(([label, icon, path]) => ({ key: `nav:${path}`, group: 'Go to', icon, label, run: () => go(`${base}/${path}`) }));
    }
    const out: Item[] = [];
    const e = results.everything;
    for (const t of e?.tasks ?? []) {
      out.push({ key: `t:${t.id}`, group: 'Tasks', icon: <CheckSquare size={16} />, label: `${t.identifier} ${t.title}`, hint: `${t.project?.name ?? ''} · ${t.status.replace('_', ' ').toLowerCase()}`, run: () => go(`${base}/projects/${t.projectId}?task=${t.id}`) });
    }
    for (const p of e?.projects ?? []) {
      out.push({ key: `p:${p.id}`, group: 'Projects', icon: <FolderKanban size={16} />, label: p.name, hint: p.archived ? 'Archived' : p.status.replace('_', ' ').toLowerCase(), run: () => go(`${base}/projects/${p.id}`) });
    }
    for (const c of e?.channels ?? []) {
      out.push({
        key: `c:${c.id}`,
        group: 'Channels',
        icon: c.visibility === 'PRIVATE' ? <Lock size={16} /> : <Hash size={16} />,
        label: c.name ?? 'channel',
        hint: c.archived ? 'Archived' : c.isMember ? undefined : 'Not joined',
        run: () => go(`${base}/c/${c.id}`),
      });
    }
    for (const person of e?.people ?? []) {
      out.push({
        key: `u:${person.id}`,
        group: 'People',
        icon: <User size={16} />,
        label: person.displayName || person.username,
        hint: person.displayName ? `@${person.username}` : person.title ?? undefined,
        run: () => {
          close();
          void onMessagePerson(person.id);
        },
      });
    }
    for (const m of results.messages.slice(0, 8)) {
      out.push({
        key: `m:${m.id}`,
        group: 'Messages',
        icon: <MessageSquare size={16} />,
        label: truncate(htmlToText(m.preview), 90) || 'Message',
        hint: `${m.sender.username} · ${m.channel.name ?? 'conversation'}`,
        run: () => {
          requestMessageFocusAfterNavigation({ channelId: m.channel.id, messageId: m.id, parentId: m.parentId });
          go(`${base}/c/${m.channel.id}`);
        },
      });
    }
    for (const f of e?.files ?? []) {
      if (!f.channelId || !f.messageId) continue;
      out.push({
        key: `f:${f.id}`,
        group: 'Files',
        icon: <FileText size={16} />,
        label: f.name,
        hint: f.channelName ? `#${f.channelName}` : 'Direct message',
        run: () => {
          requestMessageFocusAfterNavigation({ channelId: f.channelId!, messageId: f.messageId! });
          go(`${base}/c/${f.channelId}`);
        },
      });
    }
    return out;
  }, [query, results, workspaceId, go, close, onMessagePerson]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      setActive((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault();
      items[active].run();
    }
  };

  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, listId]);

  if (!open) return null;

  const q = query.trim();
  let lastGroup = '';
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-overlay px-4 pt-[12vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-modal="true" aria-label="Search and jump" className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search size={18} className="shrink-0 text-fg-subtle" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-label="Search tasks, projects, channels, people, messages and files"
            placeholder="Search or jump to…"
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-fg placeholder:text-fg-subtle focus:outline-none"
          />
          {loading && <span className="text-xs text-fg-subtle" role="status">Searching…</span>}
          <button type="button" onClick={close} aria-label="Close search" className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-tertiary hover:text-fg">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <ul id={listId} role="listbox" aria-label="Results" className="max-h-[min(60vh,28rem)] overflow-y-auto p-2">
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <li key={item.key} role="presentation">
                {header && <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle" aria-hidden="true">{header}</div>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={item.run}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm ${i === active ? 'bg-brand-soft text-fg' : 'text-fg-muted'}`}
                >
                  <span className={`shrink-0 ${i === active ? 'text-brand' : 'text-fg-subtle'}`} aria-hidden="true">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">{item.label}</span>
                  {item.hint && <span className="shrink-0 truncate text-xs text-fg-subtle max-w-[40%]">{item.hint}</span>}
                </div>
              </li>
            );
          })}
          {q.length >= MIN_QUERY && !loading && items.length === 0 && (
            <li className="px-3 py-8 text-center text-sm text-fg-subtle" role="status">
              {error ?? `No results for “${q}”.`}
            </li>
          )}
        </ul>
        <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[11px] text-fg-subtle">
          <span><kbd className="font-sans">↑↓</kbd> to move · <kbd className="font-sans">Enter</kbd> to open · <kbd className="font-sans">Esc</kbd> to close</span>
          <span className="hidden sm:inline">⌘K / Ctrl+K</span>
        </div>
      </div>
    </div>,
    document.body
  );
};
