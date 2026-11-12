import { Download, Loader2, Mic, Pause, Play } from 'lucide-react';
import { KeyboardEvent, MouseEvent, useEffect, useRef, useState } from 'react';
import { formatDuration } from '../../../lib/voice';

/**
 * Voice-message player (T.33): play/pause, a seekable waveform (mouse, touch
 * and keyboard), elapsed/total time, playback speed and download.
 *
 * - The waveform and duration come from the note's attachment (recorded with
 *   it); notes without them get neutral bars and the browser's duration.
 * - Chrome writes WebM recordings without a duration header (duration =
 *   Infinity until the file is scanned) — handled by the standard seek-to-end
 *   probe when no stored duration exists.
 * - Starting one note pauses any other playing note.
 */
const SPEEDS = [1, 1.5, 2] as const;
const FALLBACK_BARS = Array.from({ length: 40 }, (_, i) => 30 + ((i * 37) % 40));

let activeAudio: HTMLAudioElement | null = null;

interface VoiceMessagePlayerProps {
  src: string | null;
  durationMs?: number | null;
  waveform?: number[] | null;
  label?: string;
  onDownload?: () => void;
  downloading?: boolean;
}

export const VoiceMessagePlayer = ({ src, durationMs, waveform, label = 'Voice message', onDownload, downloading = false }: VoiceMessagePlayerProps) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const [speedIndex, setSpeedIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const probingRef = useRef(false);

  const storedSeconds = durationMs && durationMs > 0 ? durationMs / 1000 : null;
  const duration = storedSeconds ?? mediaDuration ?? 0;
  const bars = waveform && waveform.length > 0 ? waveform : FALLBACK_BARS;
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;

  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setFailed(false);
  }, [src]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (audio && activeAudio === audio) activeAudio = null;
    };
  }, []);

  const onLoadedMetadata = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (Number.isFinite(audio.duration)) {
      setMediaDuration(audio.duration);
    } else if (!storedSeconds) {
      // WebM without a duration header: seek far past the end so the browser
      // computes it, then come back.
      probingRef.current = true;
      audio.currentTime = 1e101;
    }
  };

  const onDurationChange = () => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    setMediaDuration(audio.duration);
    if (probingRef.current) {
      probingRef.current = false;
      audio.currentTime = 0;
    }
  };

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio || !src) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (activeAudio && activeAudio !== audio) activeAudio.pause();
    activeAudio = audio;
    audio.playbackRate = SPEEDS[speedIndex];
    try {
      await audio.play();
    } catch {
      setFailed(true);
    }
  };

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || duration <= 0) return;
    const clamped = Math.max(0, Math.min(duration, seconds));
    audio.currentTime = clamped;
    setCurrent(clamped);
  };

  const onBarsClick = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    seekTo(((e.clientX - rect.left) / rect.width) * duration);
  };

  const onBarsKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 15 : 5;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') seekTo(current + step);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') seekTo(current - step);
    else if (e.key === 'Home') seekTo(0);
    else if (e.key === 'End') seekTo(duration);
    else if (e.key === ' ' || e.key === 'Enter') void toggle();
    else return;
    e.preventDefault();
  };

  const cycleSpeed = () => {
    const next = (speedIndex + 1) % SPEEDS.length;
    setSpeedIndex(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
  };

  return (
    <div className="mt-2 flex w-[320px] max-w-full items-center gap-2.5 rounded-2xl border border-line bg-surface-secondary px-2.5 py-2" role="group" aria-label={label}>
      {src && (
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onLoadedMetadata={onLoadedMetadata}
          onDurationChange={onDurationChange}
          onTimeUpdate={() => !probingRef.current && setCurrent(audioRef.current?.currentTime ?? 0)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setCurrent(0);
            if (audioRef.current) audioRef.current.currentTime = 0;
          }}
          onError={() => setFailed(true)}
          className="hidden"
        />
      )}
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={!src || failed}
        aria-label={playing ? `Pause ${label}` : `Play ${label}`}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand shadow-sm transition-colors hover:bg-brand-hover disabled:opacity-50"
      >
        {!src ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} className="translate-x-px" aria-hidden="true" />}
      </button>

      <div className="min-w-0 flex-1">
        <div
          role="slider"
          tabIndex={src ? 0 : -1}
          aria-label={`Seek ${label}`}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          aria-valuetext={`${formatDuration(current * 1000)} of ${formatDuration(duration * 1000)}`}
          onClick={onBarsClick}
          onKeyDown={onBarsKey}
          className="flex h-8 cursor-pointer items-center gap-[2px] rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          {bars.map((peak, i) => {
            const played = (i + 0.5) / bars.length <= progress;
            return (
              <span
                key={i}
                aria-hidden="true"
                className={`w-[3px] shrink-0 rounded-full transition-colors ${played ? 'bg-brand' : 'bg-fg-subtle/40'}`}
                style={{ height: `${Math.max(12, peak)}%` }}
              />
            );
          })}
        </div>
        <div className="mt-0.5 flex items-center justify-between text-[11px] tabular-nums text-fg-subtle">
          <span className="inline-flex items-center gap-1">
            <Mic size={11} aria-hidden="true" />
            {failed ? 'Could not play' : playing || current > 0 ? formatDuration(current * 1000) : formatDuration(duration * 1000)}
          </span>
          {(playing || current > 0) && !failed && <span>{formatDuration(duration * 1000)}</span>}
        </div>
      </div>

      <button
        type="button"
        onClick={cycleSpeed}
        disabled={!src}
        aria-label={`Playback speed ${SPEEDS[speedIndex]}×`}
        className="shrink-0 rounded-md px-1.5 py-1 text-xs font-semibold tabular-nums text-fg-muted transition-colors hover:bg-surface-tertiary hover:text-fg disabled:opacity-50"
      >
        {SPEEDS[speedIndex]}×
      </button>
      {onDownload && (
        <button
          type="button"
          onClick={onDownload}
          disabled={downloading}
          aria-label={`Download ${label}`}
          className="shrink-0 rounded-md p-1.5 text-fg-muted transition-colors hover:bg-surface-tertiary hover:text-fg disabled:opacity-50"
        >
          {downloading ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
        </button>
      )}
    </div>
  );
};
