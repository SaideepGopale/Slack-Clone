import { Loader2, Mic, MicOff, Phone, PhoneIncoming, PhoneOff, ScreenShare, ScreenShareOff, Video, VideoOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import { useAuth } from '../../contexts/AuthContext';

interface CallOverlayProps {
  channelId: string;
  callType: 'audio' | 'video';
  socket: Socket;
  onEndCall: () => void;
  // The workspace this call's channel belongs to. WorkspaceSwitcher.tsx is
  // the primary guard — it prompts before letting a switch happen at all
  // while a call is active — but that's a UX nicety at one entry point, not
  // a guarantee. This prop is the actual guarantee: if it ever changes while
  // mounted (browser back/forward, a future navigation path nobody thought
  // to guard, anything), the effect below ends the call immediately rather
  // than let a WebRTC session quietly keep running for a workspace the user
  // has since navigated away from.
  workspaceId: string;
}

// Free public STUN (NAT discovery) only — no TURN (relay) server, because a
// TURN server that actually relays media traffic isn't something you get for
// free at any real scale. This means: two peers on friendly/open networks
// (most home wifi, most offices) will connect directly peer-to-peer just
// fine. Two peers where at least one is behind a symmetric NAT or a strict
// corporate firewall will fail to connect — there is no relay to fall back
// to. If that turns out to matter in practice, the fix is adding a TURN
// entry here (e.g. Open Relay Project's free tier), not app code.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Below this average byte-frequency level (0-255), nobody's considered to be
// "speaking" — tuned empirically against typical mic gain, not a physical unit.
const ACTIVE_SPEAKER_THRESHOLD = 14;
// Minimum time an id must hold the "loudest" spot before it becomes the
// active speaker (and before it can be displaced) — without this, the
// highlight flickers between participants on every noise burst.
const ACTIVE_SPEAKER_HOLD_MS = 600;
const LOCAL_SPEAKER_ID = 'local';

interface RemotePeer {
  socketId: string;
  username: string;
  stream: MediaStream;
}

interface ParticipantInfo {
  socketId: string;
  userId: string;
  username: string;
}

type CallStatus = 'requesting-media' | 'connecting' | 'connected' | 'error';

const describeMediaError = (err: unknown): string => {
  const name = err instanceof DOMException ? err.name : undefined;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera/microphone access was denied. Allow access in your browser\'s site settings and try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera or microphone was found on this device.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Your camera or microphone is already in use by another application.';
    case 'OverconstrainedError':
      return 'No camera/microphone on this device satisfies the call requirements.';
    case 'SecurityError':
      return 'Camera/microphone access requires a secure (HTTPS) connection.';
    default:
      return 'Could not access your camera or microphone. Check your device permissions and try again.';
  }
};

// 1-2 tiles: single column (each gets the full width). 3-4: two columns.
// 5+: three columns. Rows are always `auto-rows-fr` so whatever rows result
// share the available height evenly.
const gridColsClass = (tileCount: number): string => {
  if (tileCount <= 2) return 'grid-cols-1';
  if (tileCount <= 4) return 'grid-cols-2';
  return 'grid-cols-3';
};

export const CallOverlay = ({ channelId, callType, socket, onEndCall, workspaceId }: CallOverlayProps) => {
  const { user } = useAuth();
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const participantsRef = useRef<Map<string, ParticipantInfo>>(new Map());
  const onEndCallRef = useRef(onEndCall);
  const initialWorkspaceIdRef = useRef(workspaceId);

  // Active-speaker detection: one shared AudioContext + one AnalyserNode per
  // participant (local + each remote), sampled on an interval. Kept in refs
  // since they're mutated outside React's render cycle as peers come/go.
  const audioContextRef = useRef<AudioContext | null>(null);
  const analysersRef = useRef<Map<string, AnalyserNode>>(new Map());

  const [status, setStatus] = useState<CallStatus>('requesting-media');
  const [error, setError] = useState<string | null>(null);
  const [remotePeers, setRemotePeers] = useState<RemotePeer[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(callType === 'video');
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);

  useEffect(() => {
    onEndCallRef.current = onEndCall;
  }, [onEndCall]);

  // Safety-net enforcement of "a call belongs to exactly one workspace" —
  // see the workspaceId prop's doc comment above.
  useEffect(() => {
    if (workspaceId !== initialWorkspaceIdRef.current) {
      onEndCallRef.current();
    }
  }, [workspaceId]);

  const registerAudioAnalysis = (id: string, stream: MediaStream) => {
    if (stream.getAudioTracks().length === 0) return;
    try {
      if (!audioContextRef.current) audioContextRef.current = new AudioContext();
      const ctx = audioContextRef.current;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      analysersRef.current.set(id, analyser);
    } catch (err) {
      console.error('Failed to set up audio analysis for', id, err);
    }
  };

  const unregisterAudioAnalysis = (id: string) => {
    analysersRef.current.delete(id);
  };

  // Polls every analyser on a fixed interval and promotes whoever is
  // loudest — above the noise-floor threshold and past the debounce hold —
  // to "active speaker". Runs for the lifetime of the component; reads the
  // analysers map fresh each tick, so it doesn't need to restart as peers
  // join or leave.
  useEffect(() => {
    const data = new Uint8Array(256);
    let current: string | null = null;
    let lastSwitch = 0;

    const tick = () => {
      let loudestId: string | null = null;
      let loudestVolume = 0;

      analysersRef.current.forEach((analyser, id) => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;
        if (avg > loudestVolume) {
          loudestVolume = avg;
          loudestId = id;
        }
      });

      const now = Date.now();
      if (loudestVolume > ACTIVE_SPEAKER_THRESHOLD) {
        if (loudestId !== current && now - lastSwitch > ACTIVE_SPEAKER_HOLD_MS) {
          current = loudestId;
          lastSwitch = now;
          setActiveSpeakerId(loudestId);
        }
      } else if (current !== null && now - lastSwitch > ACTIVE_SPEAKER_HOLD_MS * 2) {
        current = null;
        lastSwitch = now;
        setActiveSpeakerId(null);
      }
    };

    const interval = setInterval(tick, 200);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const removePeer = (socketId: string) => {
      peerConnectionsRef.current.get(socketId)?.close();
      peerConnectionsRef.current.delete(socketId);
      pendingCandidatesRef.current.delete(socketId);
      participantsRef.current.delete(socketId);
      unregisterAudioAnalysis(socketId);
      setRemotePeers((prev) => prev.filter((p) => p.socketId !== socketId));
    };

    const createPeerConnection = (targetSocketId: string): RTCPeerConnection => {
      const existing = peerConnectionsRef.current.get(targetSocketId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peerConnectionsRef.current.set(targetSocketId, pc);

      // If we're already screen-sharing when this connection is created
      // (e.g. a third participant joins mid-share), send the screen track
      // instead of the camera track from the start.
      const activeScreenTrack = screenStreamRef.current?.getVideoTracks()[0];
      localStreamRef.current?.getTracks().forEach((track) => {
        const trackToSend = track.kind === 'video' && activeScreenTrack ? activeScreenTrack : track;
        pc.addTrack(trackToSend, localStreamRef.current!);
      });

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('webrtc:ice-candidate', {
            channelId,
            to: targetSocketId,
            candidate: e.candidate.toJSON(),
          });
        }
      };

      pc.ontrack = (e) => {
        const info = participantsRef.current.get(targetSocketId);
        const stream = e.streams[0];
        registerAudioAnalysis(targetSocketId, stream);
        setRemotePeers((prev) => {
          const withoutThis = prev.filter((p) => p.socketId !== targetSocketId);
          return [...withoutThis, { socketId: targetSocketId, username: info?.username ?? 'Guest', stream }];
        });
        setStatus('connected');
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          removePeer(targetSocketId);
        }
      };

      return pc;
    };

    const applyPendingCandidates = async (socketId: string, pc: RTCPeerConnection) => {
      const queued = pendingCandidatesRef.current.get(socketId);
      if (!queued?.length) return;
      pendingCandidatesRef.current.set(socketId, []);
      for (const candidate of queued) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('Failed to add queued ICE candidate:', err);
        }
      }
    };

    const handleExistingParticipants = async (data: { participants: ParticipantInfo[] }) => {
      for (const participant of data.participants) {
        participantsRef.current.set(participant.socketId, participant);
        const pc = createPeerConnection(participant.socketId);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('webrtc:offer', { channelId, to: participant.socketId, offer });
        } catch (err) {
          console.error('Failed to create offer for', participant.socketId, err);
        }
      }
    };

    const handlePeerJoined = (data: ParticipantInfo) => {
      participantsRef.current.set(data.socketId, data);
      // No offer sent here — the joiner initiates (see handleExistingParticipants
      // on their side), which keeps this a one-directional handshake and avoids
      // both sides racing to create competing offers ("glare").
    };

    const handleOffer = async (data: { from: string; offer: RTCSessionDescriptionInit }) => {
      const pc = createPeerConnection(data.from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        await applyPendingCandidates(data.from, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc:answer', { channelId, to: data.from, answer });
      } catch (err) {
        console.error('Failed to handle offer from', data.from, err);
      }
    };

    const handleAnswer = async (data: { from: string; answer: RTCSessionDescriptionInit }) => {
      const pc = peerConnectionsRef.current.get(data.from);
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        await applyPendingCandidates(data.from, pc);
      } catch (err) {
        console.error('Failed to handle answer from', data.from, err);
      }
    };

    const handleIceCandidate = async (data: { from: string; candidate: RTCIceCandidateInit }) => {
      const pc = peerConnectionsRef.current.get(data.from);
      if (!pc || !pc.remoteDescription) {
        // Candidate arrived before the offer/answer exchange finished — buffer it.
        const queue = pendingCandidatesRef.current.get(data.from) ?? [];
        queue.push(data.candidate);
        pendingCandidatesRef.current.set(data.from, queue);
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('Failed to add ICE candidate from', data.from, err);
      }
    };

    const handlePeerLeft = (data: { socketId: string }) => removePeer(data.socketId);

    const handleWebrtcError = (data: { message: string }) => {
      if (cancelled) return;
      setError(data.message);
      setStatus('error');
    };

    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: callType === 'video',
          audio: true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        registerAudioAnalysis(LOCAL_SPEAKER_ID, stream);

        socket.on('webrtc:existing-participants', handleExistingParticipants);
        socket.on('webrtc:peer-joined', handlePeerJoined);
        socket.on('webrtc:offer', handleOffer);
        socket.on('webrtc:answer', handleAnswer);
        socket.on('webrtc:ice-candidate', handleIceCandidate);
        socket.on('webrtc:peer-left', handlePeerLeft);
        socket.on('webrtc:error', handleWebrtcError);

        setStatus('connecting');
        socket.emit('webrtc:join', { channelId });
      } catch (err) {
        if (cancelled) return;
        console.error('getUserMedia failed:', err);
        setError(describeMediaError(err));
        setStatus('error');
      }
    };

    start();

    return () => {
      cancelled = true;
      socket.off('webrtc:existing-participants', handleExistingParticipants);
      socket.off('webrtc:peer-joined', handlePeerJoined);
      socket.off('webrtc:offer', handleOffer);
      socket.off('webrtc:answer', handleAnswer);
      socket.off('webrtc:ice-candidate', handleIceCandidate);
      socket.off('webrtc:peer-left', handlePeerLeft);
      socket.off('webrtc:error', handleWebrtcError);

      socket.emit('webrtc:leave', { channelId });

      peerConnectionsRef.current.forEach((pc) => pc.close());
      peerConnectionsRef.current.clear();
      pendingCandidatesRef.current.clear();
      participantsRef.current.clear();

      analysersRef.current.clear();
      audioContextRef.current?.close().catch(() => {});
      audioContextRef.current = null;

      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;

      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    };
  }, [channelId, callType, socket, user]);

  const toggleMic = () => {
    const next = !micOn;
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = next; });
    setMicOn(next);
  };

  const toggleCamera = () => {
    const next = !cameraOn;
    localStreamRef.current?.getVideoTracks().forEach((track) => { track.enabled = next; });
    setCameraOn(next);
  };

  // Swaps the outgoing video track on every active peer connection from the
  // camera to a captured screen/window/tab — `replaceTrack` doesn't
  // renegotiate the connection, so remote peers just start seeing new frames
  // on the same track they already have, no extra signaling needed.
  const startScreenShare = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      if (!screenTrack) return;

      screenStreamRef.current = screenStream;

      await Promise.all(
        Array.from(peerConnectionsRef.current.values()).map((pc) => {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
          return sender ? sender.replaceTrack(screenTrack) : Promise.resolve();
        })
      );

      if (localVideoRef.current) localVideoRef.current.srcObject = screenStream;

      // Fires when the user stops sharing via the browser's own native
      // "Stop sharing" bar, not just our button — must be handled the same way.
      screenTrack.onended = () => {
        stopScreenShare();
      };

      setIsScreenSharing(true);
    } catch (err) {
      // Most commonly the user cancelled the "share your screen" picker —
      // not a call-ending error, just stay on camera.
      console.error('Failed to start screen share:', err);
    }
  };

  const stopScreenShare = async () => {
    const screenStream = screenStreamRef.current;
    if (!screenStream) return;

    screenStream.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;

    const cameraTrack = localStreamRef.current?.getVideoTracks()[0];
    if (cameraTrack) {
      await Promise.all(
        Array.from(peerConnectionsRef.current.values()).map((pc) => {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
          return sender ? sender.replaceTrack(cameraTrack) : Promise.resolve();
        })
      );
    }

    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }

    setIsScreenSharing(false);
  };

  const handleEndCall = () => onEndCallRef.current();

  const totalTiles = remotePeers.length + 1;

  return (
    <div className="fixed inset-0 z-[200] bg-gray-950 flex flex-col">
      <div className="flex-1 relative overflow-hidden">
        {(status === 'connecting' || status === 'connected') && (
          <div className={`w-full h-full grid ${gridColsClass(totalTiles)} auto-rows-fr gap-3 p-3`}>
            <VideoTile
              videoRef={localVideoRef}
              username={`${user?.username ?? 'You'} (You)`}
              isLocal
              mirror={!isScreenSharing}
              muted
              isSpeaking={activeSpeakerId === LOCAL_SPEAKER_ID}
              hasVideo={callType === 'video' && (cameraOn || isScreenSharing)}
              isSharingScreen={isScreenSharing}
            />
            {remotePeers.map((peer) => (
              <RemoteVideoTile key={peer.socketId} peer={peer} isSpeaking={activeSpeakerId === peer.socketId} />
            ))}
          </div>
        )}

        {status === 'connected' && remotePeers.length === 0 && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-black/50 text-gray-200 text-sm font-medium backdrop-blur">
            Waiting for others to join…
          </div>
        )}

        {(status === 'requesting-media' || status === 'connecting' || status === 'error') && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-950/95 text-white">
            <div className="w-[min(92vw,420px)] rounded-xl border border-white/10 bg-white/10 p-6 text-center shadow-2xl backdrop-blur">
              {status === 'error' ? (
                <>
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-red-500/20 text-red-200">
                    <PhoneOff size={24} />
                  </div>
                  <h2 className="mb-2 text-lg font-bold">Call failed to start</h2>
                  <p className="mb-5 text-sm leading-6 text-gray-300">{error}</p>
                  <button
                    onClick={handleEndCall}
                    className="rounded-lg bg-white px-5 py-2.5 text-sm font-bold text-gray-950 transition hover:bg-gray-100 active:scale-95"
                  >
                    Close
                  </button>
                </>
              ) : (
                <>
                  <Loader2 className="mx-auto mb-4 animate-spin text-violet-300" size={28} />
                  <p className="text-sm font-semibold text-gray-200">
                    {status === 'requesting-media' ? 'Requesting camera/microphone access…' : `Connecting ${callType} call…`}
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {status !== 'error' && (
        <div className="shrink-0 flex items-center justify-center gap-4 py-5 bg-gray-950/80 border-t border-white/10">
          <button
            onClick={toggleMic}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition active:scale-95 ${micOn ? 'bg-white/10 text-white hover:bg-violet-600/40' : 'bg-red-600 text-white hover:bg-red-700'}`}
            title={micOn ? 'Mute microphone' : 'Unmute microphone'}
          >
            {micOn ? <Mic size={20} /> : <MicOff size={20} />}
          </button>

          {callType === 'video' && (
            <button
              onClick={toggleCamera}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition active:scale-95 ${cameraOn ? 'bg-white/10 text-white hover:bg-violet-600/40' : 'bg-red-600 text-white hover:bg-red-700'}`}
              title={cameraOn ? 'Turn camera off' : 'Turn camera on'}
            >
              {cameraOn ? <Video size={20} /> : <VideoOff size={20} />}
            </button>
          )}

          {callType === 'video' && (
            <button
              onClick={isScreenSharing ? stopScreenShare : startScreenShare}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition active:scale-95 ${
                isScreenSharing ? 'bg-violet-600 text-white hover:bg-violet-700' : 'bg-white/10 text-white hover:bg-violet-600/40'
              }`}
              title={isScreenSharing ? 'Stop sharing your screen' : 'Share your screen'}
            >
              {isScreenSharing ? <ScreenShareOff size={20} /> : <ScreenShare size={20} />}
            </button>
          )}

          <button
            onClick={handleEndCall}
            className="w-14 h-12 rounded-full bg-red-600 text-white flex items-center justify-center hover:bg-red-700 transition active:scale-95"
            title="End call"
          >
            <PhoneOff size={22} />
          </button>
        </div>
      )}
    </div>
  );
};

interface VideoTileProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  username: string;
  isLocal?: boolean;
  mirror?: boolean;
  muted?: boolean;
  isSpeaking: boolean;
  hasVideo: boolean;
  isSharingScreen?: boolean;
}

const tileBaseClass = (isSpeaking: boolean) =>
  `relative rounded-xl overflow-hidden bg-gray-900 flex items-center justify-center min-h-[160px] border-2 transition-colors duration-200 ${
    isSpeaking ? 'border-violet-500 shadow-[0_0_0_3px_rgba(139,92,246,0.35)]' : 'border-transparent'
  }`;

const VideoTile = ({ videoRef, username, mirror, muted, isSpeaking, hasVideo, isSharingScreen }: VideoTileProps) => (
  <div className={tileBaseClass(isSpeaking)}>
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={muted}
      className={`w-full h-full object-cover ${mirror ? '-scale-x-100' : ''}`}
      style={{ display: hasVideo ? 'block' : 'none' }}
    />
    {!hasVideo && (
      <div className="w-16 h-16 rounded-full bg-violet-600 flex items-center justify-center font-black text-2xl text-white">
        {username[0]?.toUpperCase() ?? '?'}
      </div>
    )}
    {isSharingScreen && (
      <span className="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-md bg-violet-600 text-white text-[11px] font-semibold">
        <ScreenShare size={12} /> Presenting
      </span>
    )}
    <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded-md bg-black/50 text-white text-xs font-semibold">
      {username}
    </span>
  </div>
);

const RemoteVideoTile = ({ peer, isSpeaking }: { peer: RemotePeer; isSpeaking: boolean }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hasVideoTrack = peer.stream.getVideoTracks().some((t) => t.enabled);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = peer.stream;
  }, [peer.stream]);

  return (
    <VideoTile
      videoRef={videoRef}
      username={peer.username}
      isSpeaking={isSpeaking}
      hasVideo={hasVideoTrack}
    />
  );
};

// ── Incoming Call Banner (ringing UI, not the WebRTC media path) ──
interface IncomingCallBannerProps {
  callerName: string;
  callType: 'audio' | 'video';
  onAccept: () => void;
  onDecline: () => void;
}

export const IncomingCallBanner = ({ callerName, callType, onAccept, onDecline }: IncomingCallBannerProps) => {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="fixed top-4 right-4 z-[300] w-80 bg-gray-900 rounded-xl shadow-2xl border border-white/10 overflow-hidden animate-in slide-in-from-top-4">
      <div className="h-1 bg-gradient-to-r from-violet-400 to-violet-600 animate-pulse" />
      <div className="p-5">
        <div className="flex items-center gap-4 mb-5">
          <div className="relative">
            <div className="w-14 h-14 rounded-full bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-white font-black text-xl">
              {callerName[0]?.toUpperCase()}
            </div>
            <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-emerald-500 border-2 border-gray-900 flex items-center justify-center">
              {callType === 'video' ? <Video size={10} className="text-white" /> : <Phone size={10} className="text-white" />}
            </div>
          </div>
          <div>
            <p className="text-white font-bold text-base">{callerName}</p>
            <p className="text-gray-400 text-sm flex items-center gap-1.5">
              <PhoneIncoming size={12} className="text-emerald-400" />
              Incoming {callType} call · {elapsed}s
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <button onClick={onDecline} className="flex-1 py-3 rounded-lg bg-red-600 hover:bg-red-700 text-white font-bold text-sm flex items-center justify-center gap-2 transition-all active:scale-95">
            <PhoneOff size={16} /> Decline
          </button>
          <button onClick={onAccept} className="flex-1 py-3 rounded-lg bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm flex items-center justify-center gap-2 transition-all active:scale-95">
            {callType === 'video' ? <Video size={16} /> : <Phone size={16} />} Accept
          </button>
        </div>
      </div>
    </div>
  );
};
