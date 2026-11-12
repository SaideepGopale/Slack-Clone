import { Check, Clock, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { useApiQuery } from '../../hooks/useApiQuery';
import { formatDate } from '../../lib/adminAccess';
import { errorMessage, invitationsApi } from '../../lib/api';
import { AccessProblem } from '../management/AccessProblem';
import { Button, EmptyState, LoadingState } from '../ui';

interface JoinRequestsPanelProps {
  workspaceId: string;
  /** Show requesters' e-mail addresses (managers deciding who gets in). */
  showEmails?: boolean;
  onCountChange?: (count: number) => void;
  /** After an approval (e.g. refresh the members list). */
  onApproved?: () => void;
}

/**
 * Pending requests from people who used an invite link. Approval always
 * grants plain MEMBER (server-enforced). No backend events exist for join
 * requests, so the list refreshes after each decision and on focus.
 */
export const JoinRequestsPanel = ({ workspaceId, showEmails = true, onCountChange, onApproved }: JoinRequestsPanelProps) => {
  const requests = useApiQuery(() => invitationsApi.listJoinRequests(workspaceId), [workspaceId], { refetchOnFocus: true });
  const [busy, setBusy] = useState<{ id: string; action: 'APPROVE' | 'REJECT' } | null>(null);

  useEffect(() => {
    if (requests.data) onCountChange?.(requests.data.length);
  }, [requests.data, onCountChange]);

  const resolve = async (id: string, username: string, action: 'APPROVE' | 'REJECT') => {
    setBusy({ id, action });
    try {
      await invitationsApi.resolveJoinRequest(workspaceId, id, action);
      requests.setData((prev) => prev?.filter((r) => r.id !== id));
      toast.success(action === 'APPROVE' ? `${username} can now access the workspace.` : `Request from ${username} rejected.`);
      if (action === 'APPROVE') onApproved?.();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not resolve the request.'));
      // Someone else may have resolved it meanwhile.
      requests.reload({ silent: true }).catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  if (requests.error && !requests.data) {
    return <AccessProblem error={requests.error} resource="workspace" onRetry={() => requests.reload()} />;
  }
  if (requests.loading && !requests.data) return <LoadingState label="Loading join requests" />;

  const list = requests.data ?? [];
  if (list.length === 0) {
    return (
      <EmptyState
        icon={<Clock size={28} aria-hidden="true" />}
        title="No pending join requests"
        description="When someone uses an invite link, their request appears here for approval."
      />
    );
  }

  return (
    <ul aria-label="Join requests" className="divide-y divide-line border border-line rounded-xl overflow-hidden">
      {list.map((req) => (
        <li key={req.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div aria-hidden="true" className="w-8 h-8 rounded-full bg-brand-soft text-brand flex items-center justify-center font-semibold text-xs shrink-0">
              {req.user.username.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-sm text-fg truncate">{req.user.username}</div>
              <div className="text-xs text-fg-muted truncate">
                {showEmails ? `${req.user.email} · ` : ''}requested {formatDate(req.createdAt)}
              </div>
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button
              size="sm"
              variant="secondary"
              icon={<X size={13} aria-hidden="true" />}
              onClick={() => resolve(req.id, req.user.username, 'REJECT')}
              loading={busy?.id === req.id && busy.action === 'REJECT'}
              disabled={busy?.id === req.id}
              aria-label={`Reject ${req.user.username}`}
            >
              Reject
            </Button>
            <Button
              size="sm"
              icon={<Check size={13} aria-hidden="true" />}
              onClick={() => resolve(req.id, req.user.username, 'APPROVE')}
              loading={busy?.id === req.id && busy.action === 'APPROVE'}
              disabled={busy?.id === req.id}
              aria-label={`Approve ${req.user.username}`}
            >
              Approve
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
};
