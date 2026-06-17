import { ZegoUIKitPrebuilt } from '@zegocloud/zego-uikit-prebuilt';
import { Phone, PhoneIncoming, PhoneOff, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';

interface CallOverlayProps {
  channelId: string;
  callType: 'audio' | 'video';
  onEndCall: () => void;
}

export const CallOverlay = ({
  channelId,
  callType,
  onEndCall,
}: CallOverlayProps) => {
  const { user } = useAuth();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || !user) return;

    // Apni .env se keys uthana
    const appID = Number(import.meta.env.VITE_ZEGO_APP_ID);
    const serverSecret = import.meta.env.VITE_ZEGO_SERVER_SECRET;

    if (!appID || !serverSecret) {
      console.error("ZegoCloud keys missing in .env!");
      return;
    }

    // Ek unique token banana (Channel ID hi humara private Room ID banega)
    const kitToken = ZegoUIKitPrebuilt.generateKitTokenForTest(
      appID,
      serverSecret,
      channelId, // Room ID - isse har channel ka call alag rahega
      user.id,
      user.username || 'User'
    );

    const zp = ZegoUIKitPrebuilt.create(kitToken);

    // Call UI setup karna
    zp.joinRoom({
      container: containerRef.current,
      scenario: {
        mode: ZegoUIKitPrebuilt.GroupCall, // Isse 3+ log ek sath jud payenge
      },
      turnOnMicrophoneWhenJoining: true,
      turnOnCameraWhenJoining: callType === 'video',
      showPreJoinView: false, // Seedha call mein entry
      showLeaveRoomConfirmDialog: false,
      onLeaveRoom: () => {
        onEndCall(); // Jab red button dabaye, toh wapas active state mein le aao
      },
    });

    return () => {
      if (zp) {
        zp.destroy();
      }
    };
  }, [channelId, callType, onEndCall, user]);

  return (
    <div className="fixed inset-0 z-[200] bg-gray-950 flex flex-col">
      {/* ZegoCloud ka UI is div ke andar auto-inject ho jayega */}
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
};


// ── Incoming Call Banner (Ringing ke liye same rahega) ──
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
          <button onClick={onDecline} className="flex-1 py-3 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm flex items-center justify-center gap-2 transition-all active:scale-95">
            <PhoneOff size={16} /> Decline
          </button>
          <button onClick={onAccept} className="flex-1 py-3 rounded-xl bg-green-600 hover:bg-green-700 text-white font-bold text-sm flex items-center justify-center gap-2 transition-all active:scale-95">
            {callType === 'video' ? <Video size={16} /> : <Phone size={16} />} Accept
          </button>
        </div>
      </div>
    </div>
  );
};