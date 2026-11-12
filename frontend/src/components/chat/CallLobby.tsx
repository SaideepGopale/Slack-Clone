import { Loader2, Mic, MicOff, Phone, Video, VideoOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { levelFromRms, recorderErrorMessage } from '../../lib/voice';
import type { CallMediaChoice } from './CallOverlay';

/**
 * T.33 — the pre-join lobby: see your camera, check your microphone level,
 * pick devices and decide to join muted or with the camera off — before
 * anyone else sees or hears you. The preview stream is released when you
 * join (the call opens its own with the chosen devices) or cancel.
 */
interface CallLobbyProps {
  callType: 'audio' | 'video';
  title: string;
  /** "Start call" (outgoing) or "Join call" (answering). */
  joinLabel: string;
  onJoin: (choice: CallMediaChoice) => void;
  onCancel: () => void;
}

export const CallLobby = ({ callType, title, joinLabel, onJoin, onCancel }: CallLobbyProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(callType === 'video');
  const [hasCamera, setHasCamera] = useState(callType === 'video');
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState<{ mics: MediaDeviceInfo[]; cams: MediaDeviceInfo[] }>({ mics: [], cams: [] });
  const [micId, setMicId] = useState<string | undefined>();
  const [camId, setCamId] = useState<string | undefined>();
  const [attempt, setAttempt] = useState(0);

  const release = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let context: AudioContext | null = null;
    setState('loading');
    setError(null);
    const audio: MediaTrackConstraints | boolean = micId ? { deviceId: { exact: micId } } : true;
    const video: MediaTrackConstraints | boolean = callType === 'video' ? (camId ? { deviceId: { exact: camId } } : true) : false;
    const acquire = async () => {
      if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('unsupported', 'NotSupportedError');
      try {
        return await navigator.mediaDevices.getUserMedia({ audio, video });
      } catch (err) {
        if (callType !== 'video') throw err;
        // No usable camera: preview audio only.
        const audioOnly = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        if (!cancelled) {
          setHasCamera(false);
          setCamOn(false);
        }
        return audioOnly;
      }
    };
    acquire()
      .then(async (stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        release();
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setState('ready');
        const list = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
        if (!cancelled) setDevices({ mics: list.filter((d) => d.kind === 'audioinput'), cams: list.filter((d) => d.kind === 'videoinput') });
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor || stream.getAudioTracks().length === 0) return;
        try {
          context = new Ctor();
          const analyser = context.createAnalyser();
          analyser.fftSize = 512;
          context.createMediaStreamSource(stream).connect(analyser);
          if (context.state === 'suspended') void context.resume().catch(() => undefined);
          const buffer = new Uint8Array(new ArrayBuffer(analyser.fftSize));
          const tick = () => {
            analyser.getByteTimeDomainData(buffer);
            let sum = 0;
            for (const v of buffer) sum += ((v - 128) / 128) ** 2;
            setLevel(levelFromRms(Math.sqrt(sum / buffer.length)));
            raf = requestAnimationFrame(tick);
          };
          tick();
        } catch {
          // the meter is optional
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setState('error');
        setError(
          (err as { name?: string })?.name === 'NotSupportedError'
            ? 'Calls are not supported in this browser.'
            : recorderErrorMessage(err).replace('Voice recording', 'Your microphone')
        );
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      void context?.close().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micId, camId, attempt, callType]);

  useEffect(() => () => release(), []);

  useEffect(() => {
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = micOn));
  }, [micOn, state]);
  useEffect(() => {
    streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = camOn));
  }, [camOn, state]);

  const join = () => {
    release();
    onJoin({ audio: micOn, video: callType === 'video' && hasCamera && camOn, audioDeviceId: micId, videoDeviceId: camId });
  };
  const cancel = () => {
    release();
    onCancel();
  };

  const toggle = 'flex h-11 w-11 items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
  const select = 'h-9 w-full min-w-0 rounded-lg border border-line bg-surface px-2 text-sm text-fg';

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-overlay p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="call-lobby-title">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl">
        <header className="flex items-center gap-2 border-b border-line px-5 py-3">
          {callType === 'video' ? <Video size={16} className="text-brand" aria-hidden="true" /> : <Phone size={16} className="text-brand" aria-hidden="true" />}
          <h2 id="call-lobby-title" className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{title}</h2>
          <button type="button" onClick={cancel} aria-label="Close call setup" className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-tertiary hover:text-fg">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="p-5">
          <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-neutral-900">
            {callType === 'video' && hasCamera && (
              <video ref={videoRef} autoPlay playsInline muted aria-label="Your camera preview" className={`h-full w-full -scale-x-100 object-cover ${camOn && state === 'ready' ? '' : 'invisible'}`} />
            )}
            {(callType !== 'video' || !hasCamera || !camOn || state !== 'ready') && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white/70">
                {state === 'loading' ? (
                  <>
                    <Loader2 size={20} className="animate-spin" aria-hidden="true" /> Allow camera and microphone…
                  </>
                ) : state === 'error' ? (
                  <span className="px-6 text-center" role="alert">{error}</span>
                ) : (
                  <>
                    {callType === 'video' ? <VideoOff size={22} aria-hidden="true" /> : <Mic size={22} aria-hidden="true" />}
                    {callType === 'video' ? (hasCamera ? 'Camera is off' : 'No camera found — you will join with audio') : 'Audio call'}
                  </>
                )}
              </div>
            )}
          </div>

          {state === 'ready' && (
            <div className="mt-3 flex items-center gap-2" aria-label="Microphone level">
              <Mic size={14} className="shrink-0 text-fg-subtle" aria-hidden="true" />
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-tertiary" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} aria-label="Microphone level">
                <div className={`h-full rounded-full transition-[width] duration-75 ${micOn ? 'bg-success' : 'bg-fg-subtle'}`} style={{ width: `${micOn ? Math.round(level * 100) : 0}%` }} />
              </div>
            </div>
          )}

          {state === 'ready' && (devices.mics.length > 1 || devices.cams.length > 1) && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {devices.mics.length > 1 && (
                <select aria-label="Microphone" value={micId ?? ''} onChange={(e) => setMicId(e.target.value || undefined)} className={select}>
                  <option value="">Default microphone</option>
                  {devices.mics.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>
                  ))}
                </select>
              )}
              {callType === 'video' && devices.cams.length > 1 && (
                <select aria-label="Camera" value={camId ?? ''} onChange={(e) => setCamId(e.target.value || undefined)} className={select}>
                  <option value="">Default camera</option>
                  {devices.cams.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div className="mt-5 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => setMicOn((on) => !on)}
              disabled={state !== 'ready'}
              aria-pressed={!micOn}
              aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}
              className={`${toggle} ${micOn ? 'bg-surface-tertiary text-fg hover:bg-surface-secondary' : 'bg-danger text-on-brand'}`}
            >
              {micOn ? <Mic size={18} aria-hidden="true" /> : <MicOff size={18} aria-hidden="true" />}
            </button>
            {callType === 'video' && (
              <button
                type="button"
                onClick={() => setCamOn((on) => !on)}
                disabled={state !== 'ready' || !hasCamera}
                aria-pressed={!camOn}
                aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
                className={`${toggle} ${camOn ? 'bg-surface-tertiary text-fg hover:bg-surface-secondary' : 'bg-danger text-on-brand'} disabled:opacity-50`}
              >
                {camOn ? <Video size={18} aria-hidden="true" /> : <VideoOff size={18} aria-hidden="true" />}
              </button>
            )}
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          {state === 'error' && (
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="mr-auto rounded-lg px-3 py-2 text-sm font-semibold text-brand hover:bg-brand-soft">
              Try again
            </button>
          )}
          <button type="button" onClick={cancel} className="rounded-lg px-3 py-2 text-sm font-semibold text-fg-muted hover:bg-surface-tertiary">
            Cancel
          </button>
          <button type="button" onClick={join} disabled={state !== 'ready'} className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-on-brand hover:bg-brand-hover disabled:opacity-50">
            {joinLabel}
          </button>
        </footer>
      </div>
    </div>
  );
};
