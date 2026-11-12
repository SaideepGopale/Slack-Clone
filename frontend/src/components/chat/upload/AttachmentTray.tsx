import { AlertCircle, CheckCircle2, FileText, RotateCcw, X } from 'lucide-react';
import { UploadItem } from './useUploadQueue';

const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);

/**
 * T.33 — the files staged in the composer: thumbnail (images) or icon, name,
 * size, per-file progress, and cancel / retry / remove.
 */
export const AttachmentTray = ({ items, onRemove, onRetry }: { items: UploadItem[]; onRemove: (id: string) => void; onRetry: (id: string) => void }) => {
  if (items.length === 0) return null;
  return (
    <ul className="mb-2 flex gap-2 overflow-x-auto pb-1" aria-label="Attachments">
      {items.map((item) => {
        const uploading = item.status === 'uploading' || item.status === 'queued';
        return (
          <li key={item.id} className={`relative flex w-56 shrink-0 items-center gap-2.5 rounded-xl border bg-surface-secondary p-2 ${item.status === 'failed' ? 'border-danger/50' : 'border-line'}`}>
            {item.previewUrl ? (
              <img src={item.previewUrl} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
            ) : (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand" aria-hidden="true">
                <FileText size={18} />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-fg" title={item.file.name}>{item.file.name}</div>
              {item.status === 'failed' ? (
                <div className="flex items-center gap-1 text-xs text-danger" role="alert">
                  <AlertCircle size={12} aria-hidden="true" />
                  <span className="truncate" title={item.error}>{item.error}</span>
                </div>
              ) : uploading ? (
                <div className="mt-1 flex items-center gap-1.5" aria-label={`Uploading ${item.file.name}, ${item.progress}%`}>
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-tertiary">
                    <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${item.status === 'queued' ? 0 : item.progress}%` }} />
                  </div>
                  <span className="text-[11px] tabular-nums text-fg-subtle">{item.status === 'queued' ? 'Waiting' : `${item.progress}%`}</span>
                </div>
              ) : (
                <div className="flex items-center gap-1 text-xs text-fg-subtle">
                  <CheckCircle2 size={12} className="text-success" aria-hidden="true" /> {formatSize(item.file.size)}
                </div>
              )}
            </div>
            {item.status === 'failed' && (
              <button type="button" onClick={() => onRetry(item.id)} aria-label={`Retry ${item.file.name}`} title="Retry" className="shrink-0 rounded-md p-1 text-fg-muted hover:bg-surface-tertiary hover:text-fg">
                <RotateCcw size={14} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              aria-label={uploading ? `Cancel upload of ${item.file.name}` : `Remove attachment ${item.file.name}`}
              title={uploading ? 'Cancel upload' : 'Remove'}
              className="shrink-0 rounded-md p-1 text-fg-muted hover:bg-danger-soft hover:text-danger"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
};
