import axios from 'axios';
import { format } from 'date-fns';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import {
  BarChart2, // 👇 NAYA: Polls ke liye icon
  Download,
  FileText,
  MessageSquare,
  Mic,
  Pencil,
  Phone,
  Pin,
  Plus,
  Reply, Send, Smile,
  SmilePlus,
  Square,
  Trash2,
  UserPlus,
  Video, X
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Socket } from 'socket.io-client';
import { useAuth } from '../../contexts/AuthContext';
import { sanitizeMessageHtml } from '../../lib/sanitizeHtml';
import { Channel, Message, User } from '../../types';
import { AddMemberModal } from './AddMemberModal';
import { LinkPreview } from './LinkPreview';
import { RichTextEditor, RichTextEditorHandle } from './RichTextEditor';
import { ThreadPanel } from './ThreadPanel';

// Virtuoso identifies "where" the currently-loaded window sits in the full
// (unloaded) history via a numeric index, not by cursor string — this is the
// starting value for the most-recent page, decremented every time an older
// page is prepended. Large enough that repeatedly paging backward through
// thousands of messages never goes negative.
const FIRST_ITEM_INDEX_START = 1_000_000;

interface Reaction { emoji: string; count: number; users: { id: string; username: string }[]; }
// 👇 NAYA: Poll Interfaces 👇
interface PollOption { id: string; text: string; votes: string[]; }
interface PollData { question: string; options: PollOption[]; }
interface ChatMessage extends Message { reactions: Reaction[]; isPinned?: boolean; pollData?: PollData; _count?: { replies: number }; }

interface FileData { url: string; name: string; type: string; }

interface MessagePageResponse { messages: ChatMessage[]; nextCursor: string | null; hasMore: boolean; }

interface ChatAreaProps {
  channel: Channel;
  socket: Socket;
  onlineUsers?: User[];
  onStartCall: (type: 'audio' | 'video') => void;
}

export const ChatArea = ({ channel, socket, onlineUsers = [], onStartCall }: ChatAreaProps) => {
  const { user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Plain-text mirrors of each editor's live HTML — used only for UI logic
  // that can't operate on markup (slash-command hint, empty-state checks,
  // poll-syntax parsing at send time). The HTML itself is read on demand
  // from the editor refs below, not tracked in state.
  const [content, setContent] = useState('');

  const [activeThread, setActiveThread] = useState<ChatMessage | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [reactingToId, setReactingToId] = useState<string | null>(null);
  
  const [fileData, setFileData] = useState<FileData | null>(null);
  // Captured client-side from the raw File at selection time — the backend's
  // upload response doesn't include size, and there's no need to add it
  // there just to render a preview badge.
  const [fileSize, setFileSize] = useState<number | null>(null);
  // Discriminated rather than a bare boolean — the two upload paths
  // (file-picker attachment vs. recorded voice note) share this same loading
  // UI, and previously shared a single `uploading` boolean too, which is
  // exactly why a regular file upload showed a hardcoded "Uploading
  // audio..." label: there was no way for the UI to tell which kind of
  // upload was actually in flight.
  const [uploadingType, setUploadingType] = useState<'audio' | 'file' | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddMemberModal, setShowAddMemberModal] = useState(false);

  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mainEditorRef = useRef<RichTextEditorHandle>(null);
  const editEditorRef = useRef<RichTextEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Cursor pagination / infinite scroll state — see the fetch effect and
  // loadMoreMessages below. nextCursor lives in a ref (not state) since it's
  // only ever read inside loadMoreMessages, never rendered.
  const [firstItemIndex, setFirstItemIndex] = useState(FIRST_ITEM_INDEX_START);
  const [hasMoreHistory, setHasMoreHistory] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const nextCursorRef = useRef<string | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    setTypingUsers([]);
    setActiveThread(null);
    setReactingToId(null);
  }, [channel?.id]);

  useEffect(() => {
    if (!channel) return;

    // Reset pagination state for the new channel — each channel has its own
    // independent history/cursor.
    setFirstItemIndex(FIRST_ITEM_INDEX_START);
    setHasMoreHistory(true);
    nextCursorRef.current = null;

    const fetchMessages = async () => {
      try {
        const res = await axios.get<MessagePageResponse>(`/api/channels/${channel.id}/messages`);
        setMessages(res.data.messages.map(m => ({ ...m, reactions: m.reactions ?? [] })));
        nextCursorRef.current = res.data.nextCursor;
        setHasMoreHistory(res.data.hasMore);
        socket.emit('channel:join', channel.id);
      } catch (err) {
        console.error('fetchMessages error:', err);
        setError('Failed to load messages');
      }
    };
    fetchMessages();

    const handleMessage = (message: ChatMessage) => {
      // Replies aren't part of this list at all anymore — they only ever
      // land in whichever ThreadPanel has that thread open (via its own
      // thread:message_received listener). This channel-room broadcast still
      // fires for replies too (so WorkspaceLayout's unread-badge counting
      // keeps working unchanged), so it has to be filtered out here.
      if (message.parentId) return;
      setMessages(prev => {
        const filtered = prev.filter(m => !m.id.startsWith('temp-'));
        if (filtered.find(m => m.id === message.id)) return filtered;
        return [...filtered, { ...message, reactions: message.reactions ?? [] }];
      });
    };
    const handleUpdate = (updated: ChatMessage) => setMessages(prev => prev.map(m => m.id === updated.id ? updated : m));
    const handleDelete = (id: string) => setMessages(prev => prev.filter(m => m.id !== id));

    const handleReactionUpdate = ({ messageId, reactions }: { messageId: string; reactions: Reaction[] }) => {
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, reactions } : m));
    };

    // A reply was sent somewhere in this channel — bump the parent's visible
    // "N replies" count even if this viewer doesn't have that thread open
    // (if they do, ThreadPanel's own live reply list is the source of truth
    // for the count instead; this only affects the main list's badge).
    const handleReplyCountUpdated = ({ parentId, replyCount }: { parentId: string; replyCount: number }) => {
      setMessages(prev => prev.map(m => m.id === parentId ? { ...m, _count: { replies: replyCount } } : m));
    };

    const handleTypingStarted = ({ channelId, username }: { channelId: string; username: string }) => {
      if (channelId === channel.id) setTypingUsers(prev => prev.includes(username) ? prev : [...prev, username]);
    };
    const handleTypingStopped = ({ channelId, username }: { channelId: string; username: string }) => {
      if (channelId === channel.id) setTypingUsers(prev => prev.filter(u => u !== username));
    };

    socket.on('message:received', handleMessage);
    socket.on('message:updated', handleUpdate);
    socket.on('message:deleted', handleDelete);
    socket.on('message:reaction:updated', handleReactionUpdate);
    socket.on('thread:reply_count_updated', handleReplyCountUpdated);
    socket.on('typing:started', handleTypingStarted);
    socket.on('typing:stopped', handleTypingStopped);

    return () => {
      socket.off('message:received', handleMessage);
      socket.off('message:updated', handleUpdate);
      socket.off('message:deleted', handleDelete);
      socket.off('message:reaction:updated', handleReactionUpdate);
      socket.off('thread:reply_count_updated', handleReplyCountUpdated);
      socket.off('typing:started', handleTypingStarted);
      socket.off('typing:stopped', handleTypingStopped);
    };
  }, [channel, socket]);

  // The main list's auto-scroll-to-bottom is now handled by Virtuoso's
  // `followOutput` prop — it only applies when new content lands at the tail
  // (real new messages), and correctly does nothing when older history gets
  // prepended at the top (loadMoreMessages), which is exactly what a plain
  // scrollIntoView-on-every-messages-change would have gotten wrong. Thread
  // auto-scroll is handled inside ThreadPanel itself now.

  // Fetches the next (older) page when the user scrolls near the top of the
  // virtualized list. Every row this endpoint returns is now guaranteed
  // top-level (parentId: null — see messages.service.ts), so unlike before
  // there's no such thing as an all-reply page to skip past; one fetch always
  // grows the visible list (or exhausts history).
  const loadMoreMessages = useCallback(async () => {
    if (loadingMore || !hasMoreHistory || !nextCursorRef.current || !channel) return;
    setLoadingMore(true);
    try {
      const page: MessagePageResponse = (
        await axios.get(`/api/channels/${channel.id}/messages`, { params: { cursor: nextCursorRef.current } })
      ).data;
      const withReactions = page.messages.map(m => ({ ...m, reactions: m.reactions ?? [] }));

      if (withReactions.length > 0) {
        setFirstItemIndex(prev => prev - withReactions.length);
        setMessages(prev => [...withReactions, ...prev]);
      }
      nextCursorRef.current = page.nextCursor;
      setHasMoreHistory(page.hasMore);
    } catch (err) {
      console.error('loadMoreMessages error:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [channel, hasMoreHistory, loadingMore]);

  // Main composer only now — thread replies are sent by ThreadPanel itself
  // (it emits message:send directly with its own parentId), since it no
  // longer shares any state with this component.
  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    socket.emit('typing:stop', { channelId: channel.id });

    const html = mainEditorRef.current?.getHTML() ?? '';
    const text = mainEditorRef.current?.getText() ?? '';

    if (!text.trim() && !fileData) return;

    setSending(true);
    setError(null);

    // 👇 NAYA: Slash Command Detector for /poll 👇
    // Parsed from the editor's plain text, not its HTML — TipTap always
    // wraps content in a <p>, so the HTML never literally starts with "/poll".
    let finalContent: string = html;
    let pollData = undefined;

    if (text.trim().startsWith('/poll')) {
      const matches = text.match(/"([^"\\]*(?:\\.[^"\\]*)*)"/g);
      if (matches && matches.length >= 2) {
        const parsed = matches.map(m => m.slice(1, -1)); // Quotes hata do
        pollData = {
          question: parsed[0],
          options: parsed.slice(1).map((opt, i) => ({ id: `opt-${i}`, text: opt, votes: [] }))
        };
        finalContent = '📊 Poll Created'; // UI me text nahi dikhana, sirf card dikhana hai
      } else {
        setError('Invalid poll format! Correct use: /poll "Question" "Option 1" "Option 2"');
        setSending(false);
        return;
      }
    }
    // 👆 END SLASH COMMAND DETECTOR 👆

    socket.emit('message:send', {
      channelId: channel.id,
      content: finalContent,
      fileUrl: fileData?.url,
      fileName: fileData?.name,
      fileType: fileData?.type,
      pollData, // Payload mein poll pass kar diya
      parentId: null,
    });

    mainEditorRef.current?.clear();
    setContent('');
    setFileData(null);
    setFileSize(null);
    // Without this, selecting the exact same file again right after sending
    // silently does nothing — the input's value never changed, so the
    // browser never fires onChange a second time.
    if (fileInputRef.current) fileInputRef.current.value = '';
    setShowEmojiPicker(false);
    setSending(false);
  };

  const handleVote = (messageId: string, optionId: string) => {
    socket.emit('poll:vote', { messageId, optionId });
  };

  // Strictly the voice-note upload path — the file-picker attachment path
  // below (handleFileUpload) is a separate function entirely; the two were
  // never actually cross-wired, but they used to share one `uploading`
  // boolean, which is what made a regular file upload show "Uploading
  // audio..." regardless of which one was actually running.
  const sendVoiceNote = async (audioBlob: Blob) => {
    const formData = new FormData();
    // Field name 'attachment' must match upload.middleware.ts's
    // upload.single('attachment') exactly — a mismatch here silently fails
    // with "Unexpected field" instead of a helpful error. Passing the
    // filename as the explicit 3rd argument (rather than wrapping in a File
    // first) means the recorded Blob always carries a real name + extension
    // to the server, even though MediaRecorder blobs themselves have none.
    formData.append('attachment', audioBlob, `voice-${Date.now()}.webm`);

    try {
      setUploadingType('audio');
      const res = await axios.post<FileData>('/api/upload', formData, {
        onUploadProgress: (pe) => setUploadProgress(Math.round((pe.loaded * 100) / (pe.total ?? 1))),
      });

      socket.emit('message:send', {
        channelId: channel.id,
        content: '🎙️ Voice Note',
        fileUrl: res.data.url,
        fileName: res.data.name || 'voice.webm',
        fileType: res.data.type || 'audio/webm',
        parentId: null,
      });
    } catch (err: any) {
      console.error('Audio Upload Error:', err);
      setError(err.response?.data?.message || 'Failed to send voice note.');
    } finally {
      setUploadingType(null);
      setUploadProgress(0);
    }
  };

  const startRecording = async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        streamRef.current?.getTracks().forEach(track => track.stop());

        if (audioBlob.size === 0) {
          setError('Voice recording failed. Please try again.');
          return;
        }

        sendVoiceNote(audioBlob);
      };

      mediaRecorder.start(200);
      setIsRecording(true);
    } catch (err) {
      console.error('Error accessing mic:', err);
      setError('Microphone access denied! Allow permissions in your browser.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const handleEdit = () => {
    if (!editingId) return;
    const html = editEditorRef.current?.getHTML() ?? '';
    socket.emit('message:edit', { id: editingId, content: html });
    setMessages(prev => prev.map(m => m.id === editingId ? { ...m, content: html } : m));
    setEditingId(null);
  };

  const handleDelete = (id: string) => {
    socket.emit('message:delete', { id });
    if (activeThread?.id === id) setActiveThread(null);
  };

  const handlePin = (id: string, currentStatus: boolean) => {
    socket.emit('message:pin', { id, isPinned: !currentStatus });
    setMessages(prev => prev.map(m => m.id === id ? { ...m, isPinned: !currentStatus } : m));
  };

  // Reactions are persisted server-side and broadcast back via
  // `message:reaction:updated` (see handleReactionUpdate above) — no local
  // state mutation here. The backend decides add-vs-remove itself (a single
  // idempotent toggle keyed on the current DB row), so the client doesn't
  // need to track "did I already react with this emoji" just to pick which
  // action to call.
  const handleReact = async (messageId: string, emoji: string) => {
    setReactingToId(null);
    try {
      await axios.post(`/api/messages/${messageId}/reactions`, { emoji });
    } catch (err) {
      console.error('Failed to toggle reaction:', err);
    }
  };

  // Strictly the file-picker attachment path — separate from sendVoiceNote
  // above. This one stages the upload result into `fileData` rather than
  // sending immediately: the user still has to hit Send, matching the
  // existing "attach, preview, then send" flow (handleSend reads fileData).
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      setError('File size must be under 25MB');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const formData = new FormData();
    // Exact field name expected by upload.middleware.ts's upload.single('attachment').
    formData.append('attachment', file);
    try {
      setUploadingType('file');
      const res = await axios.post<FileData>('/api/upload', formData, {
        onUploadProgress: (pe) => setUploadProgress(Math.round((pe.loaded * 100) / (pe.total ?? 1))),
      });
      setFileData(res.data);
      setFileSize(file.size);
    } catch (err: any) {
      console.error('File upload error:', err);
      setError(err.response?.data?.message || 'Upload failed. Please try again.');
      // Reset the input so the user can immediately retry selecting the same
      // file after a transient failure — browsers don't fire onChange again
      // if the input's value hasn't changed.
      if (fileInputRef.current) fileInputRef.current.value = '';
    } finally {
      setUploadingType(null);
      setUploadProgress(0);
    }
  };

  // Clears the staged attachment — used by both the preview badge's remove
  // button and after a successful send. Resetting the input's own value is
  // what makes re-selecting the exact same file work: without it, the
  // browser won't fire onChange a second time for an unchanged file path.
  const handleRemoveFile = () => {
    setFileData(null);
    setFileSize(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (!channel) return null;

  // Guaranteed top-level already (see getChannelMessages' parentId:null
  // filter + handleMessage's own filter above), kept as a plain alias rather
  // than re-filtering for it.
  const mainMessages = messages;
  const pinnedMessages = mainMessages.filter(m => m.isPinned);

  const renderMessageUI = (m: ChatMessage, isThreadView = false) => {
    const replyCount = m._count?.replies ?? 0;
    const isAudioMsg = m.content === '🎙️ Voice Note' || (m.fileUrl && (m.fileType?.includes('audio') || m.fileType?.includes('webm')));
    const isPoll = Boolean(m.pollData); // Check if this is a poll message

    return (
      <div key={m.id} className={`group flex gap-4 hover:bg-gray-50/70 rounded-2xl p-5 transition-all relative ${m.isPinned ? 'bg-amber-50/30 border border-amber-100/50' : ''} animate-fade-in`}>
        
        {m.isPinned && !isThreadView && (
          <div className="absolute -top-2 left-10 bg-gradient-to-r from-amber-100 to-yellow-100 text-amber-700 text-[10px] px-2.5 py-1 rounded-full font-bold flex items-center gap-1.5 border border-amber-200 shadow-sm z-10">
            <Pin size={10} /> Pinned
          </div>
        )}

        <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 text-white flex items-center justify-center font-bold uppercase shadow-md shrink-0 text-base">
          {m.sender?.username?.[0]}
        </div>
        <div className="flex-1 min-w-0 relative">
          <div className="flex items-center gap-3 mb-1">
            <span className="font-bold text-gray-900 text-base">{m.sender?.username}</span>
            <span className="text-xs text-gray-500 font-medium bg-gray-100 px-2 py-0.5 rounded-md">{format(new Date(m.createdAt), 'h:mm a')}</span>
          </div>
          
          {editingId === m.id ? (
            <div className="mt-4">
              <div className="w-full border-2 border-violet-300 rounded-xl p-4 focus-within:ring-4 focus-within:ring-violet-50">
                <RichTextEditor
                  ref={editEditorRef}
                  initialContent={m.content ?? ''}
                  autoFocus
                  compact
                  onSubmit={handleEdit}
                />
              </div>
              <div className="flex gap-2 mt-3">
                <button 
                  onClick={handleEdit} 
                  className="px-5 py-2 bg-gradient-to-r from-violet-600 to-violet-700 text-white rounded-xl text-sm font-semibold shadow-md shadow-violet-600/30 hover:from-violet-700 hover:to-violet-800 transition-all hover:scale-105 active:scale-95"
                >
                  Save Changes
                </button>
                <button 
                  onClick={() => setEditingId(null)} 
                  className="px-5 py-2 bg-gray-100 hover:bg-gray-200 rounded-xl text-sm font-semibold transition-all"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* 👇 NAYA: Poll Card UI Render Logic 👇 */}
              {isPoll ? (
                <div className="mt-3 bg-white border border-border-subtle rounded-xl p-5 shadow-sm max-w-lg">
                  <div className="font-bold text-lg text-gray-900 mb-4 flex items-center gap-2">
                    <div className="bg-violet-100 text-violet-600 p-1.5 rounded-lg"><BarChart2 size={20} /></div>
                    {m.pollData?.question}
                  </div>
                  <div className="flex flex-col gap-3">
                    {m.pollData?.options.map(opt => {
                      const totalVotes = m.pollData!.options.reduce((acc, o) => acc + o.votes.length, 0);
                      const percent = totalVotes === 0 ? 0 : Math.round((opt.votes.length / totalVotes) * 100);
                      
                      return (
                        <div key={opt.id} onClick={() => handleVote(m.id, opt.id)} className="relative h-11 w-full bg-gray-100 rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-violet-300 transition-all group/poll">
                          {/* Progress Bar Background */}
                          <div 
                            className="absolute top-0 left-0 h-full bg-violet-100 transition-all duration-500 ease-out" 
                            style={{ width: `${percent}%` }}
                          ></div>
                          {/* Text and Count */}
                          <div className="absolute inset-0 flex items-center justify-between px-4 z-10">
                            <span className="font-semibold text-gray-800 group-hover/poll:text-violet-700 transition-colors text-sm">{opt.text}</span>
                            <span className="text-sm font-bold text-gray-600">{percent}% ({opt.votes.length})</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-3 text-xs text-gray-500 font-medium">
                    {m.pollData!.options.reduce((acc, o) => acc + o.votes.length, 0)} Total Votes
                  </div>
                </div>
              ) : (
                !isAudioMsg && (
                  <div className="mt-2 text-[15px] text-gray-800 leading-relaxed" dangerouslySetInnerHTML={{ __html: sanitizeMessageHtml(m.content ?? '') }} />
                )
              )}
            </>
          )}

          {m.content && !isPoll && (m.content.match(/(https?:\/\/[^\s]+)/g) || []).map((url, idx) => (
            <LinkPreview key={idx} url={url} />
          ))}

          {isAudioMsg ? (
            <div className="mt-3 bg-violet-50 p-4 rounded-lg w-fit min-w-[300px] shadow-sm border border-violet-100">
              <div className="text-sm font-bold text-violet-700 mb-3 flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-violet-100 flex items-center justify-center">
                  <Mic size={16} />
                </div>
                Voice Message
              </div>
              {m.fileUrl ? (
                <div className="flex flex-col gap-2">
                  <audio 
                    controls 
                    src={m.fileUrl} 
                    style={{ width: '270px', height: '42px', display: 'block' }}
                    className="rounded-lg"
                  />
                  <a 
                    href={m.fileUrl} 
                    target="_blank" 
                    rel="noreferrer" 
                    className="text-[11px] text-violet-600 hover:text-violet-700 underline font-medium"
                  >
                    Open in new tab
                  </a>
                </div>
              ) : (
                <span className="text-xs text-red-500 font-semibold">Audio missing.</span>
              )}
            </div>
          ) : m.fileUrl ? (
            <div className="mt-4 border border-border-subtle rounded-lg p-5 flex items-center justify-between bg-surface-secondary hover:border-violet-300 transition-all shadow-sm hover:shadow-md group/file">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-violet-100 flex items-center justify-center shrink-0 group-hover/file:bg-violet-200 transition-colors">
                  <Download size={20} className="text-violet-600" />
                </div>
                <div>
                  <div className="font-bold text-gray-900 text-sm">{m.fileName}</div>
                  <div className="text-xs text-gray-500 mt-1 font-medium">{m.fileType}</div>
                </div>
              </div>
              <a 
                href={m.fileUrl} 
                target="_blank" 
                rel="noreferrer noopener" 
                className="p-3 hover:bg-violet-50 rounded-xl transition-all text-violet-600 hover:scale-110 active:scale-95"
              >
                <Download size={20} />
              </a>
            </div>
          ) : null}
          
          <div className="flex gap-2 mt-4 flex-wrap items-center">
            {m.reactions?.map((reaction) => {
              const reactedByMe = reaction.users.some(u => u.id === user?.id);
              return (
                <button
                  key={reaction.emoji}
                  onClick={() => handleReact(m.id, reaction.emoji)}
                  title={reaction.users.map(u => u.username).join(', ')}
                  className={`px-3 py-1.5 rounded-xl text-sm border-2 transition-all shadow-sm hover:shadow-md hover:scale-105 active:scale-95 font-medium ${
                    reactedByMe
                      ? 'bg-violet-50 border-violet-300 hover:border-violet-400'
                      : 'bg-white hover:bg-gray-50 border-border-subtle hover:border-violet-300'
                  }`}
                >
                  <span className="text-base">{reaction.emoji}</span>
                  <span className={`ml-1.5 font-bold ${reactedByMe ? 'text-violet-700' : 'text-gray-700'}`}>{reaction.count}</span>
                </button>
              );
            })}
            
            {!isThreadView && replyCount > 0 && (
              <button 
                onClick={() => setActiveThread(m)} 
                className="flex items-center gap-2 text-sm font-bold text-violet-600 hover:text-violet-700 hover:bg-violet-50 px-4 py-1.5 rounded-xl transition-all shadow-sm hover:shadow-md border border-violet-200 hover:border-violet-300"
              >
                <MessageSquare size={15} /> 
                {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
              </button>
            )}
          </div>

          {reactingToId === m.id && (
            <div className="absolute top-12 left-0 z-50 shadow-2xl rounded-xl border border-border-subtle overflow-hidden bg-white animate-scale-in">
              <EmojiPicker 
                onEmojiClick={(emojiData) => handleReact(m.id, emojiData.emoji)} 
                theme={Theme.LIGHT} 
                lazyLoadEmojis={true}
              />
            </div>
          )}
        </div>

        <div className="absolute right-4 top-4 hidden group-hover:flex items-center gap-0.5 bg-white border border-border-subtle rounded-lg shadow-lg p-1 z-10 animate-scale-in">
          <button 
            onClick={() => setReactingToId(reactingToId === m.id ? null : m.id)} 
            className="p-2.5 hover:bg-violet-50 rounded-lg text-gray-600 hover:text-violet-600 transition-all" 
            title="Add Reaction"
          >
            <SmilePlus size={18} />
          </button>
          
          {!isThreadView && (
            <button 
              onClick={() => handlePin(m.id, !!m.isPinned)} 
              className={`p-2.5 hover:bg-amber-50 rounded-lg transition-all ${m.isPinned ? 'text-amber-600 bg-amber-50' : 'text-gray-600 hover:text-amber-600'}`} 
              title={m.isPinned ? "Unpin message" : "Pin message"}
            >
              <Pin size={18} />
            </button>
          )}

          {!isThreadView && (
            <button 
              onClick={() => setActiveThread(m)} 
              className="p-2.5 hover:bg-purple-50 rounded-lg text-gray-600 hover:text-purple-600 transition-all" 
              title="Reply in thread"
            >
              <Reply size={18} />
            </button>
          )}
          {/* Cannot edit Polls */}
          {!isPoll && (
            <button 
              onClick={() => setEditingId(m.id)}
              className="p-2.5 hover:bg-green-50 rounded-lg text-gray-600 hover:text-green-600 transition-all"
              title="Edit message"
            >
              <Pencil size={18} />
            </button>
          )}
          <button 
            onClick={() => handleDelete(m.id)} 
            className="p-2.5 hover:bg-red-50 text-gray-600 hover:text-red-600 rounded-lg transition-all"
            title="Delete message"
          >
            <Trash2 size={18} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full bg-gradient-to-br from-white to-gray-50 relative w-full overflow-hidden" onClick={() => setReactingToId(null)}>
      <div className={`flex flex-col h-full min-w-0 flex-1 transition-all duration-300 ${activeThread ? 'border-r border-border-subtle' : ''}`}>
        
        <div className="border-b bg-white px-6 py-4 flex items-center justify-between shrink-0 h-[80px] shadow-sm">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-white font-bold text-lg shadow-md">
              #
            </div>
            <div>
              <h2 className="font-bold text-xl text-gray-900 flex items-center gap-2">
                {channel.name}
                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse shadow-sm shadow-green-500/50"></span>
              </h2>
              <p className="text-sm text-gray-500 font-medium">{onlineUsers.length} Members Online</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!channel.isDM && (
              <button
                onClick={() => setShowAddMemberModal(true)}
                className="h-11 px-3.5 rounded-xl bg-gray-100 hover:bg-gray-200 flex items-center gap-2 transition-all hover:scale-105 active:scale-95 shadow-sm group"
                title="Add people"
              >
                <UserPlus size={18} className="text-gray-700 group-hover:text-gray-900" />
                <span className="text-sm font-semibold text-gray-700 group-hover:text-gray-900">Add People</span>
              </button>
            )}
            <button
              onClick={() => onStartCall('audio')}
              className="w-11 h-11 rounded-xl bg-gray-100 hover:bg-gray-200 flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-sm group"
              title="Start audio call"
            >
              <Phone size={20} className="text-gray-700 group-hover:text-gray-900" />
            </button>
            <button 
              onClick={() => onStartCall('video')} 
              className="w-11 h-11 rounded-xl bg-gradient-to-br from-violet-600 to-violet-700 hover:from-violet-700 hover:to-violet-800 flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-md shadow-violet-600/30 group"
              title="Start video call"
            >
              <Video size={20} className="text-white" />
            </button>
          </div>
        </div>

        <AddMemberModal
          isOpen={showAddMemberModal}
          onClose={() => setShowAddMemberModal(false)}
          channelId={channel.id}
          channelName={channel.name}
        />

        {pinnedMessages.length > 0 && (
          <div className="bg-gradient-to-r from-amber-50 via-yellow-50 to-amber-50 border-b border-amber-200/50 px-6 py-3 shrink-0 flex items-center gap-3 overflow-x-auto shadow-sm z-10">
            <div className="flex items-center gap-2 text-amber-700 font-bold text-xs uppercase tracking-wider shrink-0">
              <div className="w-6 h-6 rounded-lg bg-amber-100 flex items-center justify-center">
                <Pin size={13} />
              </div>
              <span>{pinnedMessages.length} Pinned</span>
            </div>
            <div className="w-px h-5 bg-amber-300 shrink-0"></div>
            <div className="flex gap-2.5 overflow-x-auto no-scrollbar">
              {pinnedMessages.map(m => (
                <div key={m.id} className="text-xs text-amber-900 bg-white px-4 py-2 rounded-xl border border-amber-200 truncate max-w-[280px] shadow-sm flex items-center gap-2.5 hover:shadow-md transition-all cursor-pointer">
                  <span className="font-bold text-amber-800">{m.sender?.username}:</span>
                  <span className="truncate font-medium">{m.content?.substring(0, 35) || 'Attachment...'}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="mx-6 mt-4 p-4 bg-gradient-to-r from-red-50 to-pink-50 text-red-700 rounded-xl border border-red-200 text-sm flex justify-between items-center shadow-sm animate-fade-in shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center shrink-0">
                <X size={16} className="text-red-600" />
              </div>
              <span className="font-medium">{error}</span>
            </div>
            <button onClick={() => setError(null)} className="p-1.5 hover:bg-red-100 rounded-lg transition-colors">
              <X size={18} />
            </button>
          </div>
        )}

        <div className="flex-1 min-h-0 bg-white p-6" onClick={(e) => e.stopPropagation()}>
          {mainMessages.length === 0 ? (
            <div className="h-full flex items-center justify-center text-gray-400 font-medium">
              No messages yet — say hello!
            </div>
          ) : (
            <Virtuoso
              style={{ height: '100%' }}
              className="slack-scrollbar"
              data={mainMessages}
              firstItemIndex={firstItemIndex}
              initialTopMostItemIndex={mainMessages.length - 1}
              startReached={loadMoreMessages}
              followOutput="smooth"
              computeItemKey={(_index, m) => m.id}
              itemContent={(_index, m) => renderMessageUI(m, false)}
              components={{
                Header: () =>
                  loadingMore ? (
                    <div className="flex items-center justify-center gap-2 py-4 text-gray-400 text-sm">
                      <div className="w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
                      Loading earlier messages…
                    </div>
                  ) : null,
              }}
            />
          )}
        </div>

        {(typingUsers.length > 0 || uploadingType) && (
          <div className="shrink-0 px-6 py-2 bg-white border-t border-border-subtle">
            {typingUsers.length > 0 && (
              <div className="flex items-center gap-3 text-sm text-gray-500 py-1 animate-fade-in">
                <div className="flex gap-1">
                  <div className="w-2 h-2 bg-violet-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                  <div className="w-2 h-2 bg-violet-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                  <div className="w-2 h-2 bg-violet-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                </div>
                <span className="font-medium">
                  {typingUsers.join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing...
                </span>
              </div>
            )}
            {uploadingType && (
              <div className="flex items-center gap-3 text-sm bg-violet-50 text-violet-600 py-3 px-4 rounded-xl border border-violet-200 animate-fade-in shadow-sm my-1">
                <div className="w-8 h-8 rounded-lg bg-violet-100 flex items-center justify-center shrink-0">
                  <div className="w-4 h-4 border-2 border-violet-600 border-t-transparent rounded-full animate-spin"></div>
                </div>
                <div className="flex-1">
                  <div className="font-semibold mb-1">{uploadingType === 'audio' ? 'Uploading audio...' : 'Uploading file...'}</div>
                  <div className="w-full bg-violet-200 rounded-full h-1.5 overflow-hidden">
                    <div className="bg-violet-600 h-full transition-all duration-300 rounded-full" style={{ width: `${uploadProgress}%` }}></div>
                  </div>
                </div>
                <span className="font-bold text-sm">{uploadProgress}%</span>
              </div>
            )}
          </div>
        )}

        <div className="border-t border-border-subtle bg-gradient-to-b from-white to-gray-50 p-5 shrink-0 relative" onClick={(e) => e.stopPropagation()}>
          
          {showEmojiPicker && (
            <div className="absolute bottom-full left-4 mb-3 z-50 shadow-2xl rounded-xl border border-border-subtle overflow-hidden bg-white animate-scale-in">
              <EmojiPicker
                onEmojiClick={(emojiData) => {
                  mainEditorRef.current?.insertText(emojiData.emoji);
                  setShowEmojiPicker(false);
                }}
                theme={Theme.LIGHT}
                lazyLoadEmojis={true}
              />
            </div>
          )}

          {/* 👇 NAYA: Command Hint Box 👇 */}
          {content.startsWith('/') && !content.startsWith('/poll') && (
            <div className="absolute bottom-full left-4 mb-2 bg-white border border-border-subtle shadow-xl rounded-xl p-3 z-50 min-w-[250px] animate-fade-in">
              <div className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Slash Commands</div>
              <div
                className="flex items-center gap-3 p-2 hover:bg-violet-50 rounded-lg cursor-pointer transition-colors"
                onClick={() => {
                  mainEditorRef.current?.setContent('/poll "Your Question?" "Option 1" "Option 2"');
                  mainEditorRef.current?.focus();
                }}
              >
                <div className="bg-violet-100 text-violet-600 p-1.5 rounded-md"><BarChart2 size={16} /></div>
                <div>
                  <div className="font-bold text-sm text-gray-900">/poll</div>
                  <div className="text-xs text-gray-500">Create a live voting poll</div>
                </div>
              </div>
            </div>
          )}

          {/* File preview badge — shown once the attachment has finished
              uploading (fileData is populated by handleFileUpload). Lets the
              user see what they've attached and remove it before sending. */}
          {fileData && (
            <div className="flex items-center gap-3 mb-2 px-4 py-2.5 bg-violet-50 border border-violet-200 rounded-xl animate-fade-in">
              <div className="w-9 h-9 rounded-lg bg-violet-100 flex items-center justify-center text-violet-600 shrink-0">
                <FileText size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-gray-900 truncate">{fileData.name}</div>
                {fileSize !== null && (
                  <div className="text-xs text-gray-500">{formatFileSize(fileSize)}</div>
                )}
              </div>
              <button
                type="button"
                onClick={handleRemoveFile}
                className="p-1.5 hover:bg-violet-100 rounded-lg text-gray-500 hover:text-red-600 transition-colors shrink-0"
                title="Remove attachment"
              >
                <X size={16} />
              </button>
            </div>
          )}

          <div className="border border-border-default rounded-lg overflow-hidden focus-within:border-violet-500 focus-within:ring-4 focus-within:ring-violet-100 shadow-sm transition-all bg-white">
            {isRecording ? (
              <div className="w-full h-[88px] flex items-center justify-between px-6 bg-gradient-to-r from-red-50 to-pink-50 text-red-600 border-b-2 border-red-200">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-red-100 flex items-center justify-center animate-pulse">
                    <Mic size={22} />
                  </div>
                  <div>
                    <span className="font-bold text-base block">Recording Voice Note...</span>
                    <span className="text-xs text-red-500 font-medium">Click stop to send</span>
                  </div>
                </div>
                <button 
                  onClick={stopRecording} 
                  className="p-4 bg-gradient-to-br from-red-500 to-red-600 rounded-xl hover:from-red-600 hover:to-red-700 transition-all text-white shadow-lg shadow-red-500/30 hover:scale-105 active:scale-95" 
                  title="Stop & Send"
                >
                  <Square size={18} fill="currentColor" />
                </button>
              </div>
            ) : (
              <div className="w-full p-4">
                <RichTextEditor
                  ref={mainEditorRef}
                  placeholder={`Message #${channel.name} (Type '/' for commands)`}
                  onSubmit={() => handleSend()}
                  onChangeContent={(_html, text) => {
                    setContent(text);
                    socket.emit('typing:start', { channelId: channel.id });
                    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
                    typingTimeoutRef.current = setTimeout(() => socket.emit('typing:stop', { channelId: channel.id }), 1500);
                  }}
                />
              </div>
            )}

            <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-t-2 border-border-subtle">
              <div className="flex items-center gap-1.5">
                <input type="file" hidden ref={fileInputRef} onChange={handleFileUpload} />
                <button 
                  onClick={() => fileInputRef.current?.click()} 
                  disabled={isRecording} 
                  className="p-2.5 hover:bg-white hover:shadow-sm rounded-xl text-gray-500 hover:text-gray-700 disabled:opacity-50 transition-all group"
                  title="Attach file"
                >
                  <Plus size={20} className="group-hover:rotate-90 transition-transform" />
                </button>
                <button 
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)} 
                  disabled={isRecording} 
                  className={`p-2.5 rounded-xl transition-all ${showEmojiPicker ? 'bg-violet-100 text-violet-600 shadow-sm' : 'hover:bg-white hover:shadow-sm text-gray-500 hover:text-yellow-500'} disabled:opacity-50 group`}
                  title="Add emoji"
                >
                  <Smile size={20} className={showEmojiPicker ? '' : 'group-hover:scale-110 transition-transform'} />
                </button>
                <button 
                  onClick={startRecording} 
                  disabled={isRecording} 
                  className="p-2.5 hover:bg-red-50 hover:text-red-600 hover:shadow-sm rounded-xl text-gray-500 transition-all disabled:opacity-50 group" 
                  title="Record Voice Message"
                >
                  <Mic size={20} className="group-hover:scale-110 transition-transform" />
                </button>
              </div>
              <button 
                onClick={(e) => handleSend(e)} 
                disabled={(!content.trim() && !fileData) || isRecording} 
                className={`px-6 py-2.5 rounded-xl font-semibold text-sm transition-all flex items-center gap-2 ${
                  content.trim() || fileData 
                    ? 'bg-gradient-to-r from-violet-600 to-violet-700 hover:from-violet-700 hover:to-violet-800 text-white shadow-lg shadow-violet-600/30 hover:scale-105 active:scale-95' 
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                }`}
              >
                <Send size={16} /> 
                Send
              </button>
            </div>
          </div>
        </div>
      </div>

      {activeThread && (
        <ThreadPanel
          messageId={activeThread.id}
          channelId={channel.id}
          channelName={channel.name ?? ''}
          socket={socket}
          onClose={() => setActiveThread(null)}
        />
      )}
    </div>
  );
};