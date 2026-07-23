import axios from 'axios';
import { format } from 'date-fns';
import { Loader2, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import { useAuth } from '../../contexts/AuthContext';
import { sanitizeMessageHtml } from '../../lib/sanitizeHtml';
import { RichTextEditor, RichTextEditorHandle } from './RichTextEditor';

interface ThreadReaction { emoji: string; count: number; users: { id: string; username: string }[]; }

interface ThreadMessage {
  id: string;
  parentId?: string | null;
  content?: string;
  fileUrl?: string;
  fileName?: string;
  sender: { id: string; username: string };
  createdAt: string;
  reactions: ThreadReaction[];
}

interface ThreadPanelProps {
  messageId: string;
  channelId: string;
  channelName: string;
  socket: Socket;
  onClose: () => void;
}

/**
 * Self-contained: fetches its own parent+replies (GET /api/messages/:id/thread)
 * rather than relying on ChatArea's main `messages` list — replies are no
 * longer eagerly loaded into that list at all (see messages.service.ts's
 * getChannelMessages parentId:null filter), on the theory that a channel with
 * heavy thread usage shouldn't pay to load every reply up front just because
 * someone might open one thread. Joins a thread-specific socket room for the
 * lifetime of the panel so replies arrive live without needing ChatArea's
 * channel-wide message state at all.
 */
export const ThreadPanel = ({ messageId, channelId, channelName, socket, onClose }: ThreadPanelProps) => {
  const { user } = useAuth();
  const [parent, setParent] = useState<ThreadMessage | null>(null);
  const [replies, setReplies] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const editorRef = useRef<RichTextEditorHandle>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    axios.get<{ parent: ThreadMessage; replies: ThreadMessage[] }>(`/api/messages/${messageId}/thread`)
      .then(({ data }) => {
        if (cancelled) return;
        setParent({ ...data.parent, reactions: data.parent.reactions ?? [] });
        setReplies(data.replies.map((r) => ({ ...r, reactions: r.reactions ?? [] })));
      })
      .catch((err) => console.error('Failed to load thread:', err))
      .finally(() => { if (!cancelled) setLoading(false); });

    socket.emit('thread:join', { messageId });

    const handleReply = (msg: ThreadMessage) => {
      if (msg.parentId !== messageId) return;
      setReplies((prev) => (prev.some((r) => r.id === msg.id) ? prev : [...prev, { ...msg, reactions: msg.reactions ?? [] }]));
    };
    // Shared with ChatArea's main list — a reaction on the thread's parent or
    // any of its replies broadcasts through this same event.
    const handleReactionUpdate = ({ messageId: reactedId, reactions }: { messageId: string; reactions: ThreadReaction[] }) => {
      setParent((prev) => (prev && prev.id === reactedId ? { ...prev, reactions } : prev));
      setReplies((prev) => prev.map((r) => (r.id === reactedId ? { ...r, reactions } : r)));
    };

    socket.on('thread:message_received', handleReply);
    socket.on('message:reaction:updated', handleReactionUpdate);

    return () => {
      cancelled = true;
      socket.emit('thread:leave', { messageId });
      socket.off('thread:message_received', handleReply);
      socket.off('message:reaction:updated', handleReactionUpdate);
    };
  }, [messageId, socket]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [replies]);

  const handleReact = async (targetId: string, emoji: string) => {
    try {
      await axios.post(`/api/messages/${targetId}/reactions`, { emoji });
    } catch (err) {
      console.error('Failed to toggle reaction:', err);
    }
  };

  const handleSend = () => {
    const text = editorRef.current?.getText() ?? '';
    const html = editorRef.current?.getHTML() ?? '';
    if (!text.trim()) return;

    socket.emit('message:send', { channelId, content: html, parentId: messageId });
    editorRef.current?.clear();
    setContent('');
  };

  const renderReactions = (m: ThreadMessage) =>
    m.reactions?.length > 0 && (
      <div className="flex gap-1.5 mt-2 flex-wrap">
        {m.reactions.map((r) => {
          const reactedByMe = r.users.some((u) => u.id === user?.id);
          return (
            <button
              key={r.emoji}
              onClick={() => handleReact(m.id, r.emoji)}
              title={r.users.map((u) => u.username).join(', ')}
              className={`px-2.5 py-1 rounded-lg text-xs border transition-all font-medium ${
                reactedByMe
                  ? 'bg-violet-50 border-violet-300 text-violet-700'
                  : 'bg-white border-gray-200 text-gray-600 hover:border-violet-300'
              }`}
            >
              {r.emoji} <span className="font-bold">{r.count}</span>
            </button>
          );
        })}
      </div>
    );

  const renderMessage = (m: ThreadMessage, isParent = false) => (
    <div key={m.id} className={`flex gap-3 px-5 py-3 ${isParent ? '' : 'hover:bg-gray-50/70'}`}>
      <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 text-white flex items-center justify-center font-bold uppercase shrink-0 text-sm">
        {m.sender?.username?.[0]}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="font-bold text-gray-900 text-sm">{m.sender?.username}</span>
          <span className="text-[11px] text-gray-400 font-medium">{format(new Date(m.createdAt), 'h:mm a')}</span>
        </div>
        {m.content && (
          <div className="text-[14px] text-gray-800 leading-relaxed" dangerouslySetInnerHTML={{ __html: sanitizeMessageHtml(m.content) }} />
        )}
        {m.fileUrl && (
          <a href={m.fileUrl} target="_blank" rel="noreferrer noopener" className="text-xs text-violet-600 underline">
            {m.fileName || 'Attachment'}
          </a>
        )}
        {renderReactions(m)}
      </div>
    </div>
  );

  return (
    <div className="w-[30%] min-w-[320px] max-w-[480px] flex flex-col h-full bg-white border-l border-gray-200 shadow-xl shrink-0 animate-in slide-in-from-right-8">
      <div className="h-[72px] px-5 border-b border-gray-100 flex items-center justify-between shrink-0">
        <div>
          <h3 className="font-bold text-lg text-gray-900">Thread</h3>
          <p className="text-xs text-gray-500">#{channelName}</p>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-xl transition text-gray-500">
          <X size={20} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="animate-spin text-violet-500" size={24} />
          </div>
        ) : (
          <>
            {parent && <div className="border-b border-gray-100 pb-2">{renderMessage(parent, true)}</div>}
            <div className="px-5 pt-4 pb-1 flex items-center gap-3">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                {replies.length} {replies.length === 1 ? 'Reply' : 'Replies'}
              </span>
              <div className="flex-1 h-px bg-gray-100" />
            </div>
            {replies.map((r) => renderMessage(r))}
            <div ref={endRef} />
          </>
        )}
      </div>

      <div className="p-4 border-t border-gray-100 shrink-0">
        <div className="border border-gray-300 rounded-xl overflow-hidden focus-within:border-violet-500 shadow-sm">
          <div className="w-full p-3">
            <RichTextEditor
              ref={editorRef}
              placeholder="Reply in thread..."
              compact
              onSubmit={handleSend}
              onChangeContent={(_html, text) => setContent(text)}
            />
          </div>
          <div className="flex justify-end px-3 py-2 bg-gray-50 border-t border-gray-100">
            <button
              onClick={handleSend}
              disabled={!content.trim()}
              className={`px-4 py-1.5 rounded-lg font-semibold text-sm transition flex items-center gap-1.5 ${
                content.trim() ? 'bg-violet-600 text-white hover:bg-violet-700' : 'bg-gray-200 text-gray-400'
              }`}
            >
              <Send size={14} /> Reply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
