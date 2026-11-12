import { useEffect, useState } from 'react';
import { PHONE_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { useAuth } from '../../contexts/AuthContext';
import { disableTabSession, enableTabSession, isTabSessionActive, tabSessionsAvailable } from '../../lib/devTabSession';

/**
 * T.37 — LOCAL DEVELOPMENT ONLY (loaded by App.tsx only when
 * import.meta.env.DEV, so it is not part of production builds).
 *
 * A small control in the top-left corner:
 *  - shared tab: "Use a separate sign-in in this tab" — the tab switches to
 *    its own sign-in (and starts signed out). Nobody is signed out: other
 *    tabs keep the shared session.
 *  - isolated tab: whose tab this is (also prefixed to the browser tab's
 *    title), and "Leave" — signs out this tab's own session on the server,
 *    then returns the tab to the shared sign-in.
 * Equivalent URL switches: ?tabSession=1 and ?tabSession=0.
 */
const DevTabSessionPanel = ({ reload = () => window.location.reload() }: { reload?: () => void }) => {
  const { user, logout } = useAuth();
  const isolated = isTabSessionActive();
  // T.39: on phones the pill collapses to a small chip (it would cover the conversation's back button).
  const isPhone = useMediaQuery(PHONE_QUERY);
  const [expanded, setExpanded] = useState(false);
  const prefix = isolated && user ? `[${user.username}] ` : null;

  // Keep "[username] " in front of whatever title the page sets.
  useEffect(() => {
    if (!prefix) return;
    const apply = () => {
      if (!document.title.startsWith(prefix)) document.title = `${prefix}${document.title.replace(/^\[[^\]]*\] /, '')}`;
    };
    apply();
    const head = document.querySelector('head');
    const observer = head ? new MutationObserver(apply) : null;
    if (head) observer!.observe(head, { subtree: true, childList: true, characterData: true });
    return () => {
      observer?.disconnect();
      if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length);
    };
  }, [prefix]);

  if (!tabSessionsAvailable()) return null;

  if (isPhone && !expanded) {
    return (
      <div role="region" aria-label="Development tab sign-in" className="fixed left-1/2 top-0.5 z-[60] -translate-x-1/2">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="rounded-full bg-warning px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-on-brand shadow-sm"
          aria-label={`Development tab sign-in — ${isolated ? `this tab: ${user?.username ?? 'signed out'}` : 'shared sign-in'}. Show options`}
        >
          Dev{isolated ? ` · ${user?.username ?? '—'}` : ''}
        </button>
      </div>
    );
  }

  const separate = () => {
    enableTabSession();
    reload();
  };
  const leave = () => {
    if (user) logout(); // ends this tab's own server-side session only
    disableTabSession();
    reload();
  };

  return (
    <div
      role="region"
      aria-label="Development tab sign-in"
      className={`fixed top-1.5 z-[60] flex max-w-[calc(100vw-0.75rem)] items-center gap-1.5 rounded-full border border-warning/40 bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning shadow-sm ${isPhone ? 'left-1/2 -translate-x-1/2' : 'left-1.5'}`}
    >
      <span className="rounded bg-warning px-1 text-[9px] font-bold uppercase tracking-wider text-on-brand">Dev</span>
      {isolated ? (
        <>
          <span className="truncate">This tab: {user ? user.username : 'signed out'}</span>
          <button type="button" onClick={leave} aria-label="Leave this tab’s separate sign-in" className="rounded-full px-1.5 underline hover:no-underline">
            Leave
          </button>
        </>
      ) : (
        <>
          <span className="hidden sm:inline">Shared sign-in</span>
          <button type="button" onClick={separate} aria-label="Use a separate sign-in in this tab" className="rounded-full px-1.5 underline hover:no-underline">
            Separate tab
          </button>
        </>
      )}
      {isPhone && (
        <button type="button" onClick={() => setExpanded(false)} aria-label="Hide development options" className="rounded-full px-1 leading-none">
          ×
        </button>
      )}
    </div>
  );
};

export default DevTabSessionPanel;
