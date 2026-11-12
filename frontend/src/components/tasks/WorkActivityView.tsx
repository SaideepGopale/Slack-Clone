import { formatDistanceToNow } from 'date-fns';
import { AlarmClock, CheckCheck, CheckCircle2, MessageSquare, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { errorMessage } from '../../lib/api/http';
import { listWorkNotifications, markWorkNotificationsRead, WorkNotification } from '../../lib/api/tasks';
import { useWorkspace } from '../../pages/workspace/WorkspaceContext';
import { Button, EmptyState, ErrorState, LoadingState } from '../ui';

/**
 * T.33 — task activity for the signed-in person: assignments, comments,
 * status changes and overdue reminders, live (`work:notification`), each
 * opening its task. Server-side these are the WorkNotification rows only the
 * recipient can read.
 */
const ICONS: Record<string, typeof UserPlus> = { task_assigned: UserPlus, task_comment: MessageSquare, task_status: CheckCircle2, task_overdue: AlarmClock };
const LABELS: Record<string, string> = { task_assigned: 'Assigned to you', task_comment: 'New comment', task_status: 'Status changed', task_overdue: 'Overdue' };

export const WorkActivityView = () => {
  const { workspaceId, socket } = useWorkspace();
  const navigate = useNavigate();
  const [items, setItems] = useState<WorkNotification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!workspaceId) return;
    setError(null);
    listWorkNotifications(workspaceId, { limit: 50 })
      .then((res) => {
        setItems(res.notifications);
        setUnread(res.unreadCount);
      })
      .catch((err: unknown) => setError(errorMessage(err, 'Could not load task activity.')));
  }, [workspaceId]);

  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const onNew = (payload: { notification?: WorkNotification & { workspaceId?: string } }) => {
      const n = payload?.notification;
      if (!n || (n.workspaceId && n.workspaceId !== workspaceId)) return;
      setItems((prev) => (prev && !prev.some((p) => p.id === n.id) ? [n, ...prev] : prev));
      if (!n.readAt) setUnread((c) => c + 1);
    };
    socket.on('work:notification', onNew);
    return () => {
      socket.off('work:notification', onNew);
    };
  }, [socket, workspaceId]);

  const markRead = async (ids?: string[]) => {
    if (!workspaceId) return;
    const now = new Date().toISOString();
    setItems((prev) => prev?.map((n) => (!ids || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? now } : n)) ?? prev);
    setUnread((c) => (ids ? Math.max(0, c - ids.length) : 0));
    await markWorkNotificationsRead(workspaceId, ids ? { ids } : { all: true }).catch(() => load());
  };

  const open = (n: WorkNotification) => {
    if (!n.readAt) void markRead([n.id]);
    if (n.projectId && n.taskId) navigate(`/${workspaceId}/projects/${n.projectId}?task=${n.taskId}`);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-sm text-fg-muted">{unread > 0 ? `${unread} unread` : 'You are all caught up'}</p>
          {unread > 0 && (
            <Button variant="secondary" size="sm" icon={<CheckCheck size={14} aria-hidden="true" />} onClick={() => void markRead()}>
              Mark all read
            </Button>
          )}
        </div>
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : items === null ? (
          <LoadingState label="Loading task activity" />
        ) : items.length === 0 ? (
          <EmptyState icon={<CheckCircle2 size={24} />} title="No task activity yet" description="Assignments, comments and reminders about your tasks will appear here." />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line" aria-label="Task activity">
            {items.map((n) => {
              const Icon = ICONS[n.type] ?? CheckCircle2;
              return (
                <li key={n.id}>
                  <button type="button" onClick={() => open(n)} className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-secondary ${n.readAt ? '' : 'bg-brand-soft/40'}`}>
                    <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${n.type === 'task_overdue' ? 'bg-danger-soft text-danger' : 'bg-brand-soft text-brand'}`} aria-hidden="true">
                      <Icon size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-xs text-fg-subtle">
                        <span className="font-semibold uppercase tracking-wide">{LABELS[n.type] ?? 'Update'}</span>
                        <span>·</span>
                        <time dateTime={n.createdAt}>{formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}</time>
                        {!n.readAt && <span className="h-2 w-2 rounded-full bg-brand" aria-label="Unread" />}
                      </span>
                      <span className="mt-0.5 block truncate text-sm font-semibold text-fg">{n.title}</span>
                      {(n.body || n.actor) && (
                        <span className="mt-0.5 block truncate text-sm text-fg-muted">
                          {n.actor ? `${n.actor.displayName || n.actor.username}: ` : ''}
                          {n.body}
                        </span>
                      )}
                    </span>
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
