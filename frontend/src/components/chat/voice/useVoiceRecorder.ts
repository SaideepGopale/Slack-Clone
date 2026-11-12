import { useCallback, useEffect, useRef, useState } from 'react';
import { downsamplePeaks, extensionForMime, levelFromRms, MAX_RECORDING_MS, pickRecordingFormat, recorderErrorMessage, WAVEFORM_BARS } from '../../../lib/voice';

/**
 * Voice-note recording (T.33).
 *
 *   idle → requesting → recording ⇄ paused → review → (send | discard) → idle
 *                    ↘ error                 ↖ cancel (from recording/paused) → idle
 *
 * - The container is picked from what the browser can record (Opus in
 *   WebM/Ogg, AAC in MP4 on Safari); the blob keeps the type it really has.
 * - A level meter (Web Audio analyser) drives the live bars and the waveform
 *   stored with the note. Without Web Audio the note still records.
 * - Paused time is not counted; recording stops itself at the length limit.
 * - The microphone is released on stop, cancel, error and unmount.
 */
export type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'paused' | 'review' | 'error';

export interface VoiceRecording {
  blob: Blob;
  url: string;
  durationMs: number;
  peaks: number[];
  mimeType: string;
  extension: string;
}

const LEVEL_SAMPLE_MS = 100;
const LIVE_BARS = 32;

export const useVoiceRecorder = ({ maxMs = MAX_RECORDING_MS }: { maxMs?: number } = {}) => {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [livePeaks, setLivePeaks] = useState<number[]>(() => Array(LIVE_BARS).fill(0));
  const [recording, setRecording] = useState<VoiceRecording | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<{ context: AudioContext; analyser: AnalyserNode; buffer: Uint8Array<ArrayBuffer> } | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const levelsRef = useRef<number[]>([]);
  const accumulatedRef = useRef(0);
  const segmentStartRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const discardRef = useRef(false);
  const urlRef = useRef<string | null>(null);
  const attemptRef = useRef(0);

  const elapsedNow = () => accumulatedRef.current + (segmentStartRef.current !== null ? Date.now() - segmentStartRef.current : 0);

  const release = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) void audio.context.close().catch(() => undefined);
  }, []);

  const currentLevel = () => {
    const audio = audioRef.current;
    if (!audio) return 0;
    audio.analyser.getByteTimeDomainData(audio.buffer);
    let sum = 0;
    for (const v of audio.buffer) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    return levelFromRms(Math.sqrt(sum / audio.buffer.length));
  };

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    accumulatedRef.current = elapsedNow();
    segmentStartRef.current = null;
    discardRef.current = false;
    recorder.stop();
  }, []);

  const startTicking = () => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      const elapsed = elapsedNow();
      setElapsedMs(elapsed);
      if (segmentStartRef.current !== null) {
        const level = currentLevel();
        levelsRef.current.push(level);
        setLivePeaks((prev) => [...prev.slice(1), Math.round(level * 100)]);
      }
      if (elapsed >= maxMs) stop();
    }, LEVEL_SAMPLE_MS);
  };

  const start = useCallback(async () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') return;
    setError(null);
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setStatus('error');
      setError('Voice messages are not supported in this browser.');
      return;
    }
    const attempt = ++attemptRef.current;
    setStatus('requesting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      setStatus('error');
      setError(recorderErrorMessage(err));
      return;
    }
    // Cancelled or unmounted while the permission prompt was open.
    if (attempt !== attemptRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;

    const format = pickRecordingFormat((type) => MediaRecorder.isTypeSupported(type));
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { ...(format.mimeType ? { mimeType: format.mimeType } : {}), audioBitsPerSecond: 48_000 });
    } catch (err) {
      release();
      setStatus('error');
      setError(recorderErrorMessage(err));
      return;
    }
    recorderRef.current = recorder;
    chunksRef.current = [];
    levelsRef.current = [];
    accumulatedRef.current = 0;
    discardRef.current = false;

    const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioContextCtor) {
      try {
        const context = new AudioContextCtor();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        // Safari creates contexts suspended outside a direct gesture.
        if (context.state === 'suspended') void context.resume().catch(() => undefined);
        audioRef.current = { context, analyser, buffer: new Uint8Array(new ArrayBuffer(analyser.fftSize)) };
      } catch {
        audioRef.current = null; // metering is optional
      }
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onerror = () => {
      discardRef.current = true;
      release();
      recorderRef.current = null;
      setStatus('error');
      setError('Recording stopped unexpectedly. Please try again.');
    };
    recorder.onstop = () => {
      const discard = discardRef.current;
      release();
      recorderRef.current = null;
      if (discard) return;
      const type = recorder.mimeType || format.mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      if (blob.size === 0) {
        setStatus('error');
        setError('Nothing was recorded. Check your microphone and try again.');
        return;
      }
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const durationMs = Math.min(accumulatedRef.current, maxMs);
      setElapsedMs(durationMs);
      setRecording({ blob, url, durationMs, peaks: downsamplePeaks(levelsRef.current, WAVEFORM_BARS), mimeType: type, extension: extensionForMime(type, format.extension) });
      setStatus('review');
    };

    recorder.start(250);
    segmentStartRef.current = Date.now();
    setElapsedMs(0);
    setLivePeaks(Array(LIVE_BARS).fill(0));
    setStatus('recording');
    startTicking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxMs, release]);

  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    recorder.pause();
    accumulatedRef.current = elapsedNow();
    segmentStartRef.current = null;
    setElapsedMs(accumulatedRef.current);
    setStatus('paused');
  }, []);

  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'paused') return;
    recorder.resume();
    segmentStartRef.current = Date.now();
    setStatus('recording');
  }, []);

  /** Throws the recording away (while recording/paused, or the permission prompt). */
  const cancel = useCallback(() => {
    attemptRef.current++;
    discardRef.current = true;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    segmentStartRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // already stopped
      }
    }
    release();
    chunksRef.current = [];
    setElapsedMs(0);
    setStatus('idle');
  }, [release]);

  /** Drops a reviewed recording (or clears an error) and returns to idle. */
  const discard = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setRecording(null);
    setError(null);
    setElapsedMs(0);
    setStatus('idle');
  }, []);

  useEffect(
    () => () => {
      attemptRef.current++;
      discardRef.current = true;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // already stopped
        }
      }
      release();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [release]
  );

  return { status, elapsedMs, livePeaks, recording, error, start, pause, resume, stop, cancel, discard, maxMs };
};
