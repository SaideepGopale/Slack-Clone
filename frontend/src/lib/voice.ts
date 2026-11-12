/**
 * Voice messages (T.33): format detection, time formatting and the compact
 * waveform that travels with a voice note (stored on its attachment, so the
 * player can draw it without downloading and decoding the audio).
 */

// Most specific first. Chrome/Edge/Firefox record Opus (WebM or Ogg);
// Safari records AAC in MP4.
const CANDIDATES: { mimeType: string; extension: string }[] = [
  { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
  { mimeType: 'audio/webm', extension: 'webm' },
  { mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' },
  { mimeType: 'audio/mp4', extension: 'm4a' },
  { mimeType: 'audio/aac', extension: 'aac' },
];

export const pickRecordingFormat = (isTypeSupported: (type: string) => boolean): { mimeType: string; extension: string } => {
  for (const candidate of CANDIDATES) {
    try {
      if (isTypeSupported(candidate.mimeType)) return candidate;
    } catch {
      // some browsers throw for unknown types
    }
  }
  // Let the browser use its default container (usually WebM).
  return { mimeType: '', extension: 'webm' };
};

/** Extension for a recorded blob's actual type (the browser may differ from what was asked). */
export const extensionForMime = (mimeType: string, fallback = 'webm') => {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  if (base === 'audio/webm' || base === 'video/webm') return 'webm';
  if (base === 'audio/ogg') return 'ogg';
  if (base === 'audio/mp4' || base === 'video/mp4' || base === 'audio/x-m4a' || base === 'audio/m4a') return 'm4a';
  if (base === 'audio/aac') return 'aac';
  if (base === 'audio/mpeg') return 'mp3';
  return fallback;
};

export const formatDuration = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

/** Reduces level samples (0–1) to `buckets` bars on a 0–100 scale (max of each bucket). */
export const downsamplePeaks = (levels: number[], buckets: number): number[] => {
  if (levels.length === 0) return Array(buckets).fill(0);
  const out: number[] = [];
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor((i * levels.length) / buckets);
    const end = Math.max(start + 1, Math.floor(((i + 1) * levels.length) / buckets));
    let peak = 0;
    for (let j = start; j < end && j < levels.length; j++) peak = Math.max(peak, levels[j]);
    if (start >= levels.length) peak = levels[levels.length - 1];
    out.push(Math.round(Math.min(1, Math.max(0, peak)) * 100));
  }
  return out;
};

export const WAVEFORM_BARS = 48;
const MAX_WAVEFORM_BARS = 64;

export const encodeWaveform = (peaks: number[]) => peaks.map((p) => Math.round(Math.min(100, Math.max(0, p)))).join(',');

/** The server's stored waveform, or null when absent/invalid (the player then draws a neutral bar). */
export const parseWaveform = (value: string | null | undefined): number[] | null => {
  if (!value) return null;
  const parts = value.split(',');
  if (parts.length === 0 || parts.length > MAX_WAVEFORM_BARS) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 100) return null;
    out.push(n);
  }
  return out;
};

export const recorderErrorMessage = (err: unknown) => {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked. Allow it in your browser’s site settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Connect one and try again.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Your microphone is in use by another app. Close it and try again.';
  return 'Voice recording could not start. Please try again.';
};

/**
 * A meter level (0–1) from an RMS amplitude (0–1), on a decibel scale:
 * −60 dB (silence) → 0, 0 dB (full scale) → 1. Speech sits around −35…−15 dB,
 * which a linear scale would squash into the bottom few percent.
 */
export const levelFromRms = (rms: number) => {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 60));
};

/** Recording limit (keeps a note within the 25 MB upload limit with lots of margin). */
export const MAX_RECORDING_MS = 5 * 60_000;
