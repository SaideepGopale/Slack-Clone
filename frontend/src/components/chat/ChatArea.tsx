import axios from 'axios';
import { format } from 'date-fns';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import {
  BarChart2, // 👇 NAYA: Polls ke liye icon
  Download,
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
  Video, X
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import { Channel, Message, User } from '../../types';
import { LinkPreview } from './LinkPreview';

interface Reaction { emoji: string; count: number; }
// 👇 NAYA: Poll Interfaces 👇
interface PollOption { id: string; text: string; votes: string[]; }
interface PollData { question: string; options: PollOption[]; }
interface ChatMessage extends Message { reactions: Reaction[]; isPinned?: boolean; pollData?: PollData; }

interface FileData { url: string; name: string; type: string; }

interface ChatAreaProps {
  channel: Channel;
  socket: Socket;
  onlineUsers?: User[];
  onStartCall: (type: 'audio' | 'video') => void;
}

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

export const ChatArea = ({ channel, socket, onlineUsers = [], onStartCall }: ChatAreaProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [content, setContent] = useState('');
  
  const [activeThread, setActiveThread] = useState<ChatMessage | null>(null);
  const [threadContent, setThreadContent] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [reactingToId, setReactingToId] = useState<string | null>(null);
  
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const threadTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

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
        const filtered = prev.filter(m => !m.id.startsWith('temp-'));
        if (filtered.find(m => m.id === message.id)) return filtered;
        return [...filtered, { ...message, reactions: message.reactions ?? [] }];
      });
    };
    const handleUpdate = (updated: ChatMessage) => setMessages(prev => prev.map(m => m.id === updated.id ? updated : m));
    const handleDelete = (id: string) => setMessages(prev => prev.filter(m => m.id !== id));
    
    const handleTypingStarted = ({ channelId, username }: { channelId: string; username: string }) => {
      if (channelId === channel.id) setTypingUsers(prev => prev.includes(username) ? prev : [...prev, username]);
    };
    const handleTypingStopped = ({ channelId, username }: { channelId: string; username: string }) => {
      if (channelId === channel.id) setTypingUsers(prev => prev.filter(u => u !== username));
    };

    socket.on('message:received', handleMessage);
    socket.on('message:updated', handleUpdate);
    socket.on('message:deleted', handleDelete);
    socket.on('typing:started', handleTypingStarted);
    socket.on('typing:stopped', handleTypingStopped);

    return () => {
      socket.off('message:received', handleMessage);
      socket.off('message:updated', handleUpdate);
      socket.off('message:deleted', handleDelete);
      socket.off('typing:started', handleTypingStarted);
      socket.off('typing:stopped', handleTypingStopped);
    };
  }, [channel, socket]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typingUsers]);

  useEffect(() => {
    if (activeThread) threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeThread]);

  const handleSend = (e?: React.FormEvent, isThread = false) => {
    if (e) e.preventDefault();

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    socket.emit('typing:stop', { channelId: channel.id });

    const text = isThread ? threadContent : content;
    if (!text.trim() && !fileData) return;
    
    setSending(!isThread);
    setError(null);

    // 👇 NAYA: Slash Command Detector for /poll 👇
    let finalContent = text;
    let pollData = undefined;

    if (!isThread && text.trim().startsWith('/poll')) {
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
      parentId: isThread && activeThread ? activeThread.id : null,
    });
    
    if (isThread) {
      setThreadContent('');
    } else {
      setContent(''); 
      setFileData(null);
      setShowEmojiPicker(false); 
      setSending(false);
    }
  };

  const handleVote = (messageId: string, optionId: string) => {
    socket.emit('poll:vote', { messageId, optionId });
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

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        
        if (audioBlob.size === 0) {
           setError("Voice recording failed. Please try again.");
           if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
           return;
        }

        const audioFile = new File([audioBlob], `voice-${Date.now()}.webm`, { type: 'audio/webm' });
        const formData = new FormData();
        formData.append('file', audioFile);
        
        try {
          setUploading(true);
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
          console.error("Audio Upload Error:", err);
          setError('Failed to send voice note.');
        } finally { 
          setUploading(false); 
          setUploadProgress(0); 
          if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
        }
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
    socket.emit('message:edit', { id: editingId, content: editContent });
    setMessages(prev => prev.map(m => m.id === editingId ? { ...m, content: editContent } : m));
    setEditingId(null); setEditContent('');
  };

  const handleDelete = (id: string) => {
    socket.emit('message:delete', { id });
    if (activeThread?.id === id) setActiveThread(null);
  };

  const handlePin = (id: string, currentStatus: boolean) => {
    socket.emit('message:pin', { id, isPinned: !currentStatus });
    setMessages(prev => prev.map(m => m.id === id ? { ...m, isPinned: !currentStatus } : m));
  };

  const handleReact = (messageId: string, emoji: string) => {
    setMessages(prev => prev.map(msg => {
      if (msg.id !== messageId) return msg;
      const reactions = [...(msg.reactions ?? [])];
      const existing = reactions.find(r => r.emoji === emoji);
      if (existing) existing.count += 1; else reactions.push({ emoji, count: 1 });
      return { ...msg, reactions };
    }));
    setReactingToId(null);
    socket.emit('message:react', { messageId, emoji });
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setError('File size < 10MB'); return; }
    
    const formData = new FormData();
    formData.append('file', file);
    try {
      setUploading(true);
      const res = await axios.post<FileData>('/api/upload', formData, {
        onUploadProgress: (pe) => setUploadProgress(Math.round((pe.loaded * 100) / (pe.total ?? 1))),
      });
      setFileData(res.data);
    } catch (err: any) { 
      setError('Upload failed');
    } finally { setUploading(false); setUploadProgress(0); }
  };

  if (!channel) return null;

  const mainMessages = messages.filter(m => !m.parentId);
  const threadMessages = activeThread ? messages.filter(m => m.parentId === activeThread.id) : [];
  const pinnedMessages = mainMessages.filter(m => m.isPinned);

  const renderMessageUI = (m: ChatMessage, isThreadView = false) => {
    const replyCount = messages.filter(msg => msg.parentId === m.id).length;
    const isAudioMsg = m.content === '🎙️ Voice Note' || (m.fileUrl && (m.fileType?.includes('audio') || m.fileType?.includes('webm')));
    const isPoll = Boolean(m.pollData); // Check if this is a poll message

    return (
      <div key={m.id} className={`group flex gap-4 hover:bg-gray-50/70 rounded-2xl p-5 transition-all relative ${m.isPinned ? 'bg-amber-50/30 border border-amber-100/50' : ''} animate-fade-in`}>
        
        {m.isPinned && !isThreadView && (
          <div className="absolute -top-2 left-10 bg-gradient-to-r from-amber-100 to-yellow-100 text-amber-700 text-[10px] px-2.5 py-1 rounded-full font-bold flex items-center gap-1.5 border border-amber-200 shadow-sm z-10">
            <Pin size={10} /> Pinned
          </div>
        )}

        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-600 to-purple-600 text-white flex items-center justify-center font-bold uppercase shadow-md shrink-0 text-base">
          {m.sender?.username?.[0]}
        </div>
        <div className="flex-1 min-w-0 relative">
          <div className="flex items-center gap-3 mb-1">
            <span className="font-bold text-gray-900 text-base">{m.sender?.username}</span>
            <span className="text-xs text-gray-500 font-medium bg-gray-100 px-2 py-0.5 rounded-md">{format(new Date(m.createdAt), 'h:mm a')}</span>
          </div>
          
          {editingId === m.id ? (
            <div className="mt-4">
              <textarea 
                value={editContent} 
                onChange={e => setEditContent(e.target.value)} 
                className="w-full border-2 border-blue-300 rounded-xl p-4 outline-none focus:ring-4 focus:ring-blue-50 text-base" 
                rows={3}
              />
              <div className="flex gap-2 mt-3">
                <button 
                  onClick={handleEdit} 
                  className="px-5 py-2 bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-xl text-sm font-semibold shadow-md shadow-blue-600/30 hover:from-blue-700 hover:to-blue-800 transition-all hover:scale-105 active:scale-95"
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
                <div className="mt-3 bg-white border border-gray-200 rounded-xl p-5 shadow-sm max-w-lg">
                  <div className="font-bold text-lg text-gray-900 mb-4 flex items-center gap-2">
                    <div className="bg-blue-100 text-blue-600 p-1.5 rounded-lg"><BarChart2 size={20} /></div>
                    {m.pollData?.question}
                  </div>
                  <div className="flex flex-col gap-3">
                    {m.pollData?.options.map(opt => {
                      const totalVotes = m.pollData!.options.reduce((acc, o) => acc + o.votes.length, 0);
                      const percent = totalVotes === 0 ? 0 : Math.round((opt.votes.length / totalVotes) * 100);
                      
                      return (
                        <div key={opt.id} onClick={() => handleVote(m.id, opt.id)} className="relative h-11 w-full bg-gray-100 rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-blue-300 transition-all group/poll">
                          {/* Progress Bar Background */}
                          <div 
                            className="absolute top-0 left-0 h-full bg-blue-100 transition-all duration-500 ease-out" 
                            style={{ width: `${percent}%` }}
                          ></div>
                          {/* Text and Count */}
                          <div className="absolute inset-0 flex items-center justify-between px-4 z-10">
                            <span className="font-semibold text-gray-800 group-hover/poll:text-blue-700 transition-colors text-sm">{opt.text}</span>
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
                  <div className="mt-2 text-[15px] text-gray-800 leading-relaxed" dangerouslySetInnerHTML={renderFormattedText(m.content ?? '')} />
                )
              )}
            </>
          )}

          {m.content && !isPoll && (m.content.match(/(https?:\/\/[^\s]+)/g) || []).map((url, idx) => (
            <LinkPreview key={idx} url={url} />
          ))}

          {isAudioMsg ? (
            <div className="mt-3 bg-gradient-to-br from-blue-50 to-purple-50 p-4 rounded-2xl w-fit min-w-[300px] shadow-sm border border-blue-100">
              <div className="text-sm font-bold text-blue-700 mb-3 flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
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
                    className="text-[11px] text-blue-600 hover:text-blue-700 underline font-medium"
                  >
                    Open in new tab
                  </a>
                </div>
              ) : (
                <span className="text-xs text-red-500 font-semibold">Audio missing.</span>
              )}
            </div>
          ) : m.fileUrl ? (
            <div className="mt-4 border-2 border-gray-200 rounded-2xl p-5 flex items-center justify-between bg-gradient-to-br from-gray-50 to-white hover:border-blue-300 transition-all shadow-sm hover:shadow-md group/file">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-blue-100 flex items-center justify-center shrink-0 group-hover/file:bg-blue-200 transition-colors">
                  <Download size={20} className="text-blue-600" />
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
                className="p-3 hover:bg-blue-50 rounded-xl transition-all text-blue-600 hover:scale-110 active:scale-95"
              >
                <Download size={20} />
              </a>
            </div>
          ) : null}
          
          <div className="flex gap-2 mt-4 flex-wrap items-center">
            {m.reactions?.map((reaction, index) => (
              <button 
                key={index} 
                onClick={() => handleReact(m.id, reaction.emoji)} 
                className="px-3 py-1.5 rounded-xl text-sm bg-white hover:bg-gray-50 border-2 border-gray-200 hover:border-blue-300 transition-all shadow-sm hover:shadow-md hover:scale-105 active:scale-95 font-medium"
              >
                <span className="text-base">{reaction.emoji}</span>
                <span className="ml-1.5 text-gray-700 font-bold">{reaction.count}</span>
              </button>
            ))}
            
            {!isThreadView && replyCount > 0 && (
              <button 
                onClick={() => setActiveThread(m)} 
                className="flex items-center gap-2 text-sm font-bold text-blue-600 hover:text-blue-700 hover:bg-blue-50 px-4 py-1.5 rounded-xl transition-all shadow-sm hover:shadow-md border border-blue-200 hover:border-blue-300"
              >
                <MessageSquare size={15} /> 
                {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
              </button>
            )}
          </div>

          {reactingToId === m.id && (
            <div className="absolute top-12 left-0 z-50 shadow-2xl rounded-2xl border border-gray-200 overflow-hidden bg-white animate-scale-in">
              <EmojiPicker 
                onEmojiClick={(emojiData) => handleReact(m.id, emojiData.emoji)} 
                theme={Theme.LIGHT} 
                lazyLoadEmojis={true}
              />
            </div>
          )}
        </div>

        <div className="absolute right-4 top-4 hidden group-hover:flex items-center gap-0.5 bg-white border-2 border-gray-200 rounded-xl shadow-lg p-1 z-10 animate-scale-in">
          <button 
            onClick={() => setReactingToId(reactingToId === m.id ? null : m.id)} 
            className="p-2.5 hover:bg-blue-50 rounded-lg text-gray-600 hover:text-blue-600 transition-all" 
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
              onClick={() => { setEditingId(m.id); setEditContent(m.content ?? ''); }} 
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
      <div className={`flex flex-col h-full transition-all duration-300 ${activeThread ? 'w-[calc(100%-420px)] border-r border-gray-200' : 'w-full'}`}>
        
        <div className="border-b bg-white px-6 py-4 flex items-center justify-between shrink-0 h-[80px] shadow-sm">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold text-lg shadow-md">
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
            <button 
              onClick={() => onStartCall('audio')} 
              className="w-11 h-11 rounded-xl bg-gray-100 hover:bg-gray-200 flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-sm group"
              title="Start audio call"
            >
              <Phone size={20} className="text-gray-700 group-hover:text-gray-900" />
            </button>
            <button 
              onClick={() => onStartCall('video')} 
              className="w-11 h-11 rounded-xl bg-gradient-to-br from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-md shadow-blue-600/30 group"
              title="Start video call"
            >
              <Video size={20} className="text-white" />
            </button>
          </div>
        </div>

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

        <div className="flex-1 overflow-y-auto slack-scrollbar p-6 bg-white" onClick={(e) => e.stopPropagation()}>
          {error && (
            <div className="mb-4 p-4 bg-gradient-to-r from-red-50 to-pink-50 text-red-700 rounded-xl border border-red-200 text-sm flex justify-between items-center shadow-sm animate-fade-in">
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

          {mainMessages.map(m => renderMessageUI(m, false))}
          
          {typingUsers.length > 0 && (
            <div className="flex items-center gap-3 text-sm text-gray-500 py-3 px-4 animate-fade-in">
              <div className="flex gap-1">
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
              </div>
              <span className="font-medium">
                {typingUsers.join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing...
              </span>
            </div>
          )}
          {uploading && (
            <div className="flex items-center gap-3 text-sm bg-blue-50 text-blue-600 py-3 px-4 rounded-xl border border-blue-200 animate-fade-in shadow-sm">
              <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
                <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
              </div>
              <div className="flex-1">
                <div className="font-semibold mb-1">Uploading audio...</div>
                <div className="w-full bg-blue-200 rounded-full h-1.5 overflow-hidden">
                  <div className="bg-blue-600 h-full transition-all duration-300 rounded-full" style={{ width: `${uploadProgress}%` }}></div>
                </div>
              </div>
              <span className="font-bold text-sm">{uploadProgress}%</span>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className="border-t border-gray-200 bg-gradient-to-b from-white to-gray-50 p-5 shrink-0 relative" onClick={(e) => e.stopPropagation()}>
          
          {showEmojiPicker && (
            <div className="absolute bottom-full left-4 mb-3 z-50 shadow-2xl rounded-2xl border border-gray-200 overflow-hidden bg-white animate-scale-in">
              <EmojiPicker 
                onEmojiClick={(emojiData) => {
                  setContent(prev => prev + emojiData.emoji);
                  textareaRef.current?.focus();
                  setShowEmojiPicker(false);
                }} 
                theme={Theme.LIGHT} 
                lazyLoadEmojis={true}
              />
            </div>
          )}

          {/* 👇 NAYA: Command Hint Box 👇 */}
          {content.startsWith('/') && !content.startsWith('/poll') && (
            <div className="absolute bottom-full left-4 mb-2 bg-white border border-gray-200 shadow-xl rounded-xl p-3 z-50 min-w-[250px] animate-fade-in">
              <div className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Slash Commands</div>
              <div 
                className="flex items-center gap-3 p-2 hover:bg-blue-50 rounded-lg cursor-pointer transition-colors"
                onClick={() => setContent('/poll "Your Question?" "Option 1" "Option 2"')}
              >
                <div className="bg-blue-100 text-blue-600 p-1.5 rounded-md"><BarChart2 size={16} /></div>
                <div>
                  <div className="font-bold text-sm text-gray-900">/poll</div>
                  <div className="text-xs text-gray-500">Create a live voting poll</div>
                </div>
              </div>
            </div>
          )}

          <div className="border-2 border-gray-200 rounded-2xl overflow-hidden focus-within:border-blue-500 focus-within:ring-4 focus-within:ring-blue-50 shadow-sm transition-all bg-white">
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
              <textarea
                ref={textareaRef} rows={3} value={content}
                onChange={e => {
                  setContent(e.target.value);
                  socket.emit('typing:start', { channelId: channel.id });
                  if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
                  typingTimeoutRef.current = setTimeout(() => socket.emit('typing:stop', { channelId: channel.id }), 2000);
                }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                className="w-full p-4 resize-none outline-none text-gray-800 text-base leading-relaxed"
                placeholder={`Message #${channel.name} (Type '/' for commands)`}
              />
            )}

            <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-t-2 border-gray-100">
              <div className="flex items-center gap-1.5">
                <input type="file" hidden ref={fileInputRef} onChange={handleFileSelect} />
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
                  className={`p-2.5 rounded-xl transition-all ${showEmojiPicker ? 'bg-blue-100 text-blue-600 shadow-sm' : 'hover:bg-white hover:shadow-sm text-gray-500 hover:text-yellow-500'} disabled:opacity-50 group`}
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
                    ? 'bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white shadow-lg shadow-blue-600/30 hover:scale-105 active:scale-95' 
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
        <div className="w-[400px] flex flex-col h-full bg-gray-50 shrink-0 shadow-[-4px_0_15px_rgba(0,0,0,0.05)] z-10 animate-in slide-in-from-right-8" onClick={(e) => e.stopPropagation()}>
          <div className="h-[72px] px-5 border-b border-gray-200 flex items-center justify-between bg-white shrink-0">
            <div>
              <h3 className="font-bold text-lg text-gray-900">Thread</h3>
              <p className="text-xs text-gray-500">#{channel.name}</p>
            </div>
            <button onClick={() => setActiveThread(null)} className="p-2 hover:bg-gray-100 rounded-xl transition text-gray-500"><X size={20} /></button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <div className="bg-white border-b border-gray-100 pb-2">
              {renderMessageUI(activeThread, true)}
            </div>
            <div className="p-4 flex flex-col gap-1">
              <div className="flex items-center gap-3 mb-4">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{threadMessages.length} Replies</span>
                <div className="flex-1 h-px bg-gray-200"></div>
              </div>
              {threadMessages.map(m => renderMessageUI(m, true))}
              <div ref={threadEndRef} />
            </div>
          </div>
          <div className="p-4 bg-white border-t border-gray-200 shrink-0">
            <div className="border border-gray-300 rounded-xl overflow-hidden focus-within:border-blue-500 shadow-sm">
              <textarea
                ref={threadTextareaRef} rows={2} value={threadContent}
                onChange={e => setThreadContent(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(e, true); } }}
                className="w-full p-3 resize-none outline-none text-gray-700 text-sm"
                placeholder="Reply in thread..."
              />
              <div className="flex justify-end px-3 py-2 bg-gray-50 border-t border-gray-200">
                <button onClick={(e) => handleSend(e, true)} disabled={!threadContent.trim()} className={`px-4 py-1.5 rounded-lg font-semibold text-sm transition ${threadContent.trim() ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-400'}`}>
                  Reply
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};