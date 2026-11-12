import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * T.33 — the composer's attachment queue: several files at once (picker,
 * paste, drag-and-drop), each uploading with its own progress, cancellable
 * and retryable, at most MAX_PARALLEL at a time. Uploads go through the
 * normal private-attachment endpoint; the server checks the content.
 */
export interface UploadedFile {
  url: string;
  name: string;
  type: string;
  size?: number;
}

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed';

export interface UploadItem {
  id: string;
  file: File;
  status: UploadStatus;
  progress: number;
  result?: UploadedFile;
  error?: string;
  previewUrl?: string;
}

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PARALLEL = 3;

let nextId = 0;

export const useUploadQueue = ({ onRejected }: { onRejected?: (message: string) => void } = {}) => {
  const [items, setItems] = useState<UploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const itemsRef = useRef<UploadItem[]>([]);
  itemsRef.current = items;

  const patch = useCallback((id: string, changes: Partial<UploadItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...changes } : item)));
  }, []);

  const start = useCallback(
    (item: UploadItem) => {
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      patch(item.id, { status: 'uploading', progress: 0, error: undefined });
      const form = new FormData();
      form.append('attachment', item.file);
      axios
        .post<UploadedFile>('/api/upload', form, {
          signal: controller.signal,
          onUploadProgress: (pe) => patch(item.id, { progress: Math.min(99, Math.round((pe.loaded * 100) / (pe.total || item.file.size || 1))) }),
        })
        .then(
          (res) => patch(item.id, { status: 'done', progress: 100, result: { url: res.data.url, name: res.data.name, type: res.data.type, size: res.data.size ?? item.file.size } }),
          (err) => {
            if (controller.signal.aborted) return;
            const data = (err as { response?: { data?: { message?: string; error?: string } } })?.response?.data;
            patch(item.id, { status: 'failed', error: data?.message || data?.error || 'Upload failed.' });
          }
        )
        .finally(() => controllers.current.delete(item.id));
    },
    [patch]
  );

  // Start queued files while fewer than MAX_PARALLEL are uploading.
  useEffect(() => {
    const uploading = items.filter((i) => i.status === 'uploading').length;
    const queued = items.filter((i) => i.status === 'queued').slice(0, Math.max(0, MAX_PARALLEL - uploading));
    for (const item of queued) start(item);
  }, [items, start]);

  const add = useCallback(
    (files: File[]) => {
      const room = MAX_FILES - itemsRef.current.length;
      if (files.length > room) onRejected?.(`You can attach up to ${MAX_FILES} files to one message.`);
      const accepted: UploadItem[] = [];
      for (const file of files.slice(0, Math.max(0, room))) {
        if (file.size > MAX_FILE_BYTES) {
          onRejected?.(`${file.name} is larger than 25 MB.`);
          continue;
        }
        if (file.size === 0) {
          onRejected?.(`${file.name} is empty.`);
          continue;
        }
        const previewUrl = file.type.startsWith('image/') && file.type !== 'image/svg+xml' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined;
        accepted.push({ id: `upload-${++nextId}`, file, status: 'queued', progress: 0, previewUrl });
      }
      if (accepted.length) setItems((prev) => [...prev, ...accepted]);
    },
    [onRejected]
  );

  const release = (item: UploadItem) => {
    controllers.current.get(item.id)?.abort();
    controllers.current.delete(item.id);
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  };

  /** Cancels an upload in flight or drops a staged/failed file. */
  const remove = useCallback((id: string) => {
    const item = itemsRef.current.find((i) => i.id === id);
    if (item) release(item);
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const retry = useCallback((id: string) => {
    setItems((prev) => prev.map((i) => (i.id === id && i.status === 'failed' ? { ...i, status: 'queued', progress: 0, error: undefined } : i)));
  }, []);

  /** After sending: forget everything (uploads are done; nothing is aborted). */
  const clear = useCallback(() => {
    for (const item of itemsRef.current) release(item);
    setItems([]);
  }, []);

  useEffect(
    () => () => {
      for (const item of itemsRef.current) release(item);
    },
    []
  );

  const ready = items.filter((i) => i.status === 'done' && i.result).map((i) => i.result!);
  const busy = items.some((i) => i.status === 'queued' || i.status === 'uploading');
  const failed = items.some((i) => i.status === 'failed');
  return { items, ready, busy, failed, add, remove, retry, clear };
};
