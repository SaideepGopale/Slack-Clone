import { AlertTriangle, Loader2, Mic, MicOff, Phone, PhoneIncoming, PhoneOff, ScreenShare, ScreenShareOff, Settings2, Users, Video, VideoOff, WifiOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import { useAuth } from '../../contexts/AuthContext';
import { CallType, displayCallerName, formatCallDuration, isSignalFromCallPeer, MAX_PENDING_CANDIDATES } from '../../lib/callSignalling';
import { currentIceServers, loadIceConfig } from '../../lib/iceConfig';

interface CallOverlayProps {
  channelId: string;
  callType: 'audio' | 'video';
  socket: Socket;
  onEndCall: () => void;
  /** T.33: choices made in the pre-join lobby (CallLobby). */
  initialMedia?: CallMediaChoice;
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

/*
 * T.32 (audit H4/H5, RT-8/RT-11) — call reliability:
 *  - ICE servers (STUN + optional TURN relay) come from the backend
 *    (lib/iceConfig.ts); nothing is hard-coded here.
 *  - A connection that drops is repaired with an ICE restart (by the side
 *    that made the original offer, so both ends never offer at once); only
 *    after repeated failures is a participant shown as "Connection lost".
 *  - If this browser's socket reconnects mid-call, it rejoins the call and
 *    rebuilds its connections instead of silently staying in a dead call.
 *  - Status is honest: "Waiting for others" when alone, "Reconnecting…" when
 *    the network drops — a call is never shown as connected when it is not.
 *  - Camera unavailable on a video call → joins with audio only (said so).
 *  - Camera/mic on-off is announced to the other participants, so a turned-
 *    off camera shows the person's initial instead of a black frame.
 */

// Below this average byte-frequency level (0-255), nobody's considered to be
// "speaking" — tuned empirically against typical mic gain, not a physical unit.
const ACTIVE_SPEAKER_THRESHOLD = 14;
// Minimum time an id must hold the "loudest" spot before it becomes the
// active speaker (and before it can be displaced) — without this, the
// highlight flickers between participants on every noise burst.
const ACTIVE_SPEAKER_HOLD_MS = 600;
const LOCAL_SPEAKER_ID = 'local';
// A "disconnected" connection often recovers by itself; give it this long first.
const DISCONNECT_GRACE_MS = 2500;
const MAX_ICE_RESTARTS = 3;
// The non-offering side waits this long for the other side's restart.
const FAILED_GRACE_MS = 15_000;

interface RemotePeer {
  socketId: string;
  username: string;
  stream: MediaStream;
}

interface MediaState {
  audio: boolean;
  video: boolean;
}

interface ParticipantInfo {
  socketId: string;
  userId: string;
  username: string;
  media?: MediaState;
}

type PeerState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

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

// 1 tile: centred. 2: side by side on wide screens. 3-4: 2×2. 5+: three columns.
const gridColsClass = (tileCount: number): string => {
  if (tileCount <= 1) return 'grid-cols-1';
  if (tileCount === 2) return 'grid-cols-1 sm:grid-cols-2';
  if (tileCount <= 4) return 'grid-cols-2';
  return 'grid-cols-2 lg:grid-cols-3';
};

const controlClass = (active: boolean, danger = false) =>
  `flex h-11 w-11 items-center justify-center rounded-full transition-colors active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300 ${
    danger ? 'bg-[#e5484d] text-white hover:bg-[#d13d42]' : active ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-white text-[#0b1112] hover:bg-white/90'
  }`;

export interface CallMediaChoice {
  audio: boolean;
  video: boolean;
  audioDeviceId?: string;
  videoDeviceId?: string;
}

export const CallOverlay = ({ channelId, callType, socket, onEndCall, workspaceId, initialMedia }: CallOverlayProps) => {
  const { user } = useAuth();
  // The call effect only needs to know someone is signed in — depending on the
  // user object itself would restart the call whenever it's refreshed.
  const signedIn = !!user;
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const participantsRef = useRef<Map<string, ParticipantInfo>>(new Map());
  const onEndCallRef = useRef(onEndCall);
  const initialWorkspaceIdRef = useRef(workspaceId);
  const mediaStateRef = useRef<MediaState>({ audio: initialMedia?.audio ?? true, video: callType === 'video' && (initialMedia?.video ?? true) });

  // Active-speaker detection: one shared AudioContext + one AnalyserNode per
  // participant (local + each remote), sampled on an interval. Kept in refs
  // since they're mutated outside React's render cycle as peers come/go.
  const audioContextRef = useRef<AudioContext | null>(null);
  const analysersRef = useRef<Map<string, AnalyserNode>>(new Map());

  const [mediaReady, setMediaReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const [socketLost, setSocketLost] = useState(false);
  const [participantCount, setParticipantCount] = useState(0);
  const [peerStates, setPeerStates] = useState<Record<string, PeerState>>({});
  const [remoteMedia, setRemoteMedia] = useState<Record<string, MediaState>>({});
  const [relayAvailable, setRelayAvailable] = useState<boolean | null>(null);
  const [remotePeers, setRemotePeers] = useState<RemotePeer[]>([]);
  const [micOn, setMicOn] = useState(initialMedia?.audio ?? true);
  const [cameraOn, setCameraOn] = useState(callType === 'video' && (initialMedia?.video ?? true));
  const [hasCamera, setHasCamera] = useState(callType === 'video');
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);
  const [showPeople, setShowPeople] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  // P2 Phase H: the call clock starts when the first other person connects.
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const anyConnected = Object.values(peerStates).includes('connected');
  useEffect(() => {
    if (anyConnected && connectedAt === null) setConnectedAt(Date.now());
  }, [anyConnected, connectedAt]);
  useEffect(() => {
    if (connectedAt === null) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connectedAt]);

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
      console.warn('Audio level detection unavailable for', id, err);
    }
  };

  const unregisterAudioAnalysis = (id: string) => {
    analysersRef.current.delete(id);
  };

  // Polls every analyser on a fixed interval and promotes whoever is
  // loudest — above the noise-floor threshold and past the debounce hold —
  // to "active speaker".
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

  const announceMedia = (next: MediaState) => {
    mediaStateRef.current = next;
    socket.emit('webrtc:media-state', { channelId, audio: next.audio, video: next.video });
  };

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    let needsRejoin = false;
    // Peers this side made the first offer to — the side that restarts ICE.
    const initiators = new Set<string>();
    const restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const restartAttempts = new Map<string, number>();

    const setPeerState = (socketId: string, state: PeerState) =>
      setPeerStates((prev) => (prev[socketId] === state ? prev : { ...prev, [socketId]: state }));
    const syncParticipantCount = () => setParticipantCount(participantsRef.current.size);
    const clearTimer = (socketId: string) => {
      const t = restartTimers.get(socketId);
      if (t) clearTimeout(t);
      restartTimers.delete(socketId);
    };

    const removePeer = (socketId: string) => {
      clearTimer(socketId);
      restartAttempts.delete(socketId);
      initiators.delete(socketId);
      peerConnectionsRef.current.get(socketId)?.close();
      peerConnectionsRef.current.delete(socketId);
      pendingCandidatesRef.current.delete(socketId);
      participantsRef.current.delete(socketId);
      unregisterAudioAnalysis(socketId);
      setRemotePeers((prev) => prev.filter((p) => p.socketId !== socketId));
      setPeerStates((prev) => {
        if (!(socketId in prev)) return prev;
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
      syncParticipantCount();
    };

    // Ends every connection without leaving the call (used when this
    // browser's socket dropped: the server has already removed us).
    const dropAllPeers = () => {
      for (const socketId of Array.from(participantsRef.current.keys())) removePeer(socketId);
      for (const socketId of Array.from(peerConnectionsRef.current.keys())) removePeer(socketId);
    };

    const restartIce = async (socketId: string, pc: RTCPeerConnection) => {
      if (cancelled || !initiators.has(socketId) || peerConnectionsRef.current.get(socketId) !== pc) return;
      if (pc.signalingState && pc.signalingState !== 'stable') return;
      const attempts = (restartAttempts.get(socketId) ?? 0) + 1;
      restartAttempts.set(socketId, attempts);
      if (attempts > MAX_ICE_RESTARTS) {
        setPeerState(socketId, 'failed');
        return;
      }
      try {
        pc.restartIce?.();
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        socket.emit('webrtc:offer', { channelId, to: socketId, offer });
      } catch (err) {
        console.warn('ICE restart failed for', socketId, err);
      }
    };

    const createPeerConnection = (targetSocketId: string, initiator = false): RTCPeerConnection => {
      const existing = peerConnectionsRef.current.get(targetSocketId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: currentIceServers() });
      peerConnectionsRef.current.set(targetSocketId, pc);
      if (initiator) initiators.add(targetSocketId);
      setPeerState(targetSocketId, 'connecting');

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
        if (!stream) return;
        registerAudioAnalysis(targetSocketId, stream);
        setRemotePeers((prev) => {
          const withoutThis = prev.filter((p) => p.socketId !== targetSocketId);
          return [...withoutThis, { socketId: targetSocketId, username: info?.username ?? 'Guest', stream }];
        });
      };

      pc.onconnectionstatechange = () => {
        if (peerConnectionsRef.current.get(targetSocketId) !== pc) return;
        switch (pc.connectionState) {
          case 'connected':
            clearTimer(targetSocketId);
            restartAttempts.set(targetSocketId, 0);
            setPeerState(targetSocketId, 'connected');
            break;
          case 'disconnected':
            setPeerState(targetSocketId, 'reconnecting');
            clearTimer(targetSocketId);
            restartTimers.set(
              targetSocketId,
              setTimeout(() => {
                if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') void restartIce(targetSocketId, pc);
              }, DISCONNECT_GRACE_MS)
            );
            break;
          case 'failed':
            setPeerState(targetSocketId, 'reconnecting');
            clearTimer(targetSocketId);
            if (initiators.has(targetSocketId)) {
              void restartIce(targetSocketId, pc);
            } else {
              restartTimers.set(
                targetSocketId,
                setTimeout(() => {
                  if (pc.connectionState === 'failed') setPeerState(targetSocketId, 'failed');
                }, FAILED_GRACE_MS)
              );
            }
            break;
          case 'closed':
            removePeer(targetSocketId);
            break;
          default:
            break;
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
          console.warn('Failed to add queued ICE candidate:', err);
        }
      }
    };

    const rememberMedia = (participant: ParticipantInfo) => {
      if (participant.media) setRemoteMedia((prev) => ({ ...prev, [participant.socketId]: participant.media! }));
    };

    const handleExistingParticipants = async (data: { participants: ParticipantInfo[] }) => {
      if (cancelled) return;
      setJoined(true);
      setSocketLost(false);
      // Our own current mic/camera state, for everyone already in the call.
      announceMedia(mediaStateRef.current);
      for (const participant of data.participants ?? []) {
        participantsRef.current.set(participant.socketId, participant);
        rememberMedia(participant);
        const pc = createPeerConnection(participant.socketId, true);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('webrtc:offer', { channelId, to: participant.socketId, offer });
        } catch (err) {
          console.warn('Failed to create offer for', participant.socketId, err);
        }
      }
      syncParticipantCount();
    };

    const handlePeerJoined = (data: ParticipantInfo) => {
      participantsRef.current.set(data.socketId, data);
      rememberMedia(data);
      syncParticipantCount();
      // No offer sent here — the joiner initiates (see handleExistingParticipants
      // on their side), which keeps this a one-directional handshake and avoids
      // both sides racing to create competing offers ("glare").
    };

    // FA-RT-01: only participants of THIS call (announced by the server via
    // existing-participants / peer-joined) may open a peer connection. An
    // offer from anyone else is ignored — never answered, and no local
    // microphone/camera track is attached for it. The same handler applies
    // ICE-restart offers to the existing connection (renegotiation).
    const handleOffer = async (data: { from: string; channelId?: string; offer: RTCSessionDescriptionInit }) => {
      if (!isSignalFromCallPeer(data, channelId, participantsRef.current)) return;
      const pc = createPeerConnection(data.from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        await applyPendingCandidates(data.from, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc:answer', { channelId, to: data.from, answer });
      } catch (err) {
        console.warn('Failed to handle offer from', data.from, err);
      }
    };

    const handleAnswer = async (data: { from: string; channelId?: string; answer: RTCSessionDescriptionInit }) => {
      if (!isSignalFromCallPeer(data, channelId, participantsRef.current)) return;
      const pc = peerConnectionsRef.current.get(data.from);
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        await applyPendingCandidates(data.from, pc);
      } catch (err) {
        console.warn('Failed to handle answer from', data.from, err);
      }
    };

    const handleIceCandidate = async (data: { from: string; channelId?: string; candidate: RTCIceCandidateInit }) => {
      if (!isSignalFromCallPeer(data, channelId, participantsRef.current)) return;
      const pc = peerConnectionsRef.current.get(data.from);
      if (!pc || !pc.remoteDescription) {
        // Candidate arrived before the offer/answer exchange finished — buffer it (bounded).
        const queue = pendingCandidatesRef.current.get(data.from) ?? [];
        if (queue.length >= MAX_PENDING_CANDIDATES) return;
        queue.push(data.candidate);
        pendingCandidatesRef.current.set(data.from, queue);
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.warn('Failed to add ICE candidate from', data.from, err);
      }
    };

    const handlePeerLeft = (data: { socketId: string }) => removePeer(data.socketId);

    const handleMediaState = (data: { channelId?: string; socketId?: string; audio?: boolean; video?: boolean }) => {
      if (data?.channelId !== channelId || typeof data.socketId !== 'string' || !participantsRef.current.has(data.socketId)) return;
      setRemoteMedia((prev) => ({ ...prev, [data.socketId!]: { audio: data.audio !== false, video: data.video === true } }));
    };

    const handleWebrtcError = (data: { message: string }) => {
      if (cancelled) return;
      setError(typeof data?.message === 'string' ? data.message : 'The call could not be joined.');
    };

    // T.32 (audit H5): this browser lost its connection to the server. The
    // server has already removed us from the call and told the others, so
    // our peer connections are dead too; rejoin when the socket is back.
    const handleSocketDisconnect = () => {
      if (cancelled || !localStreamRef.current) return;
      needsRejoin = true;
      setSocketLost(true);
      setJoined(false);
      dropAllPeers();
    };
    const handleSocketConnect = () => {
      if (cancelled || !needsRejoin || !localStreamRef.current) return;
      needsRejoin = false;
      socket.emit('webrtc:join', { channelId, media: mediaStateRef.current });
    };

    const getLocalMedia = async (): Promise<MediaStream> => {
      try {
        // T.33: the devices picked in the lobby (a missing device falls back below).
        const audio: MediaTrackConstraints | boolean = initialMedia?.audioDeviceId ? { deviceId: { ideal: initialMedia.audioDeviceId } } : true;
        const video: MediaTrackConstraints | boolean = callType === 'video' ? (initialMedia?.videoDeviceId ? { deviceId: { ideal: initialMedia.videoDeviceId } } : true) : false;
        return await navigator.mediaDevices.getUserMedia({ video, audio });
      } catch (err) {
        // A video call with no usable camera still works as an audio call.
        if (callType !== 'video') throw err;
        const audioOnly = await navigator.mediaDevices.getUserMedia({ video: false, audio: true }).catch(() => {
          throw err;
        });
        setHasCamera(false);
        setCameraOn(false);
        mediaStateRef.current = { ...mediaStateRef.current, video: false };
        setNotice('Your camera is unavailable, so you joined with audio only.');
        return audioOnly;
      }
    };

    const start = async () => {
      // ICE servers (incl. TURN) load alongside the media prompt; connections
      // created before they arrive are updated when they do.
      void loadIceConfig().then((config) => {
        if (cancelled) return;
        setRelayAvailable(config.relay);
        peerConnectionsRef.current.forEach((pc) => {
          try {
            pc.setConfiguration?.({ ...pc.getConfiguration?.(), iceServers: config.iceServers });
          } catch {
            // Some browsers refuse changes once gathering started; the next ICE restart uses them.
          }
        });
      });

      try {
        const stream = await getLocalMedia();
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        // T.33: start muted / camera-off as chosen in the lobby.
        stream.getAudioTracks().forEach((track) => { track.enabled = mediaStateRef.current.audio; });
        stream.getVideoTracks().forEach((track) => { track.enabled = mediaStateRef.current.video; });
        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        registerAudioAnalysis(LOCAL_SPEAKER_ID, stream);
        setMediaReady(true);

        socket.on('webrtc:existing-participants', handleExistingParticipants);
        socket.on('webrtc:peer-joined', handlePeerJoined);
        socket.on('webrtc:offer', handleOffer);
        socket.on('webrtc:answer', handleAnswer);
        socket.on('webrtc:ice-candidate', handleIceCandidate);
        socket.on('webrtc:peer-left', handlePeerLeft);
        socket.on('webrtc:media-state', handleMediaState);
        socket.on('webrtc:error', handleWebrtcError);
        socket.on('disconnect', handleSocketDisconnect);
        socket.on('connect', handleSocketConnect);

        socket.emit('webrtc:join', { channelId, media: mediaStateRef.current });
      } catch (err) {
        if (cancelled) return;
        console.warn('getUserMedia failed:', err);
        setError(describeMediaError(err));
      }
    };

    start();

    return () => {
      cancelled = true;
      restartTimers.forEach((t) => clearTimeout(t));
      restartTimers.clear();
      socket.off('webrtc:existing-participants', handleExistingParticipants);
      socket.off('webrtc:peer-joined', handlePeerJoined);
      socket.off('webrtc:offer', handleOffer);
      socket.off('webrtc:answer', handleAnswer);
      socket.off('webrtc:ice-candidate', handleIceCandidate);
      socket.off('webrtc:peer-left', handlePeerLeft);
      socket.off('webrtc:media-state', handleMediaState);
      socket.off('webrtc:error', handleWebrtcError);
      socket.off('disconnect', handleSocketDisconnect);
      socket.off('connect', handleSocketConnect);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the call is keyed on these only
  }, [channelId, callType, socket, signedIn]);

  const toggleMic = () => {
    const next = !micOn;
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = next; });
    setMicOn(next);
    announceMedia({ ...mediaStateRef.current, audio: next });
  };

  const toggleCamera = () => {
    const next = !cameraOn;
    localStreamRef.current?.getVideoTracks().forEach((track) => { track.enabled = next; });
    setCameraOn(next);
    announceMedia({ ...mediaStateRef.current, video: next || isScreenSharing });
  };

  const replaceOutgoingTrack = async (kind: 'audio' | 'video', track: MediaStreamTrack) => {
    await Promise.all(
      Array.from(peerConnectionsRef.current.values()).map((pc) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === kind);
        return sender ? sender.replaceTrack(track) : Promise.resolve();
      })
    );
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
      await replaceOutgoingTrack('video', screenTrack);
      if (localVideoRef.current) localVideoRef.current.srcObject = screenStream;

      // Fires when the user stops sharing via the browser's own native
      // "Stop sharing" bar, not just our button — must be handled the same way.
      screenTrack.onended = () => {
        void stopScreenShare();
      };

      setIsScreenSharing(true);
      announceMedia({ ...mediaStateRef.current, video: true });
    } catch (err) {
      // Most commonly the user cancelled the "share your screen" picker —
      // not a call-ending error, just stay on camera.
      console.warn('Screen share not started:', err);
    }
  };

  const stopScreenShare = async () => {
    const screenStream = screenStreamRef.current;
    if (!screenStream) return;

    screenStream.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;

    const cameraTrack = localStreamRef.current?.getVideoTracks()[0];
    if (cameraTrack) await replaceOutgoingTrack('video', cameraTrack);

    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }

    setIsScreenSharing(false);
    announceMedia({ ...mediaStateRef.current, video: cameraOn && hasCamera });
  };

  // Switch microphone / camera mid-call (where the browser supports it).
  const switchDevice = async (kind: 'audioinput' | 'videoinput', deviceId: string) => {
    const stream = localStreamRef.current;
    if (!stream) return;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia(
        kind === 'audioinput' ? { audio: { deviceId: { exact: deviceId } } } : { video: { deviceId: { exact: deviceId } } }
      );
      const track = kind === 'audioinput' ? fresh.getAudioTracks()[0] : fresh.getVideoTracks()[0];
      if (!track) return;
      const old = kind === 'audioinput' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
      track.enabled = kind === 'audioinput' ? micOn : cameraOn;
      if (!(kind === 'videoinput' && isScreenSharing)) await replaceOutgoingTrack(kind === 'audioinput' ? 'audio' : 'video', track);
      if (old) {
        stream.removeTrack(old);
        old.stop();
      }
      stream.addTrack(track);
      if (kind === 'audioinput') {
        unregisterAudioAnalysis(LOCAL_SPEAKER_ID);
        registerAudioAnalysis(LOCAL_SPEAKER_ID, stream);
      } else if (!isScreenSharing && localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (err) {
      setNotice(`That ${kind === 'audioinput' ? 'microphone' : 'camera'} could not be used: ${describeMediaError(err)}`);
    }
  };

  const handleEndCall = () => onEndCallRef.current();

  const failedPeers = remotePeers.filter((p) => peerStates[p.socketId] === 'failed');
  const status = error
    ? 'error'
    : !mediaReady
      ? 'requesting-media'
      : socketLost
        ? 'reconnecting'
        : !joined
          ? 'connecting'
          : participantCount === 0
            ? 'waiting'
            : anyConnected
              ? 'connected'
              : 'connecting';
  const totalTiles = remotePeers.length + 1;
  const callLabel = callType === 'video' ? 'Video call' : 'Audio call';

  return (
    // theme-fixed: the call screen is dark by design in both themes (index.css).
    <div role="dialog" aria-modal="true" aria-label={callLabel} className="theme-fixed fixed inset-0 z-[200] flex flex-col bg-[#0b1112] text-white animate-fade-in">
      {/* Top bar */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4">
        <div className="flex min-w-0 items-center gap-2.5 text-sm">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-white/[0.08]" aria-hidden="true">
            {callType === 'video' ? <Video size={14} /> : <Phone size={14} />}
          </span>
          <span className="font-medium">{callLabel}</span>
          <span className="text-white/35" aria-hidden="true">·</span>
          <span className="tabular-nums text-white/70" aria-live="polite">
            {status === 'connected' && connectedAt
              ? formatCallDuration(clock - connectedAt)
              : status === 'waiting'
                ? 'Waiting for others to join…'
                : status === 'reconnecting'
                  ? 'Reconnecting…'
                  : status === 'requesting-media'
                    ? 'Starting…'
                    : status === 'error'
                      ? 'Not connected'
                      : 'Connecting…'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowPeople((v) => !v)}
          aria-pressed={showPeople}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-white/80 transition-colors hover:bg-white/10"
          title="Participants"
        >
          <Users size={14} aria-hidden="true" />
          <span className="tabular-nums">{participantCount + 1}</span>
          <span className="sr-only">participants</span>
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex-1 overflow-hidden">
          {(status !== 'requesting-media' && status !== 'error') && (
            <div className={`grid h-full w-full ${gridColsClass(totalTiles)} auto-rows-fr gap-3 p-3 sm:p-4`}>
              <VideoTile
                videoRef={localVideoRef}
                username={`${user?.username ?? 'You'} (You)`}
                mirror={!isScreenSharing}
                muted
                micOn={micOn}
                isSpeaking={activeSpeakerId === LOCAL_SPEAKER_ID && micOn}
                hasVideo={(callType === 'video' && hasCamera && cameraOn) || isScreenSharing}
                isSharingScreen={isScreenSharing}
              />
              {remotePeers.map((peer) => (
                <RemoteVideoTile
                  key={peer.socketId}
                  peer={peer}
                  media={remoteMedia[peer.socketId]}
                  state={peerStates[peer.socketId] ?? 'connecting'}
                  isSpeaking={activeSpeakerId === peer.socketId}
                />
              ))}
            </div>
          )}

          {/* Banners: honest connection and device messages */}
          <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center gap-2 px-3">
            {status === 'reconnecting' && (
              <Banner tone="warning" icon={<WifiOff size={14} aria-hidden="true" />}>
                Connection lost. Reconnecting to the call…
              </Banner>
            )}
            {status === 'waiting' && (
              <Banner tone="neutral" icon={<Loader2 size={14} className="animate-spin" aria-hidden="true" />}>
                Waiting for others to join…
              </Banner>
            )}
            {failedPeers.length > 0 && (
              <Banner tone="danger" icon={<AlertTriangle size={14} aria-hidden="true" />}>
                Couldn’t connect to {failedPeers.map((p) => p.username).join(', ')}.{' '}
                {relayAvailable === false ? 'Your networks may block direct calls (no relay server is configured).' : 'Their network may be blocking the call.'}
              </Banner>
            )}
            {notice && (
              <Banner tone="neutral" onDismiss={() => setNotice(null)} icon={<VideoOff size={14} aria-hidden="true" />}>
                {notice}
              </Banner>
            )}
          </div>

          {(status === 'requesting-media' || status === 'error') && (
            <div className="absolute inset-0 flex items-center justify-center px-4">
              <div className="w-[min(92vw,400px)] rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-center">
                {status === 'error' ? (
                  <>
                    <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-[#e5484d]/15 text-[#ff8589]">
                      <PhoneOff size={20} aria-hidden="true" />
                    </div>
                    <h2 className="mb-1.5 text-base font-semibold">Couldn’t start the call</h2>
                    <p className="mb-5 text-sm leading-6 text-white/65">{error}</p>
                    <button
                      type="button"
                      onClick={handleEndCall}
                      className="rounded-lg bg-white px-5 py-2 text-sm font-semibold text-[#0b1112] transition hover:bg-white/90 active:scale-95"
                    >
                      Close
                    </button>
                  </>
                ) : (
                  <>
                    <Loader2 className="mx-auto mb-4 animate-spin text-accent-300" size={26} aria-hidden="true" />
                    <p className="text-sm font-medium text-white/85">Requesting camera/microphone access…</p>
                    <p className="mt-1 text-xs text-white/50">Allow access in your browser to join the {callType} call.</p>
                  </>
                )}
              </div>
            </div>
          )}

          {status === 'connecting' && remotePeers.length === 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
              <span className="flex items-center gap-2 rounded-full bg-white/[0.08] px-3 py-1.5 text-xs text-white/80">
                <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Connecting {callType} call…
              </span>
            </div>
          )}
        </div>

        {showPeople && (
          <aside className="absolute inset-y-0 right-0 z-20 w-72 max-w-[85vw] border-l border-white/[0.06] bg-[#111819] p-4 animate-slide-in-right sm:relative">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">In this call</h2>
              <button type="button" onClick={() => setShowPeople(false)} aria-label="Close participants" className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white">
                <X size={14} />
              </button>
            </div>
            <ul className="space-y-1">
              <ParticipantRow name={`${user?.username ?? 'You'} (You)`} micOn={micOn} cameraOn={cameraOn && hasCamera} state="connected" />
              {Array.from(participantsRef.current.values()).map((p) => (
                <ParticipantRow
                  key={p.socketId}
                  name={p.username}
                  micOn={remoteMedia[p.socketId]?.audio !== false}
                  cameraOn={remoteMedia[p.socketId]?.video === true}
                  state={peerStates[p.socketId] ?? 'connecting'}
                />
              ))}
            </ul>
          </aside>
        )}
      </div>

      {status !== 'error' && (
        <div className="relative flex shrink-0 items-center justify-center gap-3 border-t border-white/[0.06] px-4 py-4">
          <button
            type="button"
            onClick={toggleMic}
            disabled={!mediaReady}
            className={controlClass(micOn)}
            title={micOn ? 'Mute microphone' : 'Unmute microphone'}
            aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}
            aria-pressed={!micOn}
          >
            {micOn ? <Mic size={18} /> : <MicOff size={18} />}
          </button>

          {callType === 'video' && (
            <button
              type="button"
              onClick={toggleCamera}
              disabled={!mediaReady || !hasCamera}
              className={`${controlClass(cameraOn && hasCamera)} disabled:opacity-40`}
              title={!hasCamera ? 'Camera unavailable' : cameraOn ? 'Turn camera off' : 'Turn camera on'}
              aria-label={!hasCamera ? 'Camera unavailable' : cameraOn ? 'Turn camera off' : 'Turn camera on'}
              aria-pressed={!cameraOn}
            >
              {cameraOn && hasCamera ? <Video size={18} /> : <VideoOff size={18} />}
            </button>
          )}

          {callType === 'video' && (
            <button
              type="button"
              onClick={isScreenSharing ? stopScreenShare : startScreenShare}
              disabled={!mediaReady}
              className={`${controlClass(true)} ${isScreenSharing ? '!bg-accent-400 !text-[#06191b]' : ''}`}
              title={isScreenSharing ? 'Stop sharing your screen' : 'Share your screen'}
              aria-label={isScreenSharing ? 'Stop sharing your screen' : 'Share your screen'}
              aria-pressed={isScreenSharing}
            >
              {isScreenSharing ? <ScreenShareOff size={18} /> : <ScreenShare size={18} />}
            </button>
          )}

          <div className="relative">
            <button
              type="button"
              onClick={() => setShowDevices((v) => !v)}
              disabled={!mediaReady}
              className={controlClass(true)}
              title="Audio and video settings"
              aria-label="Audio and video settings"
              aria-expanded={showDevices}
            >
              <Settings2 size={18} />
            </button>
            {showDevices && <DeviceMenu callType={callType} onSelect={switchDevice} onClose={() => setShowDevices(false)} />}
          </div>

          <button
            type="button"
            onClick={handleEndCall}
            className={`${controlClass(true, true)} w-14`}
            title="End call"
            aria-label="End call"
          >
            <PhoneOff size={20} />
          </button>
        </div>
      )}
    </div>
  );
};

const Banner = ({ tone, icon, children, onDismiss }: { tone: 'neutral' | 'warning' | 'danger'; icon: React.ReactNode; children: React.ReactNode; onDismiss?: () => void }) => (
  <div
    role={tone === 'neutral' ? 'status' : 'alert'}
    className={`pointer-events-auto flex max-w-xl items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium animate-pop-in ${
      tone === 'warning' ? 'bg-[#f2a93b]/15 text-[#ffcf86]' : tone === 'danger' ? 'bg-[#e5484d]/15 text-[#ffa5a8]' : 'bg-white/[0.08] text-white/85'
    }`}
  >
    {icon}
    <span>{children}</span>
    {onDismiss && (
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="ml-1 rounded p-0.5 hover:bg-white/10">
        <X size={12} />
      </button>
    )}
  </div>
);

const ParticipantRow = ({ name, micOn, cameraOn, state }: { name: string; micOn: boolean; cameraOn: boolean; state: PeerState }) => (
  <li className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm">
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-700 text-xs font-semibold" aria-hidden="true">
      {name[0]?.toUpperCase() ?? '?'}
    </span>
    <span className="min-w-0 flex-1 truncate">{name}</span>
    {state !== 'connected' && <span className="text-[11px] text-white/50">{state === 'failed' ? 'Not connected' : state === 'reconnecting' ? 'Reconnecting' : 'Joining'}</span>}
    {micOn ? <Mic size={13} className="text-white/50" aria-label="Microphone on" /> : <MicOff size={13} className="text-[#ff8589]" aria-label="Muted" />}
    {cameraOn ? <Video size={13} className="text-white/50" aria-label="Camera on" /> : <VideoOff size={13} className="text-white/35" aria-label="Camera off" />}
  </li>
);

const DeviceMenu = ({ callType, onSelect, onClose }: { callType: CallType; onSelect: (kind: 'audioinput' | 'videoinput', id: string) => void; onClose: () => void }) => {
  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  useEffect(() => {
    let alive = true;
    const list = navigator.mediaDevices?.enumerateDevices;
    if (!list) {
      setDevices([]);
      return;
    }
    navigator.mediaDevices.enumerateDevices().then(
      (all) => alive && setDevices(all),
      () => alive && setDevices([])
    );
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      alive = false;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const mics = devices?.filter((d) => d.kind === 'audioinput') ?? [];
  const cams = devices?.filter((d) => d.kind === 'videoinput') ?? [];
  return (
    <div role="dialog" aria-label="Audio and video settings" className="absolute bottom-14 left-1/2 z-30 w-72 -translate-x-1/2 rounded-xl border border-white/10 bg-[#141c1d] p-3 text-left shadow-2xl animate-pop-in">
      {devices === null ? (
        <p className="text-xs text-white/60">Loading devices…</p>
      ) : mics.length === 0 && cams.length === 0 ? (
        <p className="text-xs text-white/60">This browser does not let SmartConnect choose devices.</p>
      ) : (
        <div className="space-y-3">
          {mics.length > 0 && (
            <label className="block text-xs text-white/60">
              Microphone
              <select onChange={(e) => onSelect('audioinput', e.target.value)} defaultValue="" className="mt-1 block w-full rounded-md border border-white/10 bg-[#0b1112] px-2 py-1.5 text-sm text-white">
                <option value="" disabled>Choose a microphone</option>
                {mics.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>
                ))}
              </select>
            </label>
          )}
          {callType === 'video' && cams.length > 0 && (
            <label className="block text-xs text-white/60">
              Camera
              <select onChange={(e) => onSelect('videoinput', e.target.value)} defaultValue="" className="mt-1 block w-full rounded-md border border-white/10 bg-[#0b1112] px-2 py-1.5 text-sm text-white">
                <option value="" disabled>Choose a camera</option>
                {cams.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  );
};

interface VideoTileProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  username: string;
  mirror?: boolean;
  muted?: boolean;
  micOn: boolean;
  isSpeaking: boolean;
  hasVideo: boolean;
  isSharingScreen?: boolean;
  state?: PeerState;
}

const VideoTile = ({ videoRef, username, mirror, muted, micOn, isSpeaking, hasVideo, isSharingScreen, state = 'connected' }: VideoTileProps) => (
  <div
    className={`relative flex min-h-[150px] items-center justify-center overflow-hidden rounded-2xl bg-[#151d1e] ring-2 transition-shadow duration-200 animate-scale-in ${
      isSpeaking ? 'ring-accent-400' : 'ring-transparent'
    }`}
  >
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={muted}
      className={`h-full w-full object-cover ${mirror ? '-scale-x-100' : ''}`}
      style={{ display: hasVideo ? 'block' : 'none' }}
    />
    {!hasVideo && (
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent-700 text-2xl font-semibold text-white" aria-hidden="true">
        {username[0]?.toUpperCase() ?? '?'}
      </div>
    )}
    {state !== 'connected' && (
      <div className="absolute inset-0 flex items-center justify-center bg-black/45">
        <span className="flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white/85">
          {state === 'failed' ? <AlertTriangle size={12} aria-hidden="true" /> : <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
          {state === 'failed' ? 'Connection lost' : state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
        </span>
      </div>
    )}
    {isSharingScreen && (
      <span className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-accent-400 px-2 py-0.5 text-[11px] font-semibold text-[#06191b]">
        <ScreenShare size={12} aria-hidden="true" /> Presenting
      </span>
    )}
    <span className="absolute bottom-2 left-2 flex max-w-[85%] items-center gap-1.5 rounded-md bg-black/55 px-2 py-0.5 text-xs font-medium text-white">
      {!micOn && <MicOff size={12} className="text-[#ff8589]" aria-label="Muted" />}
      <span className="truncate">{username}</span>
    </span>
  </div>
);

const RemoteVideoTile = ({ peer, media, state, isSpeaking }: { peer: RemotePeer; media?: MediaState; state: PeerState; isSpeaking: boolean }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  // The announced camera state wins (a disabled remote track still "exists").
  const hasVideoTrack = peer.stream.getVideoTracks().length > 0 && media?.video !== false;

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = peer.stream;
  }, [peer.stream]);

  return (
    <VideoTile
      videoRef={videoRef}
      username={peer.username}
      micOn={media?.audio !== false}
      isSpeaking={isSpeaking}
      hasVideo={hasVideoTrack}
      state={state}
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
  // FA-RT-02: these values arrived over the socket. WorkspaceLayout validates
  // them first; this keeps the ringing UI renderable even if anything slips
  // through (a non-text name used to throw on `callerName[0]` or render an
  // object). An unknown type is shown as audio, the type that never uses the camera.
  const name = displayCallerName(callerName);
  const kind: CallType = callType === 'video' ? 'video' : 'audio';

  useEffect(() => {
    // Warm the ICE configuration so accepting connects without waiting.
    void loadIceConfig();
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      role="alertdialog"
      aria-label={`Incoming ${kind} call from ${name}`}
      className="theme-fixed fixed right-4 top-4 z-[300] w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-white/10 bg-[#111819] text-white shadow-2xl animate-slide-up"
    >
      <div className="p-4">
        <div className="mb-4 flex items-center gap-3">
          <div className="relative">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-700 text-lg font-semibold">
              {name.charAt(0).toUpperCase()}
            </div>
            <span className="absolute -inset-1 animate-ping rounded-full border border-accent-400/50" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold" title={name}>{name}</p>
            <p className="flex items-center gap-1.5 text-xs text-white/60">
              <PhoneIncoming size={12} className="text-accent-300" aria-hidden="true" />
              Incoming {kind} call · <span className="tabular-nums">{elapsed}s</span>
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <button type="button" onClick={onDecline} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#e5484d] py-2.5 text-sm font-semibold transition-colors hover:bg-[#d13d42] active:scale-95">
            <PhoneOff size={15} aria-hidden="true" /> Decline
          </button>
          <button type="button" onClick={onAccept} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-600 active:scale-95">
            {kind === 'video' ? <Video size={15} aria-hidden="true" /> : <Phone size={15} aria-hidden="true" />} Accept
          </button>
        </div>
      </div>
    </div>
  );
};
