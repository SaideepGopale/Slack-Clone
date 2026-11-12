import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T.33 — multi-file attachments in the composer: parallel uploads (at most
 * three at a time), per-file progress, cancel (aborts the request), retry,
 * size/count limits, and the tray's controls.
 */
const axiosMock = vi.hoisted(() => ({ post: vi.fn(), defaults: { headers: { common: {} } } }));
vi.mock('axios', () => ({ default: axiosMock }));

import { AttachmentTray } from './AttachmentTray';
import { MAX_FILE_BYTES, useUploadQueue } from './useUploadQueue';

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; config: { signal: AbortSignal; onUploadProgress: (e: { loaded: number; total: number }) => void }; form: FormData };
const pending: Pending[] = [];

beforeEach(() => {
  pending.length = 0;
  axiosMock.post.mockReset().mockImplementation(
    (_url: string, form: FormData, config: Pending['config']) =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject, config, form });
        config.signal.addEventListener('abort', () => reject(new Error('aborted')));
      })
  );
  URL.createObjectURL = vi.fn(() => 'blob:thumb');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.clearAllMocks());

const file = (name: string, size = 10, type = 'application/pdf') => {
  const f = new File(['x'.repeat(Math.min(size, 64))], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

describe('useUploadQueue (T.33)', () => {
  it('uploads several files with progress, at most three at a time', async () => {
    const { result } = renderHook(() => useUploadQueue());
    act(() => result.current.add([file('a.pdf'), file('b.pdf'), file('c.pdf'), file('d.pdf'), file('e.pdf')]));
    await waitFor(() => expect(pending).toHaveLength(3));
    expect(result.current.items.map((i) => i.status)).toEqual(['uploading', 'uploading', 'uploading', 'queued', 'queued']);
    expect(result.current.busy).toBe(true);

    act(() => pending[0].config.onUploadProgress({ loaded: 50, total: 100 }));
    expect(result.current.items[0].progress).toBe(50);
    await act(async () => pending[0].resolve({ data: { url: '/api/attachments/1', name: 'a.pdf', type: 'application/pdf' } }));
    await waitFor(() => expect(pending).toHaveLength(4)); // the next queued file starts
    expect(result.current.ready).toEqual([expect.objectContaining({ url: '/api/attachments/1', name: 'a.pdf' })]);
  });

  it('cancel aborts the request and drops the file; failures can be retried', async () => {
    const { result } = renderHook(() => useUploadQueue());
    act(() => result.current.add([file('a.pdf'), file('b.pdf')]));
    await waitFor(() => expect(pending).toHaveLength(2));
    const [first, second] = result.current.items;
    act(() => result.current.remove(first.id));
    expect(pending[0].config.signal.aborted).toBe(true);
    expect(result.current.items.map((i) => i.id)).toEqual([second.id]);

    await act(async () => pending[1].reject({ response: { data: { message: 'The file’s content does not match its type.' } } }));
    expect(result.current.items[0]).toMatchObject({ status: 'failed', error: 'The file’s content does not match its type.' });
    expect(result.current.failed).toBe(true);
    act(() => result.current.retry(second.id));
    await waitFor(() => expect(pending).toHaveLength(3));
    await act(async () => pending[2].resolve({ data: { url: '/api/attachments/2', name: 'b.pdf', type: 'application/pdf' } }));
    expect(result.current.ready).toHaveLength(1);
  });

  it('refuses files over 25 MB, empty files and more than ten files', () => {
    const onRejected = vi.fn();
    const { result } = renderHook(() => useUploadQueue({ onRejected }));
    act(() => result.current.add([file('huge.mp4', MAX_FILE_BYTES + 1), file('empty.txt', 0)]));
    expect(result.current.items).toHaveLength(0);
    expect(onRejected).toHaveBeenCalledWith('huge.mp4 is larger than 25 MB.');
    expect(onRejected).toHaveBeenCalledWith('empty.txt is empty.');
    act(() => result.current.add(Array.from({ length: 12 }, (_, i) => file(`f${i}.pdf`))));
    expect(result.current.items).toHaveLength(10);
    expect(onRejected).toHaveBeenCalledWith('You can attach up to 10 files to one message.');
  });

  it('shows image thumbnails and frees them when cleared', () => {
    const { result } = renderHook(() => useUploadQueue());
    act(() => result.current.add([file('photo.png', 10, 'image/png')]));
    expect(result.current.items[0].previewUrl).toBe('blob:thumb');
    act(() => result.current.clear());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumb');
    expect(result.current.items).toEqual([]);
  });
});

describe('AttachmentTray (T.33)', () => {
  it('offers cancel while uploading, retry on failure and remove when done', () => {
    const onRemove = vi.fn();
    const onRetry = vi.fn();
    const base = { progress: 0 };
    render(
      <AttachmentTray
        onRemove={onRemove}
        onRetry={onRetry}
        items={[
          { ...base, id: '1', file: file('up.pdf'), status: 'uploading', progress: 40 },
          { ...base, id: '2', file: file('bad.pdf'), status: 'failed', error: 'Upload failed.' },
          { ...base, id: '3', file: file('done.pdf', 2048), status: 'done', progress: 100, result: { url: '/api/attachments/3', name: 'done.pdf', type: 'application/pdf' } },
        ]}
      />
    );
    expect(screen.getByLabelText('Uploading up.pdf, 40%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel upload of up.pdf' }));
    expect(onRemove).toHaveBeenCalledWith('1');
    expect(screen.getByRole('alert')).toHaveTextContent('Upload failed.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry bad.pdf' }));
    expect(onRetry).toHaveBeenCalledWith('2');
    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment done.pdf' }));
    expect(onRemove).toHaveBeenCalledWith('3');
    expect(screen.getByText('2 KB')).toBeInTheDocument();
  });
});
