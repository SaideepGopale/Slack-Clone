import axios from 'axios';
import { AlertTriangle, File as FileIcon, Globe, Hash, HardDrive, Loader2, Lock, MessageSquareLock, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { Badge, Button, EmptyState, ErrorState, useConfirm } from '../ui';

/**
 * Admin File Storage (T.32, audit M11). Private files (uploads since T.32) and
 * older public files are listed together, biggest first. Files in direct
 * messages are only counted — never shown or deleted here (the same rule as
 * message moderation). Storage problems are shown as warnings, never as an
 * empty list.
 */
interface StoredFile {
  id: string;
  kind: 'private' | 'legacy-public';
  name: string;
  url: string | null;
  mimeType: string | null;
  sizeBytes: number;
  modifiedAt: string;
  messageId: string | null;
  channelId: string | null;
  channelName: string | null;
  senderUsername: string | null;
}

interface StoredFilesReport {
  files: StoredFile[];
  directMessageFiles: { count: number; bytes: number };
  totals: { count: number; bytes: number };
  warnings: string[];
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unitIndex]}`;
};

const KIND_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'private', label: 'Private' },
  { id: 'legacy-public', label: 'Older public' },
  { id: 'orphaned', label: 'Not in a message' },
] as const;
type KindFilter = (typeof KIND_FILTERS)[number]['id'];

const SkeletonRows = () => (
  <>
    {[0, 1, 2, 3, 4].map((i) => (
      <tr key={i} aria-hidden="true">
        <td className="px-5 py-3"><div className="flex items-center gap-3"><div className="skeleton h-8 w-8 rounded-lg" /><div className="skeleton h-3 w-40 rounded" /></div></td>
        <td className="px-5 py-3"><div className="skeleton h-3 w-24 rounded" /></td>
        <td className="px-5 py-3"><div className="skeleton h-3 w-14 rounded" /></td>
        <td className="px-5 py-3"><div className="skeleton h-3 w-20 rounded" /></td>
        <td className="px-5 py-3" />
      </tr>
    ))}
  </>
);

export const FileStorageManagement = () => {
  const [report, setReport] = useState<StoredFilesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const { confirm, dialog } = useConfirm();

  const fetchFiles = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await axios.get<StoredFilesReport>('/api/admin/files');
      setReport(res.data);
    } catch (err) {
      const message = axios.isAxiosError(err) ? (err.response?.data as { error?: string } | undefined)?.error : undefined;
      setLoadError(message ?? 'The file list could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchFiles();
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (report?.files ?? []).filter((f) => {
      if (kind === 'orphaned' ? f.messageId !== null : kind !== 'all' && f.kind !== kind) return false;
      if (!q) return true;
      return [f.name, f.channelName, f.senderUsername].some((v) => v?.toLowerCase().includes(q));
    });
  }, [report, query, kind]);

  const handleDelete = async (file: StoredFile) => {
    const ok = await confirm({
      title: `Delete “${file.name}”?`,
      message: file.messageId
        ? `The file is permanently removed from storage, together with the message it was sent in${file.channelName ? ` (#${file.channelName})` : ''}. This cannot be undone.`
        : 'The file is permanently removed from storage. It is not attached to any message. This cannot be undone.',
      confirmLabel: 'Delete file',
      tone: 'danger',
    });
    if (!ok) return;

    setDeletingId(file.id);
    try {
      await axios.delete(`/api/admin/files/${encodeURIComponent(file.id)}`);
      setReport((prev) =>
        prev
          ? {
              ...prev,
              files: prev.files.filter((f) => f.id !== file.id),
              totals: { count: prev.totals.count - 1, bytes: prev.totals.bytes - file.sizeBytes },
            }
          : prev
      );
      toast.success('File deleted');
    } catch (err) {
      const message = axios.isAxiosError(err) ? (err.response?.data as { error?: string } | undefined)?.error : undefined;
      toast.error(message ?? 'The file could not be deleted.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex h-full flex-col bg-surface-secondary p-4 sm:p-6 lg:p-8">
      {dialog}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-xl font-semibold tracking-tight text-fg">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand">
              <HardDrive size={18} aria-hidden="true" />
            </span>
            File storage
          </h1>
          <p className="mt-1.5 text-sm text-fg-muted tabular-nums">
            {report ? `${report.totals.count} file${report.totals.count === 1 ? '' : 's'} · ${formatBytes(report.totals.bytes)} stored` : 'Loading…'}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void fetchFiles()} loading={loading} icon={<RefreshCw size={14} aria-hidden="true" />}>
          Refresh
        </Button>
      </div>

      {report && report.warnings.length > 0 && (
        <div role="status" className="mb-4 flex gap-3 rounded-xl border border-warning/30 bg-warning-soft p-3 text-sm text-fg">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <ul className="space-y-1">
            {report.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {report && report.directMessageFiles.count > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-line bg-surface p-3 text-sm text-fg-muted">
          <MessageSquareLock size={16} className="shrink-0 text-fg-subtle" aria-hidden="true" />
          <span className="tabular-nums">
            {report.directMessageFiles.count} file{report.directMessageFiles.count === 1 ? '' : 's'} ({formatBytes(report.directMessageFiles.bytes)}) in direct messages — private to their participants and not managed here.
          </span>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <span className="sr-only">Search files</span>
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, channel or person"
            className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-3 text-sm text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none"
          />
        </label>
        <div role="group" aria-label="Filter files" className="flex rounded-lg border border-line bg-surface p-0.5">
          {KIND_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={kind === f.id}
              onClick={() => setKind(f.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${kind === f.id ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:text-fg'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface">
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => void fetchFiles()} />
        ) : (
          <div className="flex-1 overflow-auto app-scrollbar">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-[1] bg-surface-secondary">
                <tr className="border-b border-line">
                  <th scope="col" className="px-5 py-2.5 text-xs font-medium text-fg-muted">File</th>
                  <th scope="col" className="px-5 py-2.5 text-xs font-medium text-fg-muted">Sent in</th>
                  <th scope="col" className="px-5 py-2.5 text-xs font-medium text-fg-muted">Size</th>
                  <th scope="col" className="px-5 py-2.5 text-xs font-medium text-fg-muted">Uploaded</th>
                  <th scope="col" className="px-5 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {loading && !report ? (
                  <SkeletonRows />
                ) : visible.length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      <EmptyState
                        icon={<FileIcon size={20} aria-hidden="true" />}
                        title={report?.files.length ? 'No files match' : 'No stored files'}
                        description={report?.files.length ? 'Try another search or filter.' : 'Files people share in channels will appear here.'}
                      />
                    </td>
                  </tr>
                ) : (
                  visible.map((file) => (
                    <tr key={file.id} className="transition-colors hover:bg-surface-secondary">
                      <td className="px-5 py-2.5">
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-tertiary text-fg-muted" aria-hidden="true">
                            <FileIcon size={15} />
                          </span>
                          <div className="min-w-0">
                            {file.url ? (
                              <a href={file.url} target="_blank" rel="noreferrer noopener" className="block max-w-xs truncate text-sm font-medium text-fg hover:text-brand hover:underline">
                                {file.name}
                              </a>
                            ) : (
                              <span className="block max-w-xs truncate text-sm font-medium text-fg">{file.name}</span>
                            )}
                            <div className="mt-0.5 flex items-center gap-2 text-xs text-fg-subtle">
                              {file.kind === 'private' ? (
                                <Badge tone="success" className="gap-1"><Lock size={10} aria-hidden="true" /> Private</Badge>
                              ) : (
                                <Badge tone="warning" className="gap-1"><Globe size={10} aria-hidden="true" /> Public link</Badge>
                              )}
                              {file.senderUsername && <span className="truncate">by {file.senderUsername}</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-2.5">
                        {file.channelName ? (
                          <span className="inline-flex items-center gap-1 text-sm text-fg-muted"><Hash size={12} aria-hidden="true" />{file.channelName}</span>
                        ) : (
                          <Badge tone="neutral">Not in a message</Badge>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-sm font-medium text-fg tabular-nums">{formatBytes(file.sizeBytes)}</td>
                      <td className="px-5 py-2.5 text-sm text-fg-muted tabular-nums">
                        {new Date(file.modifiedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => void handleDelete(file)}
                          disabled={deletingId === file.id}
                          aria-label={`Delete ${file.name}`}
                          title="Delete file"
                          className="rounded-lg p-2 text-fg-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:opacity-50"
                        >
                          {deletingId === file.id ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
