import axios from 'axios';
import { ClipboardList, Loader2, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

interface AuditLogEntry {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  details: string;
  createdAt: string;
  actor: { id: string; username: string };
}

interface AuditLogPage {
  logs: AuditLogEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

const ACTION_BADGE_STYLES: Record<string, string> = {
  BAN_USER: 'bg-red-100 text-red-700 border-red-200',
  SUSPEND_USER: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  REACTIVATE_USER: 'bg-green-100 text-green-700 border-green-200',
  CHANGE_ROLE: 'bg-purple-100 text-purple-700 border-purple-200',
  DELETE_USER: 'bg-red-100 text-red-700 border-red-200',
  FORCE_PASSWORD_RESET: 'bg-blue-100 text-blue-700 border-blue-200',
  DELETE_CHANNEL: 'bg-orange-100 text-orange-700 border-orange-200',
  DELETE_MESSAGE: 'bg-orange-100 text-orange-700 border-orange-200',
  DELETE_FILE: 'bg-orange-100 text-orange-700 border-orange-200',
};

const formatActionLabel = (action: string) =>
  action.split('_').map(w => w[0] + w.slice(1).toLowerCase()).join(' ');

export const AuditLogViewer = () => {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = async (cursor?: string) => {
    try {
      const res = await axios.get<AuditLogPage>('/api/admin/audit-logs', { params: cursor ? { cursor } : {} });
      setLogs(prev => (cursor ? [...prev, ...res.data.logs] : res.data.logs));
      setNextCursor(res.data.nextCursor);
      setHasMore(res.data.hasMore);
    } catch (err) {
      console.error('Failed to fetch audit logs', err);
      setError('Failed to load audit logs');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    fetchPage();
  }, []);

  const handleLoadMore = () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    fetchPage(nextCursor);
  };

  return (
    <div className="p-8 h-full flex flex-col bg-gray-50">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight flex items-center gap-3">
          <div className="p-2 bg-violet-100 rounded-lg">
            <ClipboardList className="text-violet-600" size={28} />
          </div>
          Audit Logs
        </h1>
        <p className="text-gray-600 font-medium text-sm mt-2">A permanent record of every admin action taken in this workspace</p>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg font-medium flex items-center gap-2">
          <ShieldAlert size={16} /> {error}
        </div>
      )}

      <div className="flex-1 bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm flex flex-col">
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="animate-spin text-violet-500" size={28} />
            </div>
          ) : logs.length === 0 ? (
            <div className="py-16 text-center text-gray-500 font-medium text-sm uppercase tracking-wider">
              No admin actions recorded yet
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {logs.map((log) => (
                <div key={log.id} className="px-6 py-4 flex items-start gap-4 hover:bg-gray-50 transition-colors">
                  <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-white text-xs font-black uppercase shrink-0 mt-0.5">
                    {log.actor.username[0] || '?'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-sm font-bold text-gray-900">{log.actor.username}</span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider border ${ACTION_BADGE_STYLES[log.action] ?? 'bg-gray-100 text-gray-700 border-gray-200'}`}
                      >
                        {formatActionLabel(log.action)}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600">{log.details}</p>
                  </div>
                  <div className="text-xs text-gray-400 font-medium shrink-0 whitespace-nowrap mt-1">
                    {new Date(log.createdAt).toLocaleString(undefined, {
                      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {hasMore && (
          <div className="p-4 border-t border-gray-100 flex justify-center">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="px-5 py-2 text-sm font-bold text-violet-600 hover:bg-violet-50 rounded-lg transition-all disabled:opacity-50 flex items-center gap-2"
            >
              {loadingMore && <Loader2 size={14} className="animate-spin" />}
              Load More
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
