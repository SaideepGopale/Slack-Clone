import axios from 'axios';
import { Loader2, Mic, Pause, Play, RotateCcw, Send, Square, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { encodeWaveform, formatDuration } from '../../../lib/voice';
import { VoiceMessagePlayer } from './VoiceMessagePlayer';
import { useVoiceRecorder, VoiceRecording } from './useVoiceRecorder';

export interface UploadedVoiceNote {
  url: string;
  name: string;
  type: string;
}

/**
 * Uploads a recorded note through the normal private-attachment upload, with
 * its duration and waveform (stored on the attachment for the player).
 * Text fields go before the file so the server sees them with the upload.
 */
export const uploadVoiceNote = async (
  recording: VoiceRecording,
  { onProgress, signal }: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {}
): Promise<UploadedVoiceNote> => {
  const form = new FormData();
  form.append('durationMs', String(Math.round(recording.durationMs)));
  form.append('waveform', encodeWaveform(recording.peaks));
  form.append('attachment', recording.blob, `voice-message-${Date.now()}.${recording.extension}`);
  const res = await axios.post<UploadedVoiceNote>('/api/upload', form, {
    signal,
    onUploadProgress: (pe) => onProgress?.(Math.round((pe.loaded * 100) / (pe.total || recording.blob.size || 1))),
  });
  return { url: res.data.url, name: res.data.name, type: res.data.type || recording.mimeType };
};

interface VoiceRecorderBarProps {
  /** Sends the uploaded note as a message (ChatArea's normal send path). */
  onSend: (note: UploadedVoiceNote) => void;
  /** The bar is done (sent, cancelled or discarded). */
  onClose: () => void;
}

type SendState = { phase: 'idle' } | { phase: 'uploading'; percent: number } | { phase: 'failed'; message: string };

/**
 * The composer while recording a voice note (T.33): live time and level,
 * pause/resume, cancel, stop to review; review plays the note back with
 * re-record, discard and send; sending shows progress, can be cancelled and
 * retried without re-recording.
 */
export const VoiceRecorderBar = ({ onSend, onClose }: VoiceRecorderBarProps) => {
  const recorder = useVoiceRecorder();
  const [send, setSend] = useState<SendState>({ phase: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const { start, cancel } = recorder;

  // Start on open; a StrictMode remount cancels the first attempt and starts again.
  useEffect(() => {
    void start();
    return () => cancel();
  }, [start, cancel]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const close = () => {
    abortRef.current?.abort();
    recorder.cancel();
    recorder.discard();
    onClose();
  };

  const rerecord = () => {
    recorder.discard();
    setSend({ phase: 'idle' });
    void recorder.start();
  };

  const sendNote = async () => {
    if (!recorder.recording || send.phase === 'uploading') return;
    const controller = new AbortController();
    abortRef.current = controller;
    setSend({ phase: 'uploading', percent: 0 });
    try {
      const note = await uploadVoiceNote(recorder.recording, { signal: controller.signal, onProgress: (percent) => setSend({ phase: 'uploading', percent }) });
      if (controller.signal.aborted) return;
      onSend(note);
      recorder.discard();
      onClose();
    } catch (err) {
      if (controller.signal.aborted || axios.isCancel(err)) {
        setSend({ phase: 'idle' });
        return;
      }
      const message = (err as { response?: { data?: { message?: string; error?: string } } })?.response?.data;
      setSend({ phase: 'failed', message: message?.message || message?.error || 'The voice message could not be sent.' });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const cancelUpload = () => {
    abortRef.current?.abort();
    setSend({ phase: 'idle' });
  };

  const { status } = recorder;
  const shell = 'flex min-h-[3.25rem] w-full items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-2';
  const iconButton = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50';

  if (status === 'error') {
    return (
      <div className={shell} role="alert">
        <Mic size={18} className="shrink-0 text-danger" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-sm text-fg">{recorder.error}</span>
        <button type="button" onClick={rerecord} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-brand hover:bg-brand-soft">Try again</button>
        <button type="button" onClick={close} aria-label="Close voice recorder" className={`${iconButton} text-fg-muted hover:bg-surface-tertiary`}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    );
  }

  if (status === 'review' && recorder.recording) {
    const uploading = send.phase === 'uploading';
    return (
      <div className="w-full rounded-xl border border-line bg-surface px-2.5 py-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 [&>div]:mt-0">
            <VoiceMessagePlayer src={recorder.recording.url} durationMs={recorder.recording.durationMs} waveform={recorder.recording.peaks} label="Recorded voice message" />
          </div>
          <button type="button" onClick={close} disabled={uploading} aria-label="Discard voice message" title="Discard" className={`${iconButton} text-fg-muted hover:bg-danger-soft hover:text-danger`}>
            <Trash2 size={16} aria-hidden="true" />
          </button>
          <button type="button" onClick={rerecord} disabled={uploading} aria-label="Record again" title="Record again" className={`${iconButton} text-fg-muted hover:bg-surface-tertiary`}>
            <RotateCcw size={16} aria-hidden="true" />
          </button>
          {uploading ? (
            <button type="button" onClick={cancelUpload} aria-label="Cancel sending" title="Cancel sending" className={`${iconButton} bg-surface-tertiary text-fg hover:bg-danger-soft hover:text-danger`}>
              <X size={16} aria-hidden="true" />
            </button>
          ) : (
            <button type="button" onClick={() => void sendNote()} aria-label={send.phase === 'failed' ? 'Retry sending voice message' : 'Send voice message'} title="Send" className={`${iconButton} bg-brand text-on-brand hover:bg-brand-hover`}>
              {send.phase === 'failed' ? <RotateCcw size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
            </button>
          )}
        </div>
        {uploading && (
          <div className="mt-2 flex items-center gap-2 text-xs text-fg-muted" aria-live="polite">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-tertiary">
              <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${send.percent}%` }} />
            </div>
            <span className="tabular-nums">{send.percent}%</span>
          </div>
        )}
        {send.phase === 'failed' && (
          <p className="mt-2 text-xs text-danger" role="alert">
            {send.message} Your recording is kept — press retry to send it again.
          </p>
        )}
      </div>
    );
  }

  // requesting / recording / paused
  const paused = status === 'paused';
  const requesting = status === 'requesting' || status === 'idle';
  const remaining = recorder.maxMs - recorder.elapsedMs;
  return (
    <div className={shell}>
      <button type="button" onClick={close} aria-label="Cancel recording" title="Cancel" className={`${iconButton} text-fg-muted hover:bg-danger-soft hover:text-danger`}>
        <Trash2 size={16} aria-hidden="true" />
      </button>
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${paused || requesting ? 'bg-fg-subtle' : 'animate-pulse bg-danger'}`} aria-hidden="true" />
      <span className="w-11 shrink-0 text-sm font-semibold tabular-nums text-fg" aria-live="off">{formatDuration(recorder.elapsedMs)}</span>
      <div className="flex h-8 min-w-0 flex-1 items-center gap-[2px] overflow-hidden" aria-hidden="true">
        {recorder.livePeaks.map((peak, i) => (
          <span key={i} className={`w-[3px] shrink-0 rounded-full ${paused ? 'bg-fg-subtle/40' : 'bg-brand'}`} style={{ height: `${Math.max(8, peak)}%` }} />
        ))}
      </div>
      <span className="sr-only" aria-live="polite">
        {requesting ? 'Waiting for microphone permission' : paused ? 'Recording paused' : 'Recording'}
      </span>
      {remaining <= 30_000 && !requesting && <span className="hidden shrink-0 text-xs text-warning sm:inline">{formatDuration(remaining)} left</span>}
      {requesting ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Allow microphone…
        </span>
      ) : (
        <>
          <button
            type="button"
            onClick={paused ? recorder.resume : recorder.pause}
            aria-label={paused ? 'Resume recording' : 'Pause recording'}
            title={paused ? 'Resume' : 'Pause'}
            className={`${iconButton} text-fg hover:bg-surface-tertiary`}
          >
            {paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
          </button>
          <button type="button" onClick={recorder.stop} aria-label="Stop and review voice message" title="Stop and review" className={`${iconButton} bg-danger text-on-brand hover:bg-danger-hover`}>
            <Square size={14} fill="currentColor" aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
};
