import axios from 'axios';
import { format } from 'date-fns';
import { AlertCircle, Loader2, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import { useAuth } from '../../contexts/AuthContext';
import { createClientId, DeliveryState, isPending, mergeMessages, PENDING_PREFIX, upsertMessage } from '../../lib/messages';
import { sanitizeMessageHtml } from '../../lib/sanitizeHtml';
import { MessageAttachment } from './MessageAttachment';
import { RichTextEditor, RichTextEditorHandle } from './RichTextEditor';

interface ThreadReaction { emoji: string; count: number; users: { id: string; username: string }[]; }

interface ThreadMessage {
  id: string;
  parentId?: string | null;
  content?: string;
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  editedAt?: string | null;
  sender: { id: string; username: string };
  createdAt: string;
  reactions: ThreadReaction[];
  clientId?: string | null;
  deliveryState?: DeliveryState;
  deliveryError?: string;
}

interface ReplyPayload {
  channelId: string;
  content: string;
  parentId: string;
  clientId: string;
}

const SEND_TIMEOUT_MS = 10_000;

interface ThreadPanelProps {
  messageId: string;
  channelId: string;
  channelName: string;
  socket: Socket;
  onClose: () => void;
  // Batch 3/D: false in archived channels (the server refuses replies there too).
  canReply?: boolean;
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
export const ThreadPanel = ({ messageId, channelId, channelName, socket, onClose, canReply = true }: ThreadPanelProps) => {
  const { user } = useAuth();
  const [parent, setParent] = useState<ThreadMessage | null>(null);
  const [replies, setReplies] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const editorRef = useRef<RichTextEditorHandle>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(new Map<string, ReplyPayload>());
  // ChatArea passes a fresh inline onClose each render; reading it through a
  // ref keeps the subscription effect from re-running (and refetching) per render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    axios.get<{ parent: ThreadMessage; replies: ThreadMessage[] }>(`/api/messages/${messageId}/thread`)
      .then(({ data }) => {
        if (cancelled) return;
        setParent({ ...data.parent, reactions: data.parent.reactions ?? [] });
        // Merge so live replies that arrived during the request are kept.
        setReplies((prev) => mergeMessages(data.replies.map((r) => ({ ...r, reactions: r.reactions ?? [] })), prev));
      })
      .catch((err) => console.error('Failed to load thread:', err))
      .finally(() => { if (!cancelled) setLoading(false); });

    socket.emit('thread:join', { messageId });

    const handleReply = (msg: ThreadMessage) => {
      if (msg.parentId !== messageId) return;
      setReplies((prev) => upsertMessage(prev, { ...msg, reactions: msg.reactions ?? [] }));
    };
    const handleReplyUpdated = (msg: ThreadMessage) => {
      if (msg.parentId !== messageId) return;
      setReplies((prev) => prev.map((r) => (r.id === msg.id ? { ...r, ...msg, reactions: r.reactions } : r)));
    };
    const handleReplyDeleted = ({ parentId, id }: { parentId: string; id: string }) => {
      if (parentId === messageId) setReplies((prev) => prev.filter((r) => r.id !== id));
    };
    // The parent itself can be edited (channel-level event) or deleted.
    const handleParentUpdated = (msg: ThreadMessage) => {
      if (msg.id === messageId) setParent((prev) => (prev ? { ...prev, ...msg, reactions: prev.reactions } : prev));
    };
    const handleParentDeleted = (id: string) => {
      if (id === messageId) onCloseRef.current();
    };
    // Thread rooms aren't part of the server's automatic re-subscription, so
    // rejoin after a reconnect and pick up replies sent while offline.
    const handleResubscribe = () => {
      socket.emit('thread:join', { messageId });
      axios
        .get<{ parent: ThreadMessage; replies: ThreadMessage[] }>(`/api/messages/${messageId}/thread`)
        .then(({ data }) => {
          if (cancelled) return;
          setReplies((prev) => mergeMessages(prev, data.replies.map((r) => ({ ...r, reactions: r.reactions ?? [] }))));
        })
        .catch(() => undefined);
    };
    // Shared with ChatArea's main list — a reaction on the thread's parent or
    // any of its replies broadcasts through this same event.
    const handleReactionUpdate = ({ messageId: reactedId, reactions }: { messageId: string; reactions: ThreadReaction[] }) => {
      setParent((prev) => (prev && prev.id === reactedId ? { ...prev, reactions } : prev));
      setReplies((prev) => prev.map((r) => (r.id === reactedId ? { ...r, reactions } : r)));
    };

    socket.on('thread:message_received', handleReply);
    socket.on('thread:message_updated', handleReplyUpdated);
    socket.on('thread:message_deleted', handleReplyDeleted);
    socket.on('message:updated', handleParentUpdated);
    socket.on('message:deleted', handleParentDeleted);
    socket.on('message:reaction:updated', handleReactionUpdate);
    socket.on('subscriptions:ready', handleResubscribe);

    return () => {
      cancelled = true;
      socket.emit('thread:leave', { messageId });
      socket.off('thread:message_received', handleReply);
      socket.off('thread:message_updated', handleReplyUpdated);
      socket.off('thread:message_deleted', handleReplyDeleted);
      socket.off('message:updated', handleParentUpdated);
      socket.off('message:deleted', handleParentDeleted);
      socket.off('message:reaction:updated', handleReactionUpdate);
      socket.off('subscriptions:ready', handleResubscribe);
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

  const deliver = (payload: ReplyPayload) => {
    socket.timeout(SEND_TIMEOUT_MS).emit(
      'message:send',
      payload,
      (err: Error | null, res?: { ok: boolean; error?: string; message?: ThreadMessage }) => {
        if (!err && res?.ok && res.message) {
          pendingRef.current.delete(payload.clientId);
          setReplies((prev) => upsertMessage(prev, { ...res.message!, reactions: res.message!.reactions ?? [] }));
          return;
        }
        const reason = err ? 'Not delivered yet — check your connection.' : res?.error ?? 'Failed to send.';
        setReplies((prev) =>
          prev.map((r) => (isPending(r) && r.clientId === payload.clientId ? { ...r, deliveryState: 'failed', deliveryError: reason } : r))
        );
      }
    );
  };

  const retry = (clientId: string) => {
    const payload = pendingRef.current.get(clientId);
    if (!payload) return;
    setReplies((prev) => prev.map((r) => (isPending(r) && r.clientId === clientId ? { ...r, deliveryState: 'pending', deliveryError: undefined } : r)));
    deliver(payload);
  };

  const handleSend = () => {
    const text = editorRef.current?.getText() ?? '';
    const html = editorRef.current?.getHTML() ?? '';
    if (!text.trim() || !user) return;

    const clientId = createClientId();
    const payload: ReplyPayload = { channelId, content: html, parentId: messageId, clientId };
    pendingRef.current.set(clientId, payload);
    setReplies((prev) =>
      mergeMessages(prev, [
        {
          id: `${PENDING_PREFIX}${clientId}`,
          clientId,
          parentId: messageId,
          content: html,
          sender: { id: user.id, username: user.username },
          createdAt: new Date().toISOString(),
          reactions: [],
          deliveryState: 'pending',
        },
      ])
    );
    deliver(payload);
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
      <div className="w-9 h-9 rounded-lg bg-accent-600 text-white flex items-center justify-center font-bold uppercase shrink-0 text-sm">
        {m.sender?.username?.[0]}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="font-bold text-gray-900 text-sm">{m.sender?.username}</span>
          <span className="text-[11px] text-gray-400 font-medium">{format(new Date(m.createdAt), 'h:mm a')}</span>
        </div>
        {m.content && (
          <div className="rich-text text-[14px] text-fg leading-relaxed break-words" dangerouslySetInnerHTML={{ __html: sanitizeMessageHtml(m.content) }} />
        )}
        {m.editedAt && <span className="text-[11px] text-fg-subtle">(edited)</span>}
        {m.fileUrl ? <MessageAttachment fileUrl={m.fileUrl} fileName={m.fileName} fileType={m.fileType} compact /> : null}
        {renderReactions(m)}
        {m.deliveryState === 'pending' && <div className="mt-1 text-[11px] text-gray-400" role="status">Sending…</div>}
        {m.deliveryState === 'failed' && m.clientId && (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] font-semibold text-red-600" role="alert">
            <AlertCircle size={12} aria-hidden="true" /> {m.deliveryError ?? 'Failed to send.'}
            <button type="button" onClick={() => retry(m.clientId!)} className="underline">Retry</button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    // P3: beside the conversation when there's room; over it when narrow (phones, tablets).
    <div className="absolute inset-0 z-30 w-full @3xl/chat:static @3xl/chat:z-auto @3xl/chat:w-[30%] @3xl/chat:min-w-[320px] @3xl/chat:max-w-[480px] flex flex-col h-full bg-white border-l border-gray-200 shadow-xl shrink-0 animate-in slide-in-from-right-8">
      <div className="h-[72px] px-5 border-b border-gray-100 flex items-center justify-between shrink-0">
        <div>
          <h3 className="font-bold text-lg text-gray-900">Thread</h3>
          <p className="text-xs text-gray-500">#{channelName}</p>
        </div>
        <button onClick={onClose} aria-label="Close thread" className="p-2 hover:bg-gray-100 rounded-xl transition text-gray-500">
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

      {!canReply ? (
        <p role="status" className="p-4 border-t border-gray-100 shrink-0 text-sm text-gray-500">
          This channel is archived — replies are closed.
        </p>
      ) : (
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
      )}
    </div>
  );
};
