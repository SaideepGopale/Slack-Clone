import { formatDistanceToNow } from 'date-fns';
import { AtSign, Bell, CheckCheck, MessageSquareReply } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ActivityNotification, activityApi, errorMessage } from '../../lib/api';
import { conversationLabel } from '../../lib/api/activity';
import { MessageFocusTarget } from '../../lib/messageFocus';
import { useWorkspace } from '../../pages/workspace/WorkspaceContext';
import { Button, EmptyState, ErrorState, LoadingState } from '../ui';

interface ActivityViewProps {
  /** Opens the conversation and brings the message into view. */
  onOpen: (target: MessageFocusTarget) => void;
}

/**
 * P2 Phase I: the workspace's Activity feed — @mentions of you and replies to
 * your threads, newest first, live. (It used to fan out over every
 * conversation in every workspace and list recent messages.)
 */
export const ActivityView = ({ onOpen }: ActivityViewProps) => {
  const { workspaceId, socket, setActivityUnread } = useWorkspace();
  const [items, setItems] = useState<ActivityNotification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(false);

  const load = useCallback(() => {
    if (!workspaceId) return;
    setError(null);
    activityApi
      .listNotifications(workspaceId)
      .then((res) => {
        setItems(res.notifications);
        setUnread(res.unreadCount);
      })
      .catch((err: unknown) => setError(errorMessage(err, 'Could not load your activity.')));
  }, [workspaceId]);

  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const onNew = (n: ActivityNotification) => {
      if (!n || n.workspaceId !== workspaceId) return;
      setItems((prev) => (prev && !prev.some((p) => p.id === n.id) ? [n, ...prev] : prev));
      if (!n.isRead) setUnread((c) => c + 1);
    };
    socket.on('notification:new', onNew);
    return () => {
      socket.off('notification:new', onNew);
    };
  }, [socket, workspaceId]);

  // Keep the sidebar's Activity badge in step with this feed.
  const loaded = items !== null;
  useEffect(() => {
    if (loaded) setActivityUnread?.(unread);
  }, [loaded, unread, setActivityUnread]);

  const markRead = (ids?: string[]) => {
    if (!workspaceId) return;
    setItems((prev) => prev?.map((n) => (!ids || ids.includes(n.id) ? { ...n, isRead: true } : n)) ?? prev);
    setUnread((c) => (ids ? Math.max(0, c - ids.length) : 0));
    activityApi.markNotificationsRead(workspaceId, ids).catch(() => load());
  };

  const open = (n: ActivityNotification) => {
    if (!n.isRead) markRead([n.id]);
    onOpen({ channelId: n.channel.id, messageId: n.message.id, parentId: n.message.parentId });
  };

  const visible = items?.filter((n) => !onlyUnread || !n.isRead) ?? [];

  return (
    <div className="flex-1 flex flex-col h-full bg-surface">
      <div className="h-16 border-b border-line flex items-center justify-between gap-3 px-6 shrink-0 bg-surface">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-fg tracking-tight">Activity</h1>
          <p className="text-xs text-fg-muted">Mentions of you and replies to your threads in this workspace</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="ghost" size="sm" aria-pressed={onlyUnread} onClick={() => setOnlyUnread((v) => !v)}>
            {onlyUnread ? 'Show all' : `Unread${unread ? ` (${unread})` : ''}`}
          </Button>
          {unread > 0 && (
            <Button variant="secondary" size="sm" icon={<CheckCheck size={14} aria-hidden="true" />} onClick={() => markRead()}>
              Mark all read
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="max-w-3xl mx-auto">
          {error ? (
            <ErrorState message={error} onRetry={load} />
          ) : items === null ? (
            <LoadingState label="Loading activity" />
          ) : visible.length === 0 ? (
            <EmptyState
              icon={<Bell size={28} aria-hidden="true" />}
              title={onlyUnread ? "You're all caught up" : 'No activity yet'}
              description="When someone @mentions you or replies to your thread, it shows up here."
            />
          ) : (
            <ul className="flex flex-col gap-1.5" aria-label="Activity">
              {visible.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => open(n)}
                    className={`w-full text-left flex gap-3 rounded-xl border px-4 py-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
                      n.isRead ? 'border-line bg-surface hover:bg-surface-secondary' : 'border-brand-muted bg-brand-soft hover:bg-brand-muted'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="w-9 h-9 shrink-0 rounded-lg bg-brand text-on-brand flex items-center justify-center font-bold uppercase"
                    >
                      {n.message.sender.username[0]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-xs text-fg-muted">
                        {n.type === 'MENTION' ? <AtSign size={12} aria-hidden="true" /> : <MessageSquareReply size={12} aria-hidden="true" />}
                        {/* Explicit spaces: flex gaps don't put any in the accessible text. */}
                        <span className="font-semibold text-fg">{n.message.sender.username}</span>{' '}
                        <span>{n.type === 'MENTION' ? 'mentioned you in' : 'replied to your thread in'}</span>{' '}
                        <span className="font-semibold text-fg truncate">{conversationLabel(n.channel)}</span>{' '}
                        <span aria-hidden="true">·</span>{' '}
                        <time dateTime={n.createdAt}>{formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}</time>
                        {!n.isRead && <span className="sr-only"> (unread)</span>}
                      </span>
                      <span className="block mt-1 text-sm text-fg break-words">{n.message.preview}</span>
                    </span>
                    {!n.isRead && <span aria-hidden="true" className="mt-1.5 w-2 h-2 rounded-full bg-brand shrink-0" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};
