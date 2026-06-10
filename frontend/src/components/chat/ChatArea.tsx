import axios from 'axios';
import { format } from 'date-fns';
import EmojiPicker from 'emoji-picker-react';
import {
    AtSign, Bold,
    Code2,
    Download,
    Italic,
    List, ListOrdered,
    Pencil,
    Phone,
    Plus,
    Quote, Reply,
    Send,
    Smile,
    Strikethrough,
    Trash2,
    Underline,
    Video,
    X,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import { Channel, Message, User } from '../../types';
import { CallOverlay, IncomingCallBanner } from './CallOverlay';

interface Reaction { emoji: string; count: number; }
interface ChatMessage extends Message { reactions: Reaction[]; }
interface FileData { url: string; name: string; type: string; }

interface ChatAreaProps {
  channel: Channel;
  socket: Socket;
  onlineUsers?: User[];
}

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function renderFormattedText(text: string): { __html: string } {
  const escaped = escapeHtml(text);
  return {
    __html: escaped
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/~~(.*?)~~/g, '<s>$1</s>')
      .replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u>$1</u>')
      .replace(/`(.*?)`/g, '<code class="bg-gray-100 px-1 py-0.5 rounded text-sm">$1</code>')
      .replace(/\n/g, '<br/>'),
  };
}

export const ChatArea = ({ channel, socket, onlineUsers = [] }: ChatAreaProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [content, setContent] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showMentionBox, setShowMentionBox] = useState(false);
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // ── WebRTC state ──────────────────────────────────────────────────────────
  const [isCalling, setIsCalling] = useState(false);
  const [callType, setCallType] = useState<'audio' | 'video' | null>(null);
  const [incomingCall, setIncomingCall] = useState<{
    offer: RTCSessionDescriptionInit;
    from: string;
    callerName: string;
    type: 'audio' | 'video';
  } | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isSharingScreen, setIsSharingScreen] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStream = useRef<MediaStream | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const screenSenderRef = useRef<RTCRtpSender | null>(null);

  // ── End call ─────────────────────────────────────────────────────────────
  const endCall = useCallback(() => {
    localStream.current?.getTracks().forEach(t => t.stop());
    peerConnection.current?.close();
    peerConnection.current = null;
    screenSenderRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    socket.emit('call:end', { channelId: channel.id });
    setIncomingCall(null);
    setIsCalling(false);
    setCallType(null);
    setIsMuted(false);
    setIsVideoOff(false);
    setIsSharingScreen(false);
  }, [socket, channel.id]);

  // ── Decline incoming call ─────────────────────────────────────────────────
  const declineCall = useCallback(() => {
    socket.emit('call:end', { channelId: channel.id });
    setIncomingCall(null);
  }, [socket, channel.id]);

  // ── Call socket events ────────────────────────────────────────────────────
  useEffect(() => {
    const handleIncoming = ({
      offer, from, type,
    }: { offer: RTCSessionDescriptionInit; from: string; type: 'audio' | 'video' }) => {
      const caller = onlineUsers.find(u => u.id === from);
      setIncomingCall({ offer, from, type, callerName: caller?.username ?? 'Someone' });
    };
    const handleAnswered = async ({ answer }: { answer: RTCSessionDescriptionInit }) => {
      try {
        await peerConnection.current?.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) { console.error('setRemoteDescription error:', err); }
    };
    const handleIceCandidate = async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      try {
        if (candidate && peerConnection.current) {
          await peerConnection.current.addIceCandidate(new RTCIceCandidate(candidate));
        }
      } catch (err) { console.error('addIceCandidate error:', err); }
    };

    socket.on('call:incoming', handleIncoming);
    socket.on('call:answered', handleAnswered);
    socket.on('call:ice-candidate', handleIceCandidate);
    socket.on('call:ended', endCall);

    return () => {
      socket.off('call:incoming', handleIncoming);
      socket.off('call:answered', handleAnswered);
      socket.off('call:ice-candidate', handleIceCandidate);
      socket.off('call:ended', endCall);
    };
  }, [socket, endCall, onlineUsers]);

  // ── Build peer connection ─────────────────────────────────────────────────
  const buildPeerConnection = (stream: MediaStream) => {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    pc.ontrack = (event) => {
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = event.streams[0];
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('call:ice-candidate', { candidate: event.candidate, channelId: channel.id });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        endCall();
      }
    };
    return pc;
  };

  // ── Start call ────────────────────────────────────────────────────────────
  const startCall = async (type: 'audio' | 'video') => {
    try {
      setCallType(type);
      setIsCalling(true);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === 'video',
      });
      localStream.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const pc = buildPeerConnection(stream);
      peerConnection.current = pc;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('call:start', { offer, type, channelId: channel.id });
    } catch (err) {
      console.error('startCall error:', err);
      setIsCalling(false);
      setCallType(null);
    }
  };

  // ── Answer call ───────────────────────────────────────────────────────────
  const answerCall = async () => {
    if (!incomingCall) return;
    try {
      setCallType(incomingCall.type);
      setIsCalling(true);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: incomingCall.type === 'video',
      });
      localStream.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const pc = buildPeerConnection(stream);
      peerConnection.current = pc;

      await pc.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('call:answer', { answer, channelId: channel.id });
      setIncomingCall(null);
    } catch (err) {
      console.error('answerCall error:', err);
      setIsCalling(false);
      setCallType(null);
    }
  };

  // ── Screen share ──────────────────────────────────────────────────────────
  const toggleScreenShare = async () => {
    if (!peerConnection.current) return;

    if (isSharingScreen) {
      // Stop sharing — switch back to camera
      try {
        const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const cameraTrack = cameraStream.getVideoTracks()[0];
        if (screenSenderRef.current) {
          await screenSenderRef.current.replaceTrack(cameraTrack);
        }
        if (localVideoRef.current) localVideoRef.current.srcObject = cameraStream;
        // Update local stream video track
        const oldVideo = localStream.current?.getVideoTracks()[0];
        if (oldVideo) localStream.current?.removeTrack(oldVideo);
        localStream.current?.addTrack(cameraTrack);
        setIsSharingScreen(false);
      } catch (err) { console.error('stopScreenShare error:', err); }
    } else {
      // Start sharing screen
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const screenTrack = screenStream.getVideoTracks()[0];

        // Find the video sender; if none exists yet (audio-only call), add one.
        let sender = peerConnection.current.getSenders().find(s => s.track?.kind === 'video');
        if (!sender) {
          sender = peerConnection.current.addTrack(screenTrack, screenStream);
        } else {
          await sender.replaceTrack(screenTrack);
        }

        screenSenderRef.current = sender;
        if (localVideoRef.current) localVideoRef.current.srcObject = screenStream;
        setIsSharingScreen(true);

        // Auto-stop when user clicks browser's "Stop sharing"
        screenTrack.onended = () => toggleScreenShare();
      } catch (err) { console.error('startScreenShare error:', err); }
    }
  };

  // ── Toggle mute / video ───────────────────────────────────────────────────
  const toggleMute = () => {
    const track = localStream.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setIsMuted(!track.enabled);
  };

  const toggleVideo = () => {
    const track = localStream.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setIsVideoOff(!track.enabled);
  };

  // ── Fetch messages ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!channel) return;
    const fetchMessages = async () => {
      try {
        const res = await axios.get<ChatMessage[]>(`/api/channels/${channel.id}/messages`);
        setMessages(res.data.map(m => ({ ...m, reactions: m.reactions ?? [] })));
        socket.emit('channel:join', channel.id);
      } catch (err) { 
        console.error('fetchMessages error:', err);
        setError('Failed to load messages');
      }
    };
    fetchMessages();

    const handleMessage = (message: ChatMessage) => {
      setMessages(prev => {
        // Remove optimistic message if it exists
        const filtered = prev.filter(m => !m.id.startsWith('temp-'));
        if (filtered.find(m => m.id === message.id)) return filtered;
        return [...filtered, { ...message, reactions: message.reactions ?? [] }];
      });
    };
    const handleUpdate = (updated: ChatMessage) => setMessages(prev => prev.map(m => m.id === updated.id ? updated : m));
    const handleDelete = (id: string) => setMessages(prev => prev.filter(m => m.id !== id));
    const handleError = (data: { error: string }) => {
      console.error('Socket error:', data.error);
      setError(data.error);
      setMessages(prev => prev.filter(m => !m.id.startsWith('temp-')));
      setTimeout(() => setError(null), 5000);
    };

    socket.on('message:received', handleMessage);
    socket.on('message:updated', handleUpdate);
    socket.on('message:deleted', handleDelete);
    socket.on('message:error', handleError);
    return () => {
      socket.off('message:received', handleMessage);
      socket.off('message:updated', handleUpdate);
      socket.off('message:deleted', handleDelete);
      socket.off('message:error', handleError);
    };
  }, [channel, socket]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

// ── Toolbar Button Component ──────────────────────────────────────────────
interface ToolbarButtonProps {
  icon: React.ReactNode;
  tooltip: string;
  onClick: () => void;
  ariaLabel: string;
}

const ToolbarButton: React.FC<ToolbarButtonProps> = ({ icon, tooltip, onClick, ariaLabel }) => {
  const [showTooltip, setShowTooltip] = React.useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onMouseDown={(e) => {
          e.preventDefault();
          onClick();
        }}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 active:bg-gray-200 rounded-md transition-all duration-150 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
        aria-label={ariaLabel}
      >
        {icon}
      </button>
      {showTooltip && (
        <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 text-white text-xs rounded-md whitespace-nowrap z-50 pointer-events-none animate-fade-in">
          {tooltip}
        </div>
      )}
    </div>
  );
};

// ── Toolbar Separator ─────────────────────────────────────────────────────
const ToolbarSeparator: React.FC = () => (
  <div className="w-px h-6 bg-gray-200 mx-1" role="separator" aria-orientation="vertical" />
);

// ── Formatting ────────────────────────────────────────────────────────────
  const applyFormat = (prefix: string, suffix: string = prefix) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    setContent((currentContent) => {
      const selected = currentContent.substring(start, end);
      const next = currentContent.substring(0, start) + prefix + selected + suffix + currentContent.substring(end);
      setTimeout(() => {
        textarea.focus();
        textarea.selectionStart = start + prefix.length;
        textarea.selectionEnd = end + prefix.length;
      }, 0);
      return next;
    });
  };

  // ── Send / Edit / Delete / Reactions ─────────────────────────────────────
  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!content.trim() && !fileData) return;
    
    setSending(true);
    setError(null);
    
    // Create optimistic message
    const optimisticMessage: ChatMessage = {
      id: `temp-${Date.now()}`,
      channelId: channel.id,
      senderId: '',
      sender: { id: '', username: 'You' },
      content: content,
      fileUrl: fileData?.url,
      fileName: fileData?.name,
      fileType: fileData?.type,
      parentId: replyTo?.id,
      createdAt: new Date().toISOString(),
      reactions: [],
    };
    
    // Add optimistic message to UI
    setMessages(prev => [...prev, optimisticMessage]);
    
    // Send via socket
    socket.emit('message:send', {
      channelId: channel.id, content,
      fileUrl: fileData?.url, fileName: fileData?.name, fileType: fileData?.type,
      parentId: replyTo?.id,
    });
    
    setContent(''); 
    setReplyTo(null); 
    setFileData(null);
    setShowEmojiPicker(false); 
    setShowMentionBox(false);
    setSending(false);
  };

  const handleEdit = () => {
    if (!editingId) return;
    socket.emit('message:edit', { id: editingId, content: editContent });
    setMessages(prev => prev.map(m => m.id === editingId ? { ...m, content: editContent } : m));
    setEditingId(null); setEditContent('');
  };

  const handleDelete = (id: string) => socket.emit('message:delete', { id });

  const addReaction = (messageId: string, emoji: string) => {
    setMessages(prev => prev.map(msg => {
      if (msg.id !== messageId) return msg;
      const reactions = [...(msg.reactions ?? [])];
      const existing = reactions.find(r => r.emoji === emoji);
      if (existing) { existing.count += 1; } else { reactions.push({ emoji, count: 1 }); }
      return { ...msg, reactions };
    }));
  };

  // ── File upload ───────────────────────────────────────────────────────────
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Check file size (10MB limit)
    if (file.size > 10 * 1024 * 1024) {
      setError('File size must be less than 10MB');
      setTimeout(() => setError(null), 5000);
      return;
    }
    
    const formData = new FormData();
    formData.append('file', file);
    try {
      setUploading(true);
      const res = await axios.post<FileData>('/api/upload', formData, {
        onUploadProgress: (pe) => setUploadProgress(Math.round((pe.loaded * 100) / (pe.total ?? 1))),
      });
      setFileData(res.data);
      setError(null);
    } catch (err: any) { 
      console.error('Upload error:', err);
      const errorMessage = err.response?.data?.error || 'File upload failed. Please try again.';
      setError(errorMessage);
      setTimeout(() => setError(null), 5000);
    }
    finally { setUploading(false); setUploadProgress(0); }
  };

  const handleMention = (username: string) => {
    setContent(prev => prev + `@${username} `);
    setShowMentionBox(false);
  };

  if (!channel) return null;

  // Toolbar button groups with metadata
  const textFormattingGroup = [
    { icon: <Bold size={18} />, action: () => applyFormat('**'), label: 'Bold', tooltip: 'Bold (Cmd+B)' },
    { icon: <Italic size={18} />, action: () => applyFormat('*'), label: 'Italic', tooltip: 'Italic (Cmd+I)' },
    { icon: <Underline size={18} />, action: () => applyFormat('<u>', '</u>'), label: 'Underline', tooltip: 'Underline (Cmd+U)' },
    { icon: <Strikethrough size={18} />, action: () => applyFormat('~~'), label: 'Strikethrough', tooltip: 'Strikethrough' },
  ];

  const listGroup = [
    { icon: <List size={18} />, action: () => applyFormat('\n• '), label: 'Bullet List', tooltip: 'Bullet List' },
    { icon: <ListOrdered size={18} />, action: () => applyFormat('\n1. '), label: 'Numbered List', tooltip: 'Numbered List' },
  ];

  const blockGroup = [
    { icon: <Code2 size={18} />, action: () => applyFormat('`'), label: 'Code', tooltip: 'Inline Code' },
    { icon: <Quote size={18} />, action: () => applyFormat('\n> '), label: 'Quote', tooltip: 'Block Quote' },
  ];

  return (
    <div className="flex flex-col h-full bg-white relative">

      {/* ── Full-screen call overlay ── */}
      {isCalling && callType && (
        <CallOverlay
          callType={callType}
          isMuted={isMuted}
          isVideoOff={isVideoOff}
          isSharingScreen={isSharingScreen}
          callerName={incomingCall?.callerName}
          localVideoRef={localVideoRef}
          remoteVideoRef={remoteVideoRef}
          onToggleMute={toggleMute}
          onToggleVideo={toggleVideo}
          onScreenShare={toggleScreenShare}
          onEndCall={endCall}
        />
      )}

      {/* ── Incoming call notification ── */}
      {incomingCall && !isCalling && (
        <IncomingCallBanner
          callerName={incomingCall.callerName}
          callType={incomingCall.type}
          onAccept={answerCall}
          onDecline={declineCall}
        />
      )}

      {/* ── Chat header ── */}
      <div className="border-b bg-white px-5 py-4 flex items-center justify-between shrink-0">
        <div>
          <h2 className="font-bold text-xl text-gray-800">#{channel.name}</h2>
          <p className="text-sm text-gray-400">{onlineUsers.length} Members Online</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => startCall('audio')}
            className="w-11 h-11 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center transition"
            aria-label="Start audio call"
          >
            <Phone size={20} className="text-gray-700" />
          </button>
          <button
            onClick={() => startCall('video')}
            className="w-11 h-11 rounded-full bg-blue-600 hover:bg-blue-700 flex items-center justify-center transition"
            aria-label="Start video call"
          >
            <Video size={20} className="text-white" />
          </button>
        </div>
      </div>

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-white">
        {messages.map((m) => (
          <div key={m.id} className="group flex gap-3 hover:bg-gray-50 rounded-2xl p-4 transition">
            <div className="w-11 h-11 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold uppercase shadow-sm shrink-0" aria-hidden="true">
              {m.sender?.username?.[0]}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-gray-800">{m.sender?.username}</span>
                <span className="text-xs text-gray-400">{format(new Date(m.createdAt), 'h:mm a')}</span>
              </div>
              {m.parentId && <div className="text-xs text-blue-500 mt-1">↩ Reply</div>}
              {editingId === m.id ? (
                <div className="mt-3">
                  <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    className="w-full border border-gray-200 rounded-2xl p-4 outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <div className="flex gap-2 mt-3">
                    <button onClick={handleEdit} className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm">Save</button>
                    <button onClick={() => setEditingId(null)} className="px-4 py-2 bg-gray-100 rounded-xl text-sm">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 text-[15px] text-gray-700 leading-7" dangerouslySetInnerHTML={renderFormattedText(m.content ?? '')} />
              )}
              {m.fileUrl && (
                <div className="mt-4 border border-gray-200 rounded-2xl p-4 flex items-center justify-between bg-gray-50">
                  <div>
                    <div className="font-semibold text-gray-700 text-sm">{m.fileName}</div>
                    <div className="text-xs text-gray-400 mt-1">{m.fileType}</div>
                  </div>
                  <a href={m.fileUrl} target="_blank" rel="noreferrer noopener" className="p-3 hover:bg-white rounded-full transition" aria-label="Download file">
                    <Download size={18} />
                  </a>
                </div>
              )}
              <div className="flex gap-2 mt-3 flex-wrap">
                {m.reactions?.map((reaction, index) => (
                  <button key={index} onClick={() => addReaction(m.id, reaction.emoji)}
                    className="px-3 py-1 rounded-full text-sm bg-gray-100 hover:bg-gray-200 border border-gray-200"
                    aria-label={`React with ${reaction.emoji}`}>
                    {reaction.emoji} {reaction.count}
                  </button>
                ))}
              </div>
            </div>
            <div className="hidden group-hover:flex items-center gap-1 bg-white border border-gray-200 rounded-xl shadow-sm p-1 h-fit shrink-0">
              <button onClick={() => setReplyTo(m)} className="p-2 hover:bg-gray-100 rounded-lg" aria-label="Reply"><Reply size={16} /></button>
              <button onClick={() => { setEditingId(m.id); setEditContent(m.content ?? ''); }} className="p-2 hover:bg-gray-100 rounded-lg" aria-label="Edit"><Pencil size={16} /></button>
              <button onClick={() => handleDelete(m.id)} className="p-2 hover:bg-red-100 text-red-500 rounded-lg" aria-label="Delete"><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* ── Input area ── */}
      <div className="border-t border-gray-200 bg-white p-4 relative shrink-0">
        {error && (
          <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-2xl text-red-700 text-sm flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss error" className="text-red-500 hover:text-red-700">
              <X size={18} />
            </button>
          </div>
        )}
        {replyTo && (
          <div className="mb-3 bg-gray-50 border border-gray-200 rounded-2xl p-3 flex items-center justify-between">
            <span className="text-sm text-gray-700">Replying to <b>{replyTo.sender?.username}</b></span>
            <button onClick={() => setReplyTo(null)} aria-label="Cancel reply"><X size={18} /></button>
          </div>
        )}
        <div className="flex items-center gap-0.5 border border-gray-200 rounded-t-2xl px-2 py-2 bg-gradient-to-b from-gray-50 to-white flex-wrap">
          {/* Text Formatting Group */}
          <div className="flex items-center gap-0.5">
            {textFormattingGroup.map((item, index) => (
              <ToolbarButton
                key={index}
                icon={item.icon}
                tooltip={item.tooltip}
                onClick={item.action}
                ariaLabel={item.label}
              />
            ))}
          </div>

          <ToolbarSeparator />

          {/* List Group */}
          <div className="flex items-center gap-0.5">
            {listGroup.map((item, index) => (
              <ToolbarButton
                key={index}
                icon={item.icon}
                tooltip={item.tooltip}
                onClick={item.action}
                ariaLabel={item.label}
              />
            ))}
          </div>

          <ToolbarSeparator />

          {/* Block Group */}
          <div className="flex items-center gap-0.5">
            {blockGroup.map((item, index) => (
              <ToolbarButton
                key={index}
                icon={item.icon}
                tooltip={item.tooltip}
                onClick={item.action}
                ariaLabel={item.label}
              />
            ))}
          </div>
        </div>
        <textarea
          ref={textareaRef} rows={4} value={content}
          onChange={e => {
            setContent(e.target.value);
            setShowMentionBox(!!e.target.value.split(' ').pop()?.startsWith('@'));
          }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          className="w-full border-x border-b border-gray-200 rounded-b-2xl p-3 resize-none outline-none text-gray-700"
          placeholder={`Message #${channel.name}`}
          aria-label={`Message #${channel.name}`}
        />
        {showMentionBox && (
          <div className="absolute bottom-32 left-5 bg-white border border-gray-200 shadow-xl rounded-2xl w-60 p-2 z-50 max-h-60 overflow-y-auto">
            {onlineUsers.map(u => (
              <button key={u.id} onClick={() => handleMention(u.username)} className="w-full text-left px-3 py-3 hover:bg-gray-100 rounded-xl text-sm">
                @{u.username}
              </button>
            ))}
          </div>
        )}
        {showEmojiPicker && (
          <div className="absolute bottom-28 left-5 z-50">
            <EmojiPicker height={400} width={320} previewConfig={{ showPreview: false }}
              onEmojiClick={emojiData => setContent(prev => prev + emojiData.emoji)} />
          </div>
        )}
        {fileData && (
          <div className="mt-3 border border-gray-200 rounded-2xl p-4 flex items-center justify-between bg-gray-50">
            <div>
              <div className="font-semibold text-gray-700 text-sm">{fileData.name}</div>
              <div className="text-xs text-gray-400">{fileData.type}</div>
            </div>
            <button onClick={() => setFileData(null)} aria-label="Remove file"><X size={18} /></button>
          </div>
        )}
        {uploading && (
          <div className="mt-3">
            <div className="flex justify-between text-sm text-gray-600 mb-1">
              <span>Uploading...</span><span>{uploadProgress}%</span>
            </div>
            <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
              <div style={{ width: `${uploadProgress}%` }} className="h-full bg-blue-600 transition-all" />
            </div>
          </div>
        )}
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2">
            <input type="file" hidden ref={fileInputRef} onChange={handleFileSelect} accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.txt,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.json,.csv,.svg" />
            <button onClick={() => fileInputRef.current?.click()} className="p-3 hover:bg-gray-100 rounded-full transition" aria-label="Attach file"><Plus size={20} /></button>
            <button onClick={() => setShowEmojiPicker(!showEmojiPicker)} className="p-3 hover:bg-gray-100 rounded-full transition" aria-label="Emoji picker"><Smile size={20} /></button>
            <button onClick={() => setShowMentionBox(!showMentionBox)} className="p-3 hover:bg-gray-100 rounded-full transition" aria-label="Mention someone"><AtSign size={20} /></button>
          </div>
          <button onClick={handleSend} disabled={(!content.trim() && !fileData) || sending || uploading}
            className={`px-5 py-3 rounded-2xl flex items-center gap-2 font-medium transition ${(content.trim() || fileData) && !sending && !uploading ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-gray-100 text-gray-400'}`}>
            <Send size={18} />{sending ? 'Sending...' : 'Send'}
          </button>
        </div>
        <p className="text-center text-xs text-gray-400 mt-1">Press Enter to send · Shift + Enter for new line</p>
      </div>
    </div>
  );
};
