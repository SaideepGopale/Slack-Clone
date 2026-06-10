import React, { useEffect, useRef, useState } from 'react';
import {
  Mic, MicOff, Video, VideoOff, MonitorUp, PhoneOff,
  Phone, PhoneIncoming, Monitor,
} from 'lucide-react';

interface CallOverlayProps {
  callType: 'audio' | 'video';
  isMuted: boolean;
  isVideoOff: boolean;
  isSharingScreen: boolean;
  callerName?: string;
  localVideoRef: React.RefObject<HTMLVideoElement>;
  remoteVideoRef: React.RefObject<HTMLVideoElement>;
  onToggleMute: () => void;
  onToggleVideo: () => void;
  onScreenShare: () => void;
  onEndCall: () => void;
}

export const CallOverlay = ({
  callType,
  isMuted,
  isVideoOff,
  isSharingScreen,
  callerName,
  localVideoRef,
  remoteVideoRef,
  onToggleMute,
  onToggleVideo,
  onScreenShare,
  onEndCall,
}: CallOverlayProps) => {
  const [duration, setDuration] = useState(0);

  // Call duration timer
  useEffect(() => {
    const timer = setInterval(() => setDuration(d => d + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  return (
    <div className="fixed inset-0 z-[200] bg-gray-950 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-gray-900/80 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-green-400 animate-pulse" />
          <span className="text-white font-semibold text-sm">
            {callType === 'video' ? 'Video Call' : 'Audio Call'}
            {isSharingScreen && (
              <span className="ml-2 px-2 py-0.5 bg-blue-600 text-white text-xs rounded-full inline-flex items-center gap-1">
                <Monitor size={10} /> Sharing screen
              </span>
            )}
          </span>
        </div>
        <span className="text-gray-400 text-sm font-mono">{formatDuration(duration)}</span>
      </div>

      {/* Video area */}
      <div className="flex-1 relative overflow-hidden">
        {callType === 'video' ? (
          <>
            {/* Remote video — full background */}
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full h-full object-cover"
            />
            {/* Remote audio-only placeholder */}
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              {/* shown when remote video is black / audio only */}
            </div>
            {/* Local video — picture-in-picture */}
            <div className="absolute bottom-6 right-6 w-40 h-28 rounded-2xl overflow-hidden border-2 border-white/20 shadow-2xl bg-gray-800">
              {isVideoOff ? (
                <div className="w-full h-full flex items-center justify-center bg-gray-800">
                  <div className="w-12 h-12 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-lg">
                    You
                  </div>
                </div>
              ) : (
                <video ref={localVideoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
              )}
            </div>
          </>
        ) : (
          /* Audio-only layout */
          <div className="w-full h-full flex flex-col items-center justify-center gap-6">
            <div className="relative">
              <div className="w-28 h-28 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-black text-4xl shadow-2xl">
                {callerName?.[0]?.toUpperCase() ?? '?'}
              </div>
              {/* Pulse rings */}
              <div className="absolute inset-0 rounded-full border-2 border-blue-400/40 animate-ping" />
              <div className="absolute -inset-3 rounded-full border border-blue-400/20 animate-ping [animation-delay:0.3s]" />
            </div>
            <div className="text-center">
              <p className="text-white text-xl font-bold">{callerName ?? 'Unknown'}</p>
              <p className="text-gray-400 text-sm mt-1">Audio call · {formatDuration(duration)}</p>
            </div>
            {/* Hidden video elements still needed for WebRTC tracks */}
            <video ref={remoteVideoRef} autoPlay playsInline className="hidden" />
            <video ref={localVideoRef} autoPlay muted playsInline className="hidden" />
          </div>
        )}
      </div>

      {/* Controls bar */}
      <div className="px-6 py-6 bg-gray-900/80 backdrop-blur-sm flex items-center justify-center gap-4">
        {/* Mute */}
        <button
          onClick={onToggleMute}
          className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${
            isMuted ? 'bg-red-500 hover:bg-red-600' : 'bg-gray-700 hover:bg-gray-600'
          }`}
          aria-label={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? <MicOff size={22} className="text-white" /> : <Mic size={22} className="text-white" />}
        </button>

        {/* Camera (video calls only) */}
        {callType === 'video' && (
          <button
            onClick={onToggleVideo}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${
              isVideoOff ? 'bg-red-500 hover:bg-red-600' : 'bg-gray-700 hover:bg-gray-600'
            }`}
            aria-label={isVideoOff ? 'Enable camera' : 'Disable camera'}
          >
            {isVideoOff ? <VideoOff size={22} className="text-white" /> : <Video size={22} className="text-white" />}
          </button>
        )}

        {/* Screen share (video calls only) */}
        {callType === 'video' && (
          <button
            onClick={onScreenShare}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${
              isSharingScreen ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-700 hover:bg-gray-600'
            }`}
            aria-label={isSharingScreen ? 'Stop sharing' : 'Share screen'}
          >
            <MonitorUp size={22} className="text-white" />
          </button>
        )}

        {/* End call */}
        <button
          onClick={onEndCall}
          className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-700 flex items-center justify-center transition-all shadow-lg shadow-red-900/40"
          aria-label="End call"
        >
          <PhoneOff size={26} className="text-white" />
        </button>
      </div>
    </div>
  );
};

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
    <div className="fixed top-4 right-4 z-[300] w-80 bg-gray-900 rounded-2xl shadow-2xl border border-white/10 overflow-hidden animate-in slide-in-from-top-4">
      {/* Animated top bar */}
      <div className="h-1 bg-gradient-to-r from-green-400 to-blue-500 animate-pulse" />

      <div className="p-5">
        <div className="flex items-center gap-4 mb-5">
          <div className="relative">
            <div className="w-14 h-14 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-black text-xl">
              {callerName[0]?.toUpperCase()}
            </div>
            <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-green-500 border-2 border-gray-900 flex items-center justify-center">
              {callType === 'video' ? <Video size={10} className="text-white" /> : <Phone size={10} className="text-white" />}
            </div>
          </div>
          <div>
            <p className="text-white font-bold text-base">{callerName}</p>
            <p className="text-gray-400 text-sm flex items-center gap-1.5">
              <PhoneIncoming size={12} className="text-green-400" />
              Incoming {callType} call · {elapsed}s
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onDecline}
            className="flex-1 py-3 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm flex items-center justify-center gap-2 transition-all active:scale-95"
          >
            <PhoneOff size={16} />
            Decline
          </button>
          <button
            onClick={onAccept}
            className="flex-1 py-3 rounded-xl bg-green-600 hover:bg-green-700 text-white font-bold text-sm flex items-center justify-center gap-2 transition-all active:scale-95"
          >
            {callType === 'video' ? <Video size={16} /> : <Phone size={16} />}
            Accept
          </button>
        </div>
      </div>
    </div>
  );
};
