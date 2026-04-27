import React, { useState, useEffect, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { Paperclip, Send, Hash, Plus, X, File, FileText, Image as ImageIcon, Pencil, Reply, Search, Download } from 'lucide-react';
import axios, { AxiosProgressEvent } from 'axios';
import { format } from 'date-fns';
import { useAuth } from '../../contexts/AuthContext';
import { Channel, Message } from '../../types';

export const ChatArea = ({ channel, socket }: { channel: Channel, socket: Socket }) => {
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

    socket.on('message:received', handleMsg);
    socket.on('message:updated', handleUpdate);
    return () => { 
      socket.off('message:received', handleMsg); 
      socket.off('message:updated', handleUpdate);
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
    <div className="flex-1 flex flex-col bg-white overflow-hidden h-full">
      <div className="h-16 border-b border-gray-100 flex items-center justify-between px-4 md:px-6 bg-white shrink-0 z-10">
        <div className="flex items-center gap-2 md:gap-4 flex-1 min-w-0">
          <div className="flex items-center gap-1 md:gap-2 font-black text-lg md:text-xl text-gray-900 tracking-tight truncate">
            <span className="text-gray-300 font-bold">#</span>
            {channel.name}
          </div>

          <form onSubmit={handleSearch} className="relative flex-1 max-w-[120px] sm:max-w-xs md:max-w-sm ml-2 md:ml-4 group">
            <Search size={14} className="absolute left-2.5 md:left-3 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-slack-active transition-colors" />
            <input 
              type="text"
              placeholder={window.innerWidth < 640 ? "Search" : `Search in #${channel.name}`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-gray-50 border border-gray-200 rounded-lg py-1.5 pl-8 md:pl-9 pr-2 md:pr-3 text-xs md:text-sm outline-none focus:bg-white focus:border-slack-active transition-all placeholder:text-[10px] sm:placeholder:text-xs"
            />
            {searchQuery && (
              <button 
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setIsSearching(false);
                  setSearchResults([]);
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X size={14} />
              </button>
            )}
          </form>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto slack-scrollbar">
        {isSearching ? (
          <div className="p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-black text-gray-900 tracking-tight">
                {isLoadingSearch ? 'Searching...' : `Found ${searchResults.length} results for "${searchQuery}"`}
              </h3>
              <button 
                onClick={() => {
                  setIsSearching(false);
                  setSearchQuery('');
                }}
                className="text-xs font-black text-slack-active uppercase tracking-tighter hover:underline"
              >
                Clear Search
              </button>
            </div>

            <div className="space-y-4">
              {isLoadingSearch ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex gap-4 animate-pulse">
                    <div className="w-10 h-10 bg-gray-100 rounded-lg" />
                    <div className="flex-1 space-y-2 py-1">
                      <div className="h-2 bg-gray-100 rounded w-1/4" />
                      <div className="h-2 bg-gray-100 rounded w-3/4" />
                    </div>
                  </div>
                ))
              ) : searchResults.length > 0 ? (
                searchResults.map(m => (
                  <div key={m.id} className="p-4 bg-gray-50/50 border border-gray-100 rounded-xl hover:border-gray-200 transition-colors cursor-pointer group">
                    <div className="flex gap-3">
                      <div className="w-8 h-8 rounded bg-white flex items-center justify-center font-bold text-gray-500 shrink-0 text-xs shadow-sm border border-gray-100 uppercase">
                        {m.sender.username[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 mb-1">
                          <span className="font-bold text-[13px] text-gray-900">{m.sender.username}</span>
                          <span className="text-[9px] text-gray-400 font-bold uppercase">{format(new Date(m.createdAt), 'MMM d, h:mm a')}</span>
                        </div>
                        <p className="text-gray-700 text-[14px] leading-snug line-clamp-2">{m.content}</p>
                        {m.fileUrl && (
                          <div className="mt-2 p-2 border border-gray-100 rounded-lg bg-white flex items-center gap-2 w-fit max-w-full">
                            {getFileIcon(m.fileType || '')}
                            <div className="flex flex-col min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <a href={m.fileUrl} target="_blank" rel="noreferrer" className="text-[11px] font-bold text-blue-600 hover:underline truncate max-w-[150px]">
                                  {m.fileName}
                                </a>
                                <a 
                                  href={m.fileUrl} 
                                  download={m.fileName} 
                                  className="p-1 hover:bg-gray-100 rounded text-gray-400 transition-colors"
                                >
                                  <Download size={12} />
                                </a>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                  <Search size={48} className="opacity-10 mb-4" />
                  <p className="font-bold text-sm">No results found in this channel.</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="p-4 space-y-1">
            {messages.filter(m => !m.parentId).map((m, idx) => {
          const rootMessages = messages.filter(msg => !msg.parentId);
          const rootIdx = rootMessages.findIndex(msg => msg.id === m.id);
          const isSameUserAsPrev = rootIdx > 0 && rootMessages[rootIdx - 1].sender.username === m.sender.username;
          const timeDiff = rootIdx > 0 ? (new Date(m.createdAt).getTime() - new Date(rootMessages[rootIdx - 1].createdAt).getTime()) : 0;
          const shouldCompact = isSameUserAsPrev && timeDiff < 300000;

          const replies = messages.filter(reply => reply.parentId === m.id);

          return (
            <div key={m.id} className="flex flex-col">
              <div className={`group flex gap-4 px-4 hover:bg-gray-50 transition-colors ${shouldCompact ? 'py-0.5' : 'py-3 mt-4'}`}>
                {!shouldCompact ? (
                  <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center font-black text-gray-600 shrink-0 text-lg shadow-sm border border-gray-200 uppercase">
                    {m.sender.username[0]}
                  </div>
                ) : (
                  <div className="w-10 shrink-0 flex items-center justify-end pr-2">
                    <span className="text-[10px] text-gray-400 font-bold opacity-0 group-hover:opacity-100 transition-opacity">
                      {format(new Date(m.createdAt), 'h:mm')}
                    </span>
                  </div>
                )}
                <div className="flex-1 min-w-0 relative">
                  {!shouldCompact && (
                    <div className="flex items-baseline gap-2 mb-0.5">
                      <span className="font-bold text-gray-900 hover:underline cursor-pointer">{m.sender.username}</span>
                      <span className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">{format(new Date(m.createdAt), 'h:mm a')}</span>
                    </div>
                  )}
                  
                  {editingId === m.id ? (
                    <div className="mt-1">
                      <textarea
                        autoFocus
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEdit(e); }
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        className="w-full bg-white border-2 border-slack-active rounded-lg p-2 text-sm outline-none shadow-sm"
                      />
                      <div className="flex gap-2 mt-1">
                        <button onClick={handleEdit} className="text-[10px] font-black text-slack-active hover:underline">Save</button>
                        <button onClick={() => setEditingId(null)} className="text-[10px] font-black text-gray-500 hover:underline">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-gray-800 leading-relaxed break-words text-[15px]">{m.content}</p>
                      {m.fileUrl && (
                        <div className="mt-2 p-3 border border-gray-100 rounded-lg bg-gray-50/50 flex items-center gap-3 w-fit max-w-full">
                          {getFileIcon(m.fileType || '')}
                          <div className="flex flex-col min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <a href={m.fileUrl} target="_blank" rel="noreferrer" className="text-sm font-bold text-blue-600 hover:underline truncate max-w-[200px]">
                                {m.fileName}
                              </a>
                              <a 
                                href={m.fileUrl} 
                                download={m.fileName} 
                                className="p-1 hover:bg-gray-200 rounded text-gray-400 transition-colors"
                                title="Download file"
                              >
                                <Download size={14} />
                              </a>
                            </div>
                            <span className="text-[10px] text-gray-400 font-bold uppercase truncate">{m.fileType}</span>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  <div className="absolute top-0 right-0 flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                    <button 
                      onClick={() => setReplyTo(m)}
                      className="p-1 hover:bg-gray-200 rounded text-gray-400"
                    >
                      <Reply size={14} />
                    </button>
                    {user?.id === m.senderId && !editingId && (
                      <button 
                        onClick={() => {
                          setEditingId(m.id);
                          setEditContent(m.content || '');
                        }}
                        className="p-1 hover:bg-gray-200 rounded text-gray-400"
                      >
                        <Pencil size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Replies */}
              {replies.length > 0 && (
                <div className="ml-14 mt-1 space-y-1 mb-2">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="h-px bg-gray-100 flex-1" />
                    <span className="text-[10px] font-black text-gray-400 uppercase tracking-tighter">{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span>
                    <div className="h-px bg-gray-100 flex-1" />
                  </div>
                  {replies.map(reply => (
                    <div key={reply.id} className="group flex gap-3 px-4 py-1.5 hover:bg-gray-50 rounded-lg transition-colors">
                      <div className="w-8 h-8 rounded bg-gray-100 flex items-center justify-center font-bold text-gray-500 shrink-0 text-xs uppercase">
                        {reply.sender.username[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="font-bold text-[13px] text-gray-900">{reply.sender.username}</span>
                          <span className="text-[9px] text-gray-400 font-bold">{format(new Date(reply.createdAt), 'h:mm a')}</span>
                        </div>
                        <p className="text-gray-700 text-[14px] leading-snug">{reply.content}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
    )}
  </div>

  <div className="p-6 pt-2 shrink-0">
        {replyTo && (
          <div className="mb-2 p-2 bg-gray-50 border border-gray-100 rounded-lg flex items-center justify-between">
            <div className="flex items-center gap-2 overflow-hidden">
              <Reply size={14} className="text-gray-400 shrink-0" />
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-tighter shrink-0">Replying to {replyTo.sender.username}:</span>
              <span className="text-xs text-gray-600 truncate">{replyTo.content}</span>
            </div>
            <button onClick={() => setReplyTo(null)} className="p-1 hover:bg-gray-200 rounded-full text-gray-400 transition-colors">
              <X size={14} />
            </button>
          </div>
        )}

        {uploading && (
          <div className="mb-2 p-3 bg-gray-50 border border-gray-100 rounded-lg flex items-center gap-4">
            <div className="w-10 h-10 rounded bg-gray-200 flex items-center justify-center animate-pulse">
              <Paperclip size={18} className="text-gray-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex justify-between items-center mb-1">
                <span className="text-xs font-bold text-gray-600 truncate">Uploading file...</span>
                <span className="text-[10px] font-black text-slack-active">{uploadProgress}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
                <div 
                  className="bg-slack-active h-full transition-all duration-300" 
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
            <button 
              type="button"
              onClick={cancelUpload}
              className="p-1 hover:bg-gray-200 rounded-full text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {fileData && !uploading && (
          <div className="mb-2 p-3 bg-blue-50 border border-blue-100 rounded-lg flex items-center gap-3 relative group">
            <div className="w-10 h-10 rounded bg-white flex items-center justify-center shadow-sm border border-blue-100">
              {getFileIcon(fileData.type)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-bold text-gray-900 truncate">{fileData.name}</div>
              <div className="text-[10px] text-gray-500 font-medium uppercase">{fileData.type}</div>
            </div>
            <button 
              type="button"
              onClick={() => setFileData(null)}
              className="p-1.5 hover:bg-blue-100 rounded-full text-blue-400 hover:text-blue-600 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        )}

        <form onSubmit={handleSend} className="relative flex flex-col border-2 border-gray-200 rounded-xl focus-within:border-gray-400 transition-all bg-white shadow-sm overflow-hidden">
          <input 
            type="file" 
            className="hidden" 
            ref={fileInputRef} 
            onChange={handleFileSelect}
          />
          <div className="flex-1 bg-gray-50/50 flex items-start">
             <textarea 
              rows={1}
              value={content} 
              onChange={e => {
                setContent(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${e.target.scrollHeight}px`;
              }} 
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(e); } }}
              placeholder={uploading ? 'Wait for upload...' : `Message #${channel.name}`} 
              disabled={uploading}
              className="flex-1 bg-transparent py-3 px-4 outline-none text-gray-800 resize-none min-h-[44px] max-h-[30vh] font-medium disabled:opacity-50" 
            />
          </div>
          <div className="flex items-center justify-between p-2 bg-white border-t border-gray-100">
            <div className="flex gap-1">
               <button 
                type="button" 
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || !!fileData}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-all disabled:opacity-30"
               >
                <Plus size={18} />
               </button>
            </div>
            <button 
              disabled={(!content.trim() && !fileData) || uploading} 
              className={`p-2 rounded transition-all ${(content.trim() || fileData) && !uploading ? 'bg-slack-green text-white shadow-lg active:scale-95' : 'text-gray-300'}`}
            >
              <Send size={18} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
