import React, { useState, useEffect, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { Paperclip, Send, Hash, Plus, X, File, FileText, Image as ImageIcon, Pencil, Reply, Search, Download, ChevronDown, MoreHorizontal, ChevronRight } from 'lucide-react';
import axios, { AxiosProgressEvent } from 'axios';
import { format } from 'date-fns';
import { useAuth } from '../../contexts/AuthContext';
import { Channel, Message } from '../../types';

export const ChatArea = ({ channel, socket, onlineUsers = [] }: { channel: Channel, socket: Socket, onlineUsers?: any[] }) => {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [content, setContent] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [fileData, setFileData] = useState<{ url: string, name: string, type: string } | null>(null);
  
  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingSearch, setIsLoadingSearch] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!channel) return;
    const fetch = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await axios.get(`/api/channels/${channel.id}/messages`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        setMessages(res.data);
        socket.emit('channel:join', channel.id);
        setIsSearching(false);
        setSearchQuery('');
        setSearchResults([]);
      } catch (err) { console.error(err); }
    };
    fetch();

    const handleMsg = (msg: Message) => {
      if (msg.channelId === channel.id) {
        setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
      }
    };
    const handleUpdate = (updated: Message) => {
      setMessages(prev => prev.map(m => m.id === updated.id ? updated : m));
    };
    const handleDelete = (deletedId: string) => {
      setMessages(prev => prev.filter(m => m.id !== deletedId));
    };

    socket.on('message:received', handleMsg);
    socket.on('message:updated', handleUpdate);
    socket.on('message:deleted', handleDelete);
    return () => { 
      socket.off('message:received', handleMsg); 
      socket.off('message:updated', handleUpdate);
      socket.off('message:deleted', handleDelete);
    };
  }, [channel, socket]);

  useEffect(() => {
    if (!isSearching) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isSearching]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      setIsSearching(false);
      setSearchResults([]);
      return;
    }

    setIsLoadingSearch(true);
    setIsSearching(true);
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`/api/channels/${channel.id}/search?q=${encodeURIComponent(searchQuery)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setSearchResults(res.data);
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setIsLoadingSearch(false);
    }
  };

  const handleSend = (e: any) => {
    e.preventDefault();
    if (!content.trim() && !fileData) return;
    socket.emit('message:send', { 
      channelId: channel.id, 
      content: content.trim() || (fileData ? `Shared a file: ${fileData.name}` : ''),
      fileUrl: fileData?.url,
      fileName: fileData?.name,
      fileType: fileData?.type,
      parentId: replyTo?.id
    });
    setContent('');
    setFileData(null);
    setReplyTo(null);
  };

  const handleEdit = (e: any) => {
    e.preventDefault();
    if (!editContent.trim() || !editingId) return;
    socket.emit('message:edit', { id: editingId, content: editContent.trim() });
    setEditingId(null);
    setEditContent('');
  };

  const onDeleteMessage = (id: string) => {
    if (window.confirm('Are you sure you want to delete this message?')) {
      socket.emit('message:delete', { id });
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadProgress(0);
    abortControllerRef.current = new AbortController();

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await axios.post('/api/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        signal: abortControllerRef.current.signal,
        onUploadProgress: (progressEvent: AxiosProgressEvent) => {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 1));
          setUploadProgress(percentCompleted);
        },
      });
      setFileData(res.data);
    } catch (err: any) {
      if (err.name === 'CanceledError') {
        console.log('Upload canceled');
      } else {
        console.error('Upload failed', err);
      }
    } finally {
      setUploading(false);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const cancelUpload = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const getFileIcon = (type: string) => {
    if (type.startsWith('image/')) return <ImageIcon size={20} className="text-blue-500" />;
    if (type.includes('pdf') || type.includes('text')) return <FileText size={20} className="text-orange-500" />;
    return <File size={20} className="text-gray-500" />;
  };

  if (!channel) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-gray-50 text-gray-400 p-12">
        <div className="w-24 h-24 bg-gray-100 rounded-full flex items-center justify-center mb-6">
          <Hash size={48} className="opacity-20" strokeWidth={1.5} />
        </div>
        <h2 className="text-2xl font-black text-gray-800 tracking-tight mb-2">Welcome to your workspace</h2>
        <p className="text-gray-500 font-medium max-w-sm text-center leading-relaxed">Select a channel from the sidebar to start collaborating with your team.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-white overflow-hidden h-full selection:bg-slack-purple/10">
      {/* Header */}
      <div className="h-[49px] border-b border-gray-200 flex items-center justify-between px-4 md:px-5 bg-white shrink-0 z-10">
        <div className="flex items-center gap-1 md:gap-2 flex-1 min-w-0">
          <button className="flex items-center gap-1 px-2 py-1 hover:bg-gray-100 rounded-md transition-colors group">
            {channel.isDM ? (
              <div className="relative">
                <div className="w-[18px] h-[18px] bg-gray-100 rounded flex items-center justify-center font-black text-[10px] text-gray-500">
                  {channel.name?.[0]?.toUpperCase()}
                </div>
                <div className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-white ${onlineUsers.some(u => u.username === channel.name) ? 'bg-slack-green' : 'bg-gray-300'}`} />
              </div>
            ) : (
              <Hash size={18} className="text-gray-400 group-hover:text-gray-600 transition-colors" />
            )}
            <span className="font-black text-base md:text-lg text-gray-900 tracking-tight truncate">{channel.name}</span>
            <ChevronDown size={14} className="text-gray-400 mt-0.5" />
          </button>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden md:flex items-center -space-x-1 hover:bg-gray-100 p-1 rounded-md transition-colors cursor-pointer text-gray-500">
            {[1, 2, 3].map((i) => (
              <div key={i} className={`w-6 h-6 rounded-md border-2 border-white flex items-center justify-center text-[10px] font-bold text-white shadow-sm shrink-0 ${i === 1 ? 'bg-[#e8912d]' : i === 2 ? 'bg-[#1264a3]' : 'bg-[#e01e5a]'}`}>
                {i === 1 ? 'A' : i === 2 ? 'B' : 'C'}
              </div>
            ))}
            <div className="w-6 h-6 rounded-md border-2 border-white bg-gray-100 flex items-center justify-center text-[10px] font-bold text-gray-400 shadow-sm shrink-0">
              +12
            </div>
          </div>

          <form onSubmit={handleSearch} className="relative flex-1 max-w-[120px] sm:max-w-xs md:max-w-[240px] group">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-slack-purple transition-colors" />
            <input 
              type="text"
              placeholder="Search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-gray-100 border border-transparent focus:border-gray-200 focus:bg-white rounded-md py-1 pl-8 pr-2 text-[13px] text-gray-900 placeholder-gray-500 outline-none transition-all"
            />
          </form>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto slack-scrollbar flex flex-col">
        {isSearching ? (
          <div className="px-6 py-6 max-w-4xl mx-auto w-full">
            <div className="flex items-center justify-between mb-8">
              <h3 className="text-xl font-black text-gray-900 tracking-tight">
                {isLoadingSearch ? 'Searching...' : `Found ${searchResults.length} results for "${searchQuery}"`}
              </h3>
              <button 
                onClick={() => {
                  setIsSearching(false);
                  setSearchQuery('');
                }}
                className="text-xs font-black text-slack-sidebar-active uppercase tracking-tighter hover:underline"
              >
                Close Search
              </button>
            </div>

            <div className="space-y-4">
              {isLoadingSearch ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex gap-4 animate-pulse p-4 border border-gray-100 rounded-xl">
                    <div className="w-9 h-9 bg-gray-100 rounded-lg" />
                    <div className="flex-1 space-y-2 py-1">
                      <div className="h-2 bg-gray-100 rounded w-1/4" />
                      <div className="h-2 bg-gray-100 rounded w-3/4" />
                    </div>
                  </div>
                ))
              ) : searchResults.length > 0 ? (
                    searchResults.map(m => {
                      const isOnline = onlineUsers.some(ou => ou.id === m.senderId);
                      return (
                        <div key={m.id} className="p-4 bg-white border border-gray-100 rounded-xl hover:border-gray-300 hover:shadow-sm transition-all cursor-pointer group">
                          <div className="flex gap-4">
                            <div className="relative shrink-0">
                              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-gray-400 to-gray-500 flex items-center justify-center font-black text-white text-sm shadow-sm border border-gray-100 uppercase">
                                {m.sender.username[0]}
                              </div>
                              <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${isOnline ? 'bg-slack-green' : 'bg-gray-400'}`} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-baseline gap-2 mb-1">
                                <span className="font-bold text-[15px] text-gray-900">{m.sender.username}</span>
                                <span className="text-[11px] text-gray-400 font-medium">{format(new Date(m.createdAt), 'MMM d, h:mm a')}</span>
                              </div>
                              <p className="text-gray-700 text-[14px] leading-snug line-clamp-3">{m.content}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })
              ) : (
                <div className="flex flex-col items-center justify-center py-20 text-gray-400 bg-gray-50 rounded-2xl border border-dashed border-gray-200">
                  <Search size={48} className="opacity-10 mb-4" />
                  <p className="font-bold text-sm">No results found in this channel.</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col py-6">
            <div className="px-5 mb-8">
              <div className="w-16 h-16 rounded-2xl bg-gray-100 flex items-center justify-center mb-4 border border-gray-200">
                <Hash size={32} className="text-gray-400" />
              </div>
              <h2 className="text-2xl font-black text-gray-900 tracking-tight">This is the very beginning of the #{channel.name} channel.</h2>
              <p className="text-gray-500 mt-2 font-medium max-w-2xl leading-relaxed">
                {channel.name === 'general' 
                  ? 'This is the one channel that every member is in. Use it for anything that doesn\'t have its own channel yet.'
                  : `Welcome to the #${channel.name} channel. Use this space for collaborations, questions, and updates about #${channel.name}.`}
              </p>
            </div>

            <div className="h-px bg-gray-200 w-full mb-6 relative">
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white px-4 py-1 border border-gray-200 rounded-full text-[11px] font-black text-gray-500 uppercase tracking-widest shadow-sm">
                Today
              </span>
            </div>

            {messages.filter(m => !m.parentId).map((m, idx) => {
              const rootMessages = messages.filter(msg => !msg.parentId);
              const rootIdx = rootMessages.findIndex(msg => msg.id === m.id);
              const isSameUserAsPrev = rootIdx > 0 && rootMessages[rootIdx - 1].sender.username === m.sender.username;
              const prevTime = rootIdx > 0 ? new Date(rootMessages[rootIdx - 1].createdAt) : null;
              const currTime = new Date(m.createdAt);
              const timeDiff = prevTime ? (currTime.getTime() - prevTime.getTime()) : 0;
              const shouldCompact = isSameUserAsPrev && timeDiff < 300000;
              const replies = messages.filter(reply => reply.parentId === m.id);

              return (
                <div key={m.id} className="flex flex-col relative group/msg">
                  <div className={`flex gap-3 px-4 md:px-5 hover:bg-gray-50 transition-colors relative ${shouldCompact ? 'py-0.5' : 'py-1 mt-4'}`}>
                    
                    <div className="absolute -top-3 right-4 md:right-8 bg-white border border-gray-200 rounded-lg shadow-[0_2px_12px_-4px_rgba(0,0,0,0.1)] flex items-center p-0.5 opacity-0 group-hover/msg:opacity-100 transition-all z-20 hover:shadow-lg">
                      <button onClick={() => setReplyTo(m)} className="p-1.5 hover:bg-gray-100 rounded text-gray-500 transition-colors" title="Reply in thread"><Reply size={16} /></button>
                      {user?.id === m.senderId && !editingId && (
                        <>
                          <button onClick={() => { setEditingId(m.id); setEditContent(m.content || ''); }} className="p-1.5 hover:bg-gray-100 rounded text-gray-500 transition-colors" title="Edit message"><Pencil size={16} /></button>
                          <button onClick={() => onDeleteMessage(m.id)} className="p-1.5 hover:bg-red-50 rounded text-red-400 hover:text-red-600 transition-colors" title="Delete message"><X size={16} /></button>
                        </>
                      )}
                      <button className="p-1.5 hover:bg-gray-100 rounded text-gray-500 transition-colors"><MoreHorizontal size={16} /></button>
                    </div>

                    {!shouldCompact ? (
                       <div className="relative shrink-0 mt-1">
                        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-slack-sidebar-active to-[#0b4d7c] flex items-center justify-center font-black text-white text-base shadow-sm border border-gray-200/10 uppercase">
                          {m.sender.username[0]}
                        </div>
                        <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${onlineUsers.some(ou => ou.id === m.senderId) ? 'bg-slack-green' : 'bg-gray-400'}`} />
                      </div>
                    ) : (
                      <div className="w-10 shrink-0 flex items-center justify-end pr-2">
                        <span className="text-[10px] text-gray-400 font-bold opacity-0 group-hover/msg:opacity-100 transition-opacity">
                          {format(new Date(m.createdAt), 'h:mm')}
                        </span>
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      {!shouldCompact && (
                        <div className="flex items-baseline gap-2 mb-0.5">
                          <span className="font-bold text-[15px] text-gray-900 hover:underline cursor-pointer leading-tight">{m.sender.username}</span>
                          <span className="text-[11px] text-gray-400 font-medium">{format(new Date(m.createdAt), 'h:mm a')}</span>
                        </div>
                      )}
                      
                      {editingId === m.id ? (
                        <div className="mt-1 border border-slack-sidebar-active rounded-lg overflow-hidden shadow-sm">
                          <textarea
                            autoFocus
                            value={editContent}
                            onChange={(e) => {
                              setEditContent(e.target.value);
                              e.target.style.height = 'auto';
                              e.target.style.height = `${e.target.scrollHeight}px`;
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEdit(e); }
                              if (e.key === 'Escape') setEditingId(null);
                            }}
                            className="w-full bg-white p-3 text-[15px] outline-none font-medium resize-none"
                          />
                          <div className="flex gap-2 p-2 bg-gray-50 border-t border-gray-100">
                            <button onClick={handleEdit} className="px-3 py-1 bg-slack-sidebar-active text-white text-[11px] font-black rounded transition-all active:scale-95">Save</button>
                            <button onClick={() => setEditingId(null)} className="px-3 py-1 hover:bg-gray-200 text-gray-500 text-[11px] font-black rounded transition-all">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="relative">
                          <p className="text-gray-800 leading-snug break-words text-[15px] font-medium whitespace-pre-wrap">{m.content}</p>
                          {m.fileUrl && (
                            <div className="mt-3 p-3 border border-gray-200 rounded-xl bg-white hover:border-gray-300 transition-all flex items-center gap-4 w-fit max-w-full group/file shadow-sm cursor-default">
                              <div className="w-12 h-12 bg-gray-50 rounded-lg flex items-center justify-center border border-gray-100 group-hover/file:bg-white transition-colors">
                                {getFileIcon(m.fileType || '')}
                              </div>
                              <div className="flex flex-col min-w-0 flex-1">
                                <div className="flex items-center gap-3">
                                  <a href={m.fileUrl} target="_blank" rel="noreferrer" className="text-sm font-bold text-blue-600 hover:underline truncate max-w-[300px]">
                                    {m.fileName}
                                  </a>
                                  <a href={m.fileUrl} download={m.fileName} className="p-1.5 hover:bg-gray-100 rounded-md text-gray-400 transition-colors opacity-0 group-hover/file:opacity-100" title="Download"><Download size={14} /></a>
                                </div>
                                <span className="text-[10px] text-gray-400 font-black uppercase tracking-widest mt-0.5">{m.fileType?.split('/')[1] || 'FILE'}</span>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {replies.length > 0 && (
                    <div className="ml-[60px] mt-1.5 mb-2">
                      <button onClick={() => setReplyTo(m)} className="flex items-center gap-3 p-1 px-2 rounded-lg hover:bg-white border border-transparent hover:border-gray-200 group/thread transition-all shadow-sm hover:shadow-md">
                        <div className="flex -space-x-1.5">
                          {Array.from(new Set(replies.map(r => r.sender.username))).slice(0, 3).map((u, i) => (
                            <div key={u} className={`w-6 h-6 rounded-md border border-white bg-gray-200 flex items-center justify-center text-[10px] font-black text-gray-600 shadow-sm ${i === 0 ? 'z-30' : i === 1 ? 'z-20' : 'z-10'}`}>{u[0].toUpperCase()}</div>
                          ))}
                        </div>
                        <span className="text-[13px] font-bold text-slack-sidebar-active group-hover/thread:underline">{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span>
                        <ChevronRight size={14} className="text-gray-300 group-hover/thread:text-slack-sidebar-active transition-colors" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="px-4 md:px-5 pb-5 shrink-0">
        <div className="flex flex-col border border-gray-300 rounded-xl focus-within:border-gray-400 shadow-[0_2px_12px_-4px_rgba(0,0,0,0.05)] transition-all bg-white relative">
          {replyTo && (
            <div className="p-2.5 px-4 bg-gray-50 border-b border-gray-200 rounded-t-xl flex items-center justify-between">
              <div className="flex items-center gap-3 overflow-hidden">
                <Reply size={13} className="text-slack-sidebar-active" />
                <span className="text-[11px] font-black text-gray-500 uppercase tracking-tight">Replying to {replyTo.sender.username}</span>
              </div>
              <button onClick={() => setReplyTo(null)} className="p-1.5 hover:bg-gray-200 rounded-full text-gray-400 transition-colors"><X size={16} /></button>
            </div>
          )}

          {uploading && (
            <div className="p-4 bg-gray-50 border-b border-gray-200 flex items-center gap-4">
              <div className="flex-1">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-[13px] font-black text-gray-700">Uploading...</span>
                  <span className="text-[13px] font-black text-slack-sidebar-active">{uploadProgress}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                  <div className="bg-slack-sidebar-active h-full transition-all" style={{ width: `${uploadProgress}%` }} />
                </div>
              </div>
              <button onClick={cancelUpload} className="p-2 hover:bg-gray-200 rounded-full text-gray-400 transition-colors"><X size={20} /></button>
            </div>
          )}

          {fileData && !uploading && (
            <div className="p-4 bg-blue-50/50 border-b border-blue-100 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-black text-gray-900 truncate">{fileData.name}</div>
                <div className="text-[10px] font-black text-blue-500 uppercase tracking-widest">{fileData.type}</div>
              </div>
              <button onClick={() => setFileData(null)} className="p-2 hover:bg-blue-100 rounded-full text-blue-400 transition-colors"><X size={20} /></button>
            </div>
          )}

          <div className="flex flex-col">
            <textarea 
              rows={1}
              value={content} 
              onChange={e => {
                setContent(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${e.target.scrollHeight}px`;
              }} 
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(e); } }}
              placeholder={`Message #${channel.name}`} 
              disabled={uploading}
              className="w-full bg-transparent p-4 pb-3 text-[15px] font-medium text-gray-800 focus:outline-none resize-none min-h-[56px] max-h-[40vh] disabled:opacity-50" 
            />
            
            <div className="flex items-center justify-between p-2 px-3 bg-white border-t border-gray-50 rounded-b-xl">
              <div className="flex items-center gap-1">
                <input type="file" className="hidden" ref={fileInputRef} onChange={handleFileSelect} />
                <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading || !!fileData} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 transition-all active:scale-90" title="Attach file"><Plus size={20} /></button>
              </div>
              <button onClick={handleSend} disabled={(!content.trim() && !fileData) || uploading} className={`p-2 px-4 rounded-lg transition-all flex items-center gap-2 ${ (content.trim() || fileData) && !uploading ? 'bg-[#007a5a] text-white shadow-md active:scale-95 hover:bg-[#00624a]' : 'text-gray-300 cursor-not-allowed' }`} >
                <span className="text-xs font-black uppercase tracking-widest hidden sm:block">Send</span>
                <Send size={18} />
              </button>
            </div>
          </div>
        </div>
        <div className="mt-2 text-center">
          <span className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">
            <b>Enter</b> to send • <b>Shift + Enter</b> for new line
          </span>
        </div>
      </div>
    </div>
  );
};
