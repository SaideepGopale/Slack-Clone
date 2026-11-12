import axios from 'axios';
import { format } from 'date-fns';
import {
  AlertCircle,
  ArrowDown,
  Copy,
  BarChart2, // 👇 NAYA: Polls ke liye icon
  FileText,
  MessageSquare,
  Mic,
  Pencil,
  Phone,
  Pin,
  Plus,
  Reply, Send, Smile,
  SmilePlus,
  CheckCheck,
  Info,
  LogOut,
  Trash2,
  UserPlus,
  Users,
  Video, X,
  Lock,
  Megaphone,
  MoreHorizontal,
  Settings,
  Archive,
  Hash
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { MessageFocusTarget, onMessageFocus, requestMessageFocus, takePendingFocus } from '../../lib/messageFocus';
import { Socket } from 'socket.io-client';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../pages/workspace/WorkspaceContext';
import { seenBy, seenLabel, upsertReceipt } from '../../lib/receipts';
import { isLaterPosition } from '../../lib/unread';
import { ConversationDetailsModal } from '../conversations/ConversationDetailsModal';
import { createClientId, DeliveryState, extractUrls, htmlToText, isPending, mergeMessages, PENDING_PREFIX, truncate, upsertMessage, reconcileLatestWindow } from '../../lib/messages';
import { sanitizeMessageHtml } from '../../lib/sanitizeHtml';
import { clearDraft, layoutMessages, loadDraft, saveDraft } from '../../lib/chatPresentation';
import { MessageAttachment } from './MessageAttachment';
import { UploadedVoiceNote, VoiceRecorderBar } from './voice/VoiceRecorderBar';
import { AttachmentTray } from './upload/AttachmentTray';
import { useUploadQueue } from './upload/useUploadQueue';
import { Avatar } from '../ui/Avatar';
import { BottomSheet, Menu, MenuItem, SheetAction, useConfirm } from '../ui';
import { Camera, ChevronLeft, ImagePlus, Paperclip, PinOff, Type } from 'lucide-react';
import { COARSE_POINTER_QUERY, PHONE_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { useLongPress } from '../../hooks/useLongPress';
import { EmojiPicker } from '../ui/EmojiPicker';
import { fetchMentionCandidates } from '../../lib/mentionCandidates';
import { createTypingTracker } from '../../lib/typingTracker';
import { Channel, ChannelDetails, Message, Receipt, User } from '../../types';
import { COMPOSER_NOTICES, channelTypeLabel, composerState } from '../../lib/channels';
import { AddMemberModal } from './AddMemberModal';
import { ChannelSettingsModal } from './ChannelSettingsModal';
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
interface ChatMessage extends Message {
  reactions: Reaction[];
  isPinned?: boolean;
  pollData?: PollData;
  _count?: { replies: number };
  // Client-only: optimistic messages awaiting (or having failed) the server ack.
  deliveryState?: DeliveryState;
  deliveryError?: string;
  // P3 (FA-RT-08): the send timed out (no answer), so it's re-sent
  // automatically after reconnecting. Server rejections are not.
  retryOnReconnect?: boolean;
}

interface SendPayload {
  channelId: string;
  content: string;
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  pollData?: { question: string; options: { id: string; text: string; votes: string[] }[] };
  parentId: null;
  clientId: string;
}

interface SocketAck {
  ok: boolean;
  error?: string;
  message?: ChatMessage;
}

const SEND_TIMEOUT_MS = 10_000;
// P3: the conversation header's buttons (icon-only when the column is narrow).
// No `display` here: callers add `inline-flex`, or `hidden @xl:inline-flex`
// for the buttons that move into the overflow menu when the column is narrow.
const HEADER_BUTTON =
  'items-center justify-center gap-2 h-9 min-w-9 @lg:h-10 @lg:min-w-10 px-2 @3xl:px-3 rounded-lg bg-gray-100 text-gray-700 text-sm font-semibold hover:bg-gray-200 hover:text-gray-900 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
// P3: composer tool buttons (attach, emoji, voice).
const COMPOSER_BUTTON =
  'p-1.5 rounded-md text-fg-subtle hover:text-fg hover:bg-surface-tertiary transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus';
// P3: one style for every message action (hover toolbar).
const ACTION_BUTTON =
  'p-1.5 rounded-md text-fg-muted hover:text-fg hover:bg-surface-tertiary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus';
const TYPING_THROTTLE_MS = 2_000;

const withReactions = (m: ChatMessage): ChatMessage => ({ ...m, reactions: m.reactions ?? [] });

interface FileData { url: string; name: string; type: string; }

interface MessagePageResponse { messages: ChatMessage[]; nextCursor: string | null; hasMore: boolean; }

interface ChatAreaProps {
  channel: Channel;
  socket: Socket;
  onlineUsers?: User[];
  onStartCall: (type: 'audio' | 'video') => void;
}

const isGeneral = (channel: Channel) => !channel.isDM && channel.name?.toLowerCase() === 'general';

// Visibility of the browser tab — messages only count as "read" while visible.
const useDocumentVisible = () => {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
};

export const ChatArea = ({ channel, socket, onlineUsers = [], onStartCall }: ChatAreaProps) => {
  const { user } = useAuth();
  const { workspaceId, readState, markChannelRead, removeConversation } = useWorkspace();
  const navigate = useNavigate();
  const pageVisible = useDocumentVisible();
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  // Read position captured when the conversation was opened (before this
  // view marks it read) — drives the "New messages" divider.
  const [openedAtPosition, setOpenedAtPosition] = useState<{ lastReadAt: string; lastReadMessageId: string | null } | null>(null);
  const positionCapturedRef = useRef(false);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [receiptsEnabled, setReceiptsEnabled] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Plain-text mirrors of each editor's live HTML — used only for UI logic
  // that can't operate on markup (slash-command hint, empty-state checks,
  // poll-syntax parsing at send time). The HTML itself is read on demand
  // from the editor refs below, not tracked in state.
  // P2: this conversation's unsent draft (ChannelPage keys ChatArea by
  // conversation id, so this initializer runs once per conversation).
  const [initialDraft] = useState(() => loadDraft(user?.id, channel.id));
  const [content, setContent] = useState(initialDraft?.text ?? '');
  const [dragActive, setDragActive] = useState(false);
  // P2: @mention autocomplete (regular channels; members come from the server).
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionOptions, setMentionOptions] = useState<{ id: string; username: string }[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [activeThread, setActiveThread] = useState<ChatMessage | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [reactingToId, setReactingToId] = useState<string | null>(null);
  // T.39: touch layouts — press-and-hold a message for its actions, the "+" sheet, and the formatting toggle.
  const isPhone = useMediaQuery(PHONE_QUERY);
  const isTouch = useMediaQuery(COARSE_POINTER_QUERY);
  const [actionSheet, setActionSheet] = useState<{ message: ChatMessage; isThreadView: boolean } | null>(null);
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  const [formattingOpen, setFormattingOpen] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const messageLongPress = useLongPress<{ message: ChatMessage; isThreadView: boolean }>((target) => setActionSheet(target));
  
  // T.33: several attachments per send (picker, paste, drag-and-drop), each
  // with its own progress, cancel and retry (components/chat/upload).
  const uploads = useUploadQueue({ onRejected: (message) => setError(message) });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddMemberModal, setShowAddMemberModal] = useState(false);
  // Batch 3/D: server-computed channel details + the caller's capabilities.
  const [channelDetails, setChannelDetails] = useState<ChannelDetails | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  // P3: typing names expire on their own (see lib/typingTracker).
  const typingTrackerRef = useRef<ReturnType<typeof createTypingTracker> | null>(null);
  if (!typingTrackerRef.current) typingTrackerRef.current = createTypingTracker(setTypingUsers);
  useEffect(() => () => typingTrackerRef.current?.clear(), []);
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

  // T.33: the voice-note recorder (components/chat/voice) is open in the composer.
  const [voiceOpen, setVoiceOpen] = useState(false);

  useEffect(() => {
    setTypingUsers([]);
    setActiveThread(null);
    setReactingToId(null);
  }, [channel?.id]);

  const channelId = channel?.id;
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const loadedRef = useRef(false);
  const pendingPayloadsRef = useRef(new Map<string, SendPayload>());
  const lastTypingSentRef = useRef(0);

  // Keyed on the channel id (not the channel object): DM list updates replace
  // the object on every new message, which must not trigger a full reload.
  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    loadedRef.current = false;
    positionCapturedRef.current = false;
    setMessagesLoaded(false);
    setOpenedAtPosition(null);
    setMessages([]);
    setError(null);

    // Reset pagination state for the new channel — each channel has its own
    // independent history/cursor.
    setFirstItemIndex(FIRST_ITEM_INDEX_START);
    setHasMoreHistory(true);
    nextCursorRef.current = null;

    const belongsHere = (m: { channelId?: string }) => m.channelId === channelId;

    // Idempotent: the server already subscribes every authorized channel on
    // connect; this covers a channel the user gained access to meanwhile.
    socket.emit('channel:join', channelId);

    // `replace` drops previously loaded confirmed messages (used when the gap
    // after a reconnect is too large to backfill); live and pending messages
    // received while the request was in flight are always kept.
    const fetchLatest = async (replace: boolean) => {
      const res = await axios.get<MessagePageResponse>(`/api/channels/${channelId}/messages`);
      if (cancelled) return;
      const fetched = res.data.messages.map(withReactions);
      setMessages(prev => mergeMessages(fetched, prev.filter(m => belongsHere(m) && (!replace || isPending(m)))));
      nextCursorRef.current = res.data.nextCursor;
      setHasMoreHistory(res.data.hasMore);
      if (replace) setFirstItemIndex(FIRST_ITEM_INDEX_START);
      loadedRef.current = true;
      setMessagesLoaded(true);
    };

    fetchLatest(false).catch(err => {
      if (cancelled) return;
      console.error('fetchMessages error:', err);
      setError('Failed to load messages');
    });

    // Runs after every reconnect once the server has restored subscriptions:
    // fetch whatever arrived while this client was offline.
    // T.32 (audit RT-5): the latest page is re-read and reconciled, so edits,
    // deletions, reactions and pins made while this client was offline show
    // up too — not only messages that are new.
    const backfill = async () => {
      if (!loadedRef.current) return;
      const confirmed = messagesRef.current.filter(m => !isPending(m) && belongsHere(m));
      const last = confirmed[confirmed.length - 1];
      try {
        if (!last) return await fetchLatest(true);
        const res = await axios.get<MessagePageResponse>(`/api/channels/${channelId}/messages`);
        if (cancelled) return;
        const page = res.data.messages.map(withReactions);
        // The page does not reach back to what we already had: the gap is
        // bigger than one page, so start from the latest page instead.
        const reachesBack = page.some(m => m.id === last.id) || page.some(m => new Date(m.createdAt) <= new Date(last.createdAt));
        if (res.data.hasMore && !reachesBack) return await fetchLatest(true);
        setMessages(prev => reconcileLatestWindow(prev.filter(belongsHere), page));
      } catch (err) {
        // e.g. the anchor message was deleted while we were offline
        console.warn('Backfill failed, reloading latest messages:', err);
        fetchLatest(true).catch(() => setError('Failed to load messages'));
      }
    };

    const handleMessage = (message: ChatMessage) => {
      // Every channel room is subscribed now, so events for other channels
      // arrive here too. Replies only render inside their ThreadPanel.
      if (!belongsHere(message)) return;
      // Their message is here, so they've stopped typing.
      if (message.sender?.username) typingTrackerRef.current?.stop(message.sender.username);
      if (message.parentId) return;
      setMessages(prev => upsertMessage(prev, withReactions(message)));
    };
    const handleUpdate = (updated: ChatMessage) => {
      if (!belongsHere(updated)) return;
      setMessages(prev =>
        prev.map(m =>
          m.id === updated.id
            ? { ...m, ...updated, reactions: updated.reactions ?? m.reactions, _count: updated._count ?? m._count }
            : m
        )
      );
    };
    const handleDelete = (id: string) => setMessages(prev => prev.filter(m => m.id !== id));

    const handleReactionUpdate = ({ messageId, reactions }: { messageId: string; reactions: Reaction[] }) => {
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, reactions } : m));
    };

    // A reply was sent somewhere in this channel — bump the parent's visible
    // "N replies" count even if this viewer doesn't have that thread open.
    const handleReplyCountUpdated = ({ parentId, replyCount }: { parentId: string; replyCount: number }) => {
      setMessages(prev => prev.map(m => m.id === parentId ? { ...m, _count: { replies: replyCount } } : m));
    };

    const handleTypingStarted = ({ channelId: typingChannel, userId, username }: { channelId: string; userId?: string; username: string }) => {
      if (typingChannel !== channelId || userId === user?.id) return;
      typingTrackerRef.current?.start(username);
    };
    const handleTypingStopped = ({ channelId: typingChannel, username }: { channelId: string; username: string }) => {
      if (typingChannel === channelId) typingTrackerRef.current?.stop(username);
    };
    const handleUnauthorized = (payload: { channelId?: string; message?: string }) => {
      if (payload?.channelId === channelId) setError(payload.message ?? 'You no longer have access to this conversation.');
    };

    socket.on('message:received', handleMessage);
    socket.on('message:updated', handleUpdate);
    socket.on('message:deleted', handleDelete);
    socket.on('message:reaction:updated', handleReactionUpdate);
    socket.on('thread:reply_count_updated', handleReplyCountUpdated);
    socket.on('typing:started', handleTypingStarted);
    socket.on('typing:stopped', handleTypingStopped);
    socket.on('error:unauthorized', handleUnauthorized);
    socket.on('subscriptions:ready', backfill);

    return () => {
      cancelled = true;
      socket.off('message:received', handleMessage);
      socket.off('message:updated', handleUpdate);
      socket.off('message:deleted', handleDelete);
      socket.off('message:reaction:updated', handleReactionUpdate);
      socket.off('thread:reply_count_updated', handleReplyCountUpdated);
      socket.off('typing:started', handleTypingStarted);
      socket.off('typing:stopped', handleTypingStopped);
      socket.off('error:unauthorized', handleUnauthorized);
      socket.off('subscriptions:ready', backfill);
    };
  }, [channelId, socket, user?.id]);

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
      const known = new Set(messagesRef.current.map(m => m.id));
      const older = page.messages.map(withReactions).filter(m => !known.has(m.id));

      if (older.length > 0) {
        setFirstItemIndex(prev => prev - older.length);
        setMessages(prev => mergeMessages(older, prev));
      }
      nextCursorRef.current = page.nextCursor;
      setHasMoreHistory(page.hasMore);
    } catch (err) {
      console.error('loadMoreMessages error:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [channel, hasMoreHistory, loadingMore]);

  // Emits one send attempt. Success replaces the optimistic row with the
  // stored message; failure (server rejection or no ack in time) marks it
  // failed so the user can retry. Retries reuse the same clientId, and the
  // server deduplicates on it, so a send that actually succeeded late can
  // never produce a second copy.
  const deliver = (payload: SendPayload) => {
    socket.timeout(SEND_TIMEOUT_MS).emit('message:send', payload, (err: Error | null, res?: SocketAck) => {
      if (!err && res?.ok && res.message) {
        pendingPayloadsRef.current.delete(payload.clientId);
        setMessages(prev => upsertMessage(prev, withReactions(res.message!)));
        return;
      }
      const reason = err ? 'Not delivered yet — check your connection.' : res?.error ?? 'Failed to send.';
      setMessages(prev =>
        prev.map(m =>
          isPending(m) && m.clientId === payload.clientId
            ? { ...m, deliveryState: 'failed', deliveryError: reason, retryOnReconnect: !!err }
            : m
        )
      );
    });
  };

  const sendMessage = (fields: Omit<SendPayload, 'channelId' | 'parentId' | 'clientId'>) => {
    if (!user) return;
    const clientId = createClientId();
    const payload: SendPayload = { ...fields, channelId: channel.id, parentId: null, clientId };
    pendingPayloadsRef.current.set(clientId, payload);
    const optimistic: ChatMessage = {
      id: `${PENDING_PREFIX}${clientId}`,
      clientId,
      channelId: channel.id,
      senderId: user.id,
      sender: { id: user.id, username: user.username },
      content: fields.content,
      fileUrl: fields.fileUrl,
      fileName: fields.fileName,
      fileType: fields.fileType,
      pollData: fields.pollData,
      createdAt: new Date().toISOString(),
      reactions: [],
      deliveryState: 'pending',
    };
    setMessages(prev => mergeMessages(prev, [optimistic]));
    deliver(payload);
  };

  const retrySend = (clientId: string) => {
    const payload = pendingPayloadsRef.current.get(clientId);
    if (!payload) return;
    setMessages(prev =>
      prev.map(m => (isPending(m) && m.clientId === clientId ? { ...m, deliveryState: 'pending', deliveryError: undefined } : m))
    );
    deliver(payload);
  };

  // P3 (FA-RT-08): once the connection is back, re-send what timed out while
  // offline. Safe to repeat: retries reuse the clientId and the server
  // deduplicates on it.
  const retrySendRef = useRef(retrySend);
  retrySendRef.current = retrySend;
  useEffect(() => {
    const onReady = () => {
      for (const m of messagesRef.current) {
        if (m.deliveryState === 'failed' && m.retryOnReconnect && m.clientId) retrySendRef.current(m.clientId);
      }
    };
    socket.on('subscriptions:ready', onReady);
    return () => {
      socket.off('subscriptions:ready', onReady);
    };
  }, [socket]);

  const discardFailed = (clientId: string) => {
    pendingPayloadsRef.current.delete(clientId);
    setMessages(prev => prev.filter(m => !(isPending(m) && m.clientId === clientId)));
  };

  // Main composer only — thread replies are sent by ThreadPanel itself.
  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    lastTypingSentRef.current = 0;
    socket.emit('typing:stop', { channelId: channel.id });

    const html = mainEditorRef.current?.getHTML() ?? '';
    const text = mainEditorRef.current?.getText() ?? '';

    const files = uploads.ready;
    if (!text.trim() && files.length === 0) return;
    if (uploads.busy) {
      setError('Wait for your files to finish uploading, or remove them.');
      return;
    }

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

    // T.33: the text goes with the first file; each further file is its own
    // message (one attachment per message), in the order they were added.
    const [first, ...rest] = pollData ? [undefined, ...files] : files;
    if (text.trim() || first) {
      sendMessage({
        content: finalContent,
        fileUrl: first?.url,
        fileName: first?.name,
        fileType: first?.type,
        pollData, // Payload mein poll pass kar diya
      });
    }
    for (const file of rest) {
      if (file) sendMessage({ content: '', fileUrl: file.url, fileName: file.name, fileType: file.type });
    }

    mainEditorRef.current?.clear();
    clearDraft(user?.id, channel.id);
    setContent('');
    uploads.clear();
    // Without this, selecting the exact same file again right after sending
    // silently does nothing — the input's value never changed, so the
    // browser never fires onChange a second time.
    if (fileInputRef.current) fileInputRef.current.value = '';
    setShowEmojiPicker(false);
    setSending(false);
    // Your own message should always come into view, even when you were
    // reading further up.
    requestAnimationFrame(() => virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' }));
  };

  const handleVote = (messageId: string, optionId: string) => {
    socket.timeout(SEND_TIMEOUT_MS).emit('poll:vote', { messageId, optionId }, (err: Error | null, res?: SocketAck) => {
      if (err || !res?.ok) setError(res?.error ?? 'Your vote was not recorded. Please try again.');
    });
  };

  // T.33: a recorded, uploaded voice note becomes a message through the
  // normal send path (optimistic, retried, idempotent on clientId).
  const sendVoiceMessage = (note: UploadedVoiceNote) => {
    sendMessage({ content: '🎙️ Voice Note', fileUrl: note.url, fileName: note.name || 'voice-message.webm', fileType: note.type || 'audio/webm' });
  };

  // T.32 (audit FE-12): leaving the conversation mid-recording releases the
  // microphone and discards the unfinished note (never sent to the wrong
  // conversation) — T.33: closing the recorder unmounts it, which does that —
  // and a pending "stopped typing" timer is cancelled too.
  useEffect(() => () => {
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    setVoiceOpen(false);
  }, [channel.id]);

  // Edit and pin update optimistically and roll back if the server rejects.
  const handleEdit = () => {
    if (!editingId) return;
    const id = editingId;
    const html = editEditorRef.current?.getHTML() ?? '';
    const before = messagesRef.current.find(m => m.id === id);
    const previous = before?.content;
    const previousEditedAt = before?.editedAt ?? null;
    setMessages(prev => prev.map(m => m.id === id ? { ...m, content: html, editedAt: new Date().toISOString() } : m));
    setEditingId(null);
    socket.timeout(SEND_TIMEOUT_MS).emit('message:edit', { id, content: html }, (err: Error | null, res?: SocketAck) => {
      if (!err && res?.ok) return;
      setMessages(prev => prev.map(m => m.id === id ? { ...m, content: previous, editedAt: previousEditedAt } : m));
      setError(res?.error ?? 'Your edit was not saved. Please try again.');
    });
  };

  const handleDelete = (id: string) => {
    socket.timeout(SEND_TIMEOUT_MS).emit('message:delete', { id }, (err: Error | null, res?: SocketAck) => {
      if (!err && res?.ok) {
        if (activeThread?.id === id) setActiveThread(null);
        return;
      }
      setError(res?.error ?? 'The message could not be deleted. Please try again.');
    });
  };

  const requestDelete = async (id: string) => {
    const ok = await confirm({
      title: 'Delete message?',
      message: 'This removes the message for everyone in the conversation. It can\'t be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (ok) handleDelete(id);
  };

  const copyMessageText = async (m: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(htmlToText(m.content ?? ''));
      toast.success('Message copied');
    } catch {
      toast.error('Could not copy — your browser blocked clipboard access.');
    }
  };

  const handlePin = (id: string, currentStatus: boolean) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, isPinned: !currentStatus } : m));
    socket.timeout(SEND_TIMEOUT_MS).emit('message:pin', { id, isPinned: !currentStatus }, (err: Error | null, res?: SocketAck) => {
      if (!err && res?.ok) return;
      setMessages(prev => prev.map(m => m.id === id ? { ...m, isPinned: currentStatus } : m));
      setError(res?.error ?? 'Could not update the pin. Please try again.');
    });
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
      // T.32 (audit FE-4): a refused reaction is explained, not swallowed.
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Your reaction could not be saved. Please try again.');
    }
  };

  // T.33: picker, paste and drop all feed the upload queue.
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) uploads.add(files);
    // Lets the same file be picked again later.
    e.target.value = '';
  };

  // `channel` is a required prop (ChannelPage only renders ChatArea with a
  // resolved conversation), so no early return here: every hook below must run
  // unconditionally on every render (Rules of Hooks).

  // Guaranteed top-level already (see getChannelMessages' parentId:null
  // filter + handleMessage's own filter above), kept as a plain alias rather
  // than re-filtering for it.
  const mainMessages = messages;
  const pinnedMessages = mainMessages.filter(m => m.isPinned);
  // P2: day separators and author grouping for the message list.
  const layout = useMemo(() => layoutMessages(mainMessages), [mainMessages]);

  // P3: channels suggest matching members; DMs and group DMs suggest their
  // participants (lib/mentionCandidates).
  useEffect(() => {
    if (mentionQuery === null) {
      setMentionOptions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchMentionCandidates(channel, mentionQuery, user?.id)
        .then((people) => {
          if (cancelled) return;
          setMentionOptions(people);
          setMentionIndex(0);
        })
        .catch(() => !cancelled && setMentionOptions([]));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mentionQuery, channel.id, channel.isDM, user?.id]);

  const mentionOpen = mentionQuery !== null && mentionOptions.length > 0;
  const chooseMention = (username: string) => {
    mainEditorRef.current?.completeMention(username);
    setMentionQuery(null);
  };
  const handleMentionKey = (key: string) => {
    if (!mentionOpen) return false;
    if (key === 'ArrowDown') setMentionIndex((i) => (i + 1) % mentionOptions.length);
    else if (key === 'ArrowUp') setMentionIndex((i) => (i - 1 + mentionOptions.length) % mentionOptions.length);
    else if (key === 'Enter' || key === 'Tab') chooseMention(mentionOptions[mentionIndex]?.username ?? mentionOptions[0].username);
    else if (key === 'Escape') setMentionQuery(null);
    return true;
  };

  // P2 Phase G: the conversation's pins come from the server, so pins older
  // than the loaded history still show. Refreshed when a pin changes.
  const [pinned, setPinned] = useState<ChatMessage[]>([]);
  const refreshPinned = useCallback(() => {
    axios
      .get<ChatMessage[]>(`/api/channels/${channel.id}/pinned`)
      .then((res) => setPinned(Array.isArray(res.data) ? res.data : []))
      .catch(() => undefined);
  }, [channel.id]);
  const loadedPinSignature = pinnedMessages.map((m) => m.id).join(',');
  useEffect(() => {
    refreshPinned();
  }, [refreshPinned, loadedPinSignature]);
  useEffect(() => {
    const onUpdated = (m: { id?: string; channelId?: string; isPinned?: boolean }) => {
      if (m?.channelId === channel.id && typeof m.isPinned === 'boolean') refreshPinned();
    };
    const onDeleted = (id: string) => setPinned((prev) => prev.filter((p) => p.id !== id));
    socket.on('message:updated', onUpdated);
    socket.on('message:deleted', onDeleted);
    return () => {
      socket.off('message:updated', onUpdated);
      socket.off('message:deleted', onDeleted);
    };
  }, [socket, channel.id, refreshPinned]);

  // F1: the header's in-channel search asks us to show a message. Loaded
  // top-level messages are scrolled into view and briefly highlighted; a
  // thread reply opens its parent's thread; anything older than the loaded
  // window gets an honest hint instead of a silent no-op.
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const focusMessage = useCallback(
    (target: MessageFocusTarget) => {
        if (target.parentId) {
          const parent = mainMessages.find((m) => m.id === target.parentId);
          if (parent) setActiveThread(parent);
          else toast.info('That reply is in an older thread — scroll up to load earlier messages, then open it.');
          return;
        }
        const index = mainMessages.findIndex((m) => m.id === target.messageId);
        if (index === -1) {
          toast.info('That message is further back — scroll up to load earlier messages.');
          return;
        }
        virtuosoRef.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' });
        setHighlightedId(target.messageId);
    },
    [mainMessages]
  );
  useEffect(
    () =>
      onMessageFocus((target) => {
        if (target.channelId !== channel.id) return;
        takePendingFocus(channel.id); // handled here; don't replay it on load
        focusMessage(target);
      }),
    [channel.id, focusMessage]
  );
  // P2 Phase I: arriving from search/Activity — show the message once loaded.
  useEffect(() => {
    if (!messagesLoaded) return;
    const target = takePendingFocus(channel.id);
    if (target) requestAnimationFrame(() => focusMessage(target));
  }, [messagesLoaded, channel.id, focusMessage]);
  useEffect(() => {
    if (!highlightedId) return;
    const timer = setTimeout(() => setHighlightedId(null), 2500);
    return () => clearTimeout(timer);
  }, [highlightedId]);
  const dmPartnerOnline = !!channel.otherUserId && onlineUsers.some(u => u.id === channel.otherUserId);

  const channelReadState = readState[channel.id];

  // Capture the read position once per opened conversation, as soon as the
  // persisted state is known (it may arrive after the view mounts).
  useEffect(() => {
    if (positionCapturedRef.current || !channelReadState) return;
    positionCapturedRef.current = true;
    setOpenedAtPosition({ lastReadAt: channelReadState.lastReadAt, lastReadMessageId: channelReadState.lastReadMessageId });
  }, [channelReadState]);

  const confirmed = useMemo(() => messages.filter(m => !m.deliveryState && !m.id.startsWith('pending:')), [messages]);
  const latestConfirmed = confirmed[confirmed.length - 1];

  // First message from someone else after the position the user had when
  // they opened the conversation.
  const firstUnreadId = useMemo(() => {
    if (!openedAtPosition) return null;
    return (
      confirmed.find(m => m.senderId !== user?.id && isLaterPosition({ lastReadAt: m.createdAt, lastReadMessageId: m.id }, openedAtPosition))?.id ?? null
    );
  }, [confirmed, openedAtPosition, user?.id]);

  // Persist the read position while the conversation is actually on screen:
  // after the initial load, on new messages, and when the tab becomes
  // visible again. Debounced, and skipped when the server already has it.
  useEffect(() => {
    if (!messagesLoaded || !pageVisible || !latestConfirmed) return;
    if (!positionCapturedRef.current && Object.keys(readState).length === 0) return; // read state not loaded yet
    if (
      channelReadState &&
      !isLaterPosition({ lastReadAt: latestConfirmed.createdAt, lastReadMessageId: latestConfirmed.id }, channelReadState)
    ) {
      return;
    }
    const timer = setTimeout(() => markChannelRead(channel.id, latestConfirmed.id), 600);
    return () => clearTimeout(timer);
  }, [messagesLoaded, pageVisible, latestConfirmed, channelReadState, readState, markChannelRead, channel.id]);

  // Read receipts — direct conversations only; the server applies the
  // privacy rules (opt-outs, reciprocity, history windows).
  useEffect(() => {
    setReceipts([]);
    setReceiptsEnabled(false);
    if (!channel.isDM) return;
    let cancelled = false;
    axios
      .get<{ enabled: boolean; receipts: Receipt[] }>(`/api/channels/${channel.id}/read-receipts`)
      .then(res => {
        if (cancelled) return;
        setReceiptsEnabled(res.data.enabled);
        setReceipts(res.data.receipts);
      })
      .catch(() => undefined);
    const onReceipt = (receipt: Receipt & { channelId: string }) => {
      if (receipt.channelId !== channel.id) return;
      setReceipts(prev => upsertReceipt(prev, receipt));
    };
    socket.on('receipt:updated', onReceipt);
    return () => {
      cancelled = true;
      socket.off('receipt:updated', onReceipt);
    };
  }, [channel.id, channel.isDM, socket]);

  const myLatest = useMemo(() => [...confirmed].reverse().find(m => m.senderId === user?.id), [confirmed, user?.id]);
  const receiptLabel = receiptsEnabled ? seenLabel(seenBy(receipts, myLatest), !!channel.isGroupDM) : null;

  // Batch 3/D: channel type, archive state and capabilities come from the
  // server; refreshed whenever this channel or its member list changes.
  const refreshDetails = useCallback(() => {
    if (channel.isDM) return;
    axios
      .get<ChannelDetails>(`/api/channels/${channel.id}/details`)
      .then((res) => setChannelDetails(res.data))
      .catch(() => setChannelDetails(null));
  }, [channel.id, channel.isDM]);

  useEffect(() => {
    setChannelDetails(null);
    refreshDetails();
    if (channel.isDM) return;
    const onUpdated = (payload: { channel?: { id: string } }) => {
      if (payload.channel?.id === channel.id) refreshDetails();
    };
    const onMembersChanged = (payload: { channelId?: string }) => {
      if (payload.channelId === channel.id) refreshDetails();
    };
    socket.on('channel:updated', onUpdated);
    socket.on('channel:members_changed', onMembersChanged);
    return () => {
      socket.off('channel:updated', onUpdated);
      socket.off('channel:members_changed', onMembersChanged);
    };
  }, [channel.id, channel.isDM, refreshDetails, socket]);

  const composer = composerState(channel.isDM ? null : channelDetails);
  const caps = channelDetails?.capabilities;
  // T.32 (audit FE-4): archived conversations are read-only on the server —
  // the UI no longer offers writes that would only fail.
  const readOnly = !channel.isDM && !!channelDetails?.archived;
  const canReactHere = channel.isDM || caps?.canReact !== false;
  const canReplyHere = channel.isDM || caps?.canReply !== false;

  const leaveChannel = async () => {
    const ok = await confirm({
      title: `Leave #${channel.name}?`,
      message: 'You can rejoin from the channel directory.',
      confirmLabel: 'Leave',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await axios.post(`/api/channels/${channel.id}/leave`);
      removeConversation(channel.id);
      navigate(`/${workspaceId}`);
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not leave the channel.');
    }
  };

  // P3: header actions — buttons when there's room, one menu when narrow.
  const canLeaveHere = !channel.isDM && !isGeneral(channel) && (caps?.canLeave ?? true);
  const canAddHere = !channel.isDM && !!caps?.canAddMembers;
  const headerMenuItems: MenuItem[] = [
    ...(canAddHere ? [{ id: 'add', label: 'Add people', icon: <UserPlus size={16} aria-hidden="true" />, onSelect: () => setShowAddMemberModal(true) }] : []),
    ...(canLeaveHere ? [{ id: 'leave', label: 'Leave channel', icon: <LogOut size={16} aria-hidden="true" />, onSelect: () => void leaveChannel(), danger: true }] : []),
  ];

  const renderMessageUI = (m: ChatMessage, isThreadView = false, grouped = false) => {
    const replyCount = m._count?.replies ?? 0;
    const isAudioMsg = m.content === '🎙️ Voice Note' || (m.fileUrl && (m.fileType?.includes('audio') || m.fileType?.includes('webm')));
    const isPoll = Boolean(m.pollData); // Check if this is a poll message

    return (
      // T.32 (audit FE-3): each message is reachable by keyboard (Tab), which
      // also reveals its action bar (focus-within). Only messages that just
      // arrived animate in — history does not replay animations on scroll.
      <div
        key={m.id}
        data-message-id={m.id}
        role="article"
        tabIndex={isPending(m) ? -1 : 0}
        {...(isPending(m) ? {} : messageLongPress({ message: m, isThreadView }))}
        aria-label={`${m.sender?.username ?? 'Someone'}, ${format(new Date(m.createdAt), 'h:mm a')}`}
        className={`max-md:select-none max-md:[-webkit-touch-callout:none] group relative flex gap-3 rounded-lg outline-none transition-colors hover:bg-surface-secondary focus-visible:bg-surface-secondary focus-visible:ring-2 focus-visible:ring-focus ${grouped ? 'px-3 py-0.5 @lg:px-5' : 'px-3 pt-2 pb-1 @lg:px-5 @lg:pt-2.5'} ${m.isPinned && !isThreadView ? 'bg-warning-soft/50 shadow-[inset_2px_0_0_var(--color-warning)]' : ''} ${m.deliveryState === 'pending' ? 'opacity-60' : ''} ${!isThreadView && highlightedId === m.id ? 'ring-2 ring-brand bg-brand-soft' : ''} ${Date.now() - new Date(m.createdAt).getTime() < 8000 ? 'animate-message-in' : ''}`}
      >
        {m.isPinned && !isThreadView && (
          <div className="absolute -top-2 left-12 z-10 flex items-center gap-1 rounded-full border border-warning/25 bg-surface px-2 py-0.5 text-[10px] font-semibold text-warning">
            <Pin size={10} aria-hidden="true" /> Pinned
          </div>
        )}

        {grouped ? (
          // Same author moments later: no repeated avatar/name, just the time on hover.
          <div className="w-9 shrink-0 pt-1 text-right text-[10px] font-medium tabular-nums text-fg-subtle opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" aria-hidden="true">
            {format(new Date(m.createdAt), 'h:mm')}
          </div>
        ) : (
          <Avatar name={m.sender?.username} size="md" className="mt-0.5" />
        )}
        <div className="flex-1 min-w-0 relative">
          {grouped ? (
            <span className="sr-only">{m.sender?.username} at {format(new Date(m.createdAt), 'h:mm a')}</span>
          ) : (
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="font-semibold text-fg text-[14px] truncate min-w-0">{m.sender?.username}</span>
            <time dateTime={m.createdAt} title={format(new Date(m.createdAt), 'PPpp')} className="text-xs text-fg-subtle tabular-nums shrink-0">{format(new Date(m.createdAt), 'h:mm a')}</time>
          </div>
          )}
          
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
                  className="px-4 py-1.5 bg-brand hover:bg-brand-hover text-on-brand rounded-lg text-sm font-semibold transition-colors active:scale-95"
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
                        <button
                          type="button"
                          key={opt.id}
                          onClick={() => handleVote(m.id, opt.id)}
                          aria-label={`Vote for ${opt.text}: ${percent}% (${opt.votes.length} ${opt.votes.length === 1 ? 'vote' : 'votes'})`}
                          className="relative h-11 w-full bg-gray-100 rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-violet-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus transition-all group/poll text-left"
                        >
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
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-3 text-xs text-gray-500 font-medium">
                    {m.pollData!.options.reduce((acc, o) => acc + o.votes.length, 0)} Total Votes
                  </div>
                </div>
              ) : (
                !isAudioMsg && (
                  <>
                  <div className="rich-text mt-0.5 text-[15px] text-fg leading-relaxed break-words" dangerouslySetInnerHTML={{ __html: sanitizeMessageHtml(m.content ?? '') }} />
                  {m.editedAt && (
                    <span className="text-[11px] text-fg-subtle" title={`Edited ${format(new Date(m.editedAt), 'PPp')}`}>(edited)</span>
                  )}
                  </>
                )
              )}
            </>
          )}

          {m.content && !isPoll && !isPending(m) && extractUrls(m.content).map((url) => (
            <LinkPreview key={url} url={url} />
          ))}

          {m.deliveryState === 'pending' && (
            <div className="mt-2 text-xs font-medium text-gray-400" role="status">Sending…</div>
          )}
          {m.deliveryState === 'failed' && m.clientId && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-red-600" role="alert">
              <AlertCircle size={14} aria-hidden="true" />
              <span>{m.deliveryError ?? 'Failed to send.'}</span>
              <button type="button" onClick={() => retrySend(m.clientId!)} className="underline hover:text-red-700">
                Retry
              </button>
              <button type="button" onClick={() => discardFailed(m.clientId!)} className="text-gray-500 underline hover:text-gray-700">
                Discard
              </button>
            </div>
          )}

          {isAudioMsg ? (
            m.fileUrl ? (
              <MessageAttachment fileUrl={m.fileUrl} fileName={m.fileName} fileType={m.fileType} audio />
            ) : (
              <span className="mt-2 block text-xs font-semibold text-danger">Audio missing.</span>
            )
          ) : m.fileUrl ? (
            <MessageAttachment fileUrl={m.fileUrl} fileName={m.fileName} fileType={m.fileType} />
          ) : null}
          
          {((m.reactions?.length ?? 0) > 0 || (!isThreadView && replyCount > 0)) && (
          <div className="flex gap-1.5 mt-2 flex-wrap items-center">
            {m.reactions?.map((reaction) => {
              const reactedByMe = reaction.users.some(u => u.id === user?.id);
              return (
                <button
                  type="button"
                  key={reaction.emoji}
                  onClick={() => handleReact(m.id, reaction.emoji)}
                  title={reaction.users.map(u => u.username).join(', ')}
                  aria-label={`${reaction.emoji} ${reaction.count}: ${reactedByMe ? 'remove your reaction' : 'react'} (${reaction.users.map(u => u.username).join(', ')})`}
                  aria-pressed={reactedByMe}
                  className={`inline-flex h-6 items-center gap-1 px-2 rounded-full text-[13px] border transition-colors ${
                    reactedByMe
                      ? 'bg-brand-soft border-brand/40 hover:border-brand/70'
                      : 'bg-surface hover:bg-surface-secondary border-line hover:border-border-strong'
                  }`}
                >
                  <span key={`${reaction.emoji}-${reaction.count}`} className="text-[14px] leading-none animate-reaction-pop">{reaction.emoji}</span>
                  <span className={`text-xs font-semibold tabular-nums ${reactedByMe ? 'text-brand' : 'text-fg-muted'}`}>{reaction.count}</span>
                </button>
              );
            })}
            
            {!isThreadView && replyCount > 0 && (
              <button
                type="button"
                onClick={() => setActiveThread(m)}
                className="flex h-6 items-center gap-1.5 text-xs font-semibold text-brand hover:bg-brand-soft px-2 rounded-md transition-colors"
              >
                <MessageSquare size={13} aria-hidden="true" />
                {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
              </button>
            )}
          </div>
          )}

          {!isThreadView && receiptLabel && myLatest?.id === m.id && (
            <p className="mt-2 flex items-center gap-1 text-[11px] font-medium text-gray-400" aria-live="polite">
              <CheckCheck size={13} aria-hidden="true" /> {receiptLabel}
            </p>
          )}

          {reactingToId === m.id && (
            <div className="absolute top-12 left-0 z-50 shadow-2xl rounded-xl border border-border-subtle overflow-hidden bg-white animate-scale-in">
              <EmojiPicker onPick={(emoji) => handleReact(m.id, emoji)} />
            </div>
          )}
          {/* P3: message actions — a row beneath the message when the column is
              narrow (touch: tap the message), floating above it when wide. */}
          {!isPending(m) && (
          <div role="toolbar" aria-label="Message actions" className="mt-1.5 w-fit @lg:mt-0 @lg:absolute @lg:-right-1 @lg:-top-5 hidden group-hover:flex group-focus-within:flex items-center gap-0.5 bg-surface border border-line rounded-lg shadow-md p-0.5 z-10 animate-pop-in">
            {canReactHere && (
              <button
                type="button"
                onClick={() => setReactingToId(reactingToId === m.id ? null : m.id)}
                className={ACTION_BUTTON}
                title="Add reaction"
                aria-label="Add reaction"
              >
                <SmilePlus size={16} aria-hidden="true" />
              </button>
            )}
          
            {!isThreadView && !readOnly && (
              <button
                type="button"
                onClick={() => handlePin(m.id, !!m.isPinned)}
                className={`${ACTION_BUTTON} ${m.isPinned ? '!text-amber-600 bg-amber-50' : ''}`}
                title={m.isPinned ? 'Unpin message' : 'Pin message'}
                aria-label={m.isPinned ? 'Unpin message' : 'Pin message'}
              >
                <Pin size={17} aria-hidden="true" />
              </button>
            )}

            {!isThreadView && (canReplyHere || replyCount > 0) && (
              <button
                type="button"
                onClick={() => setActiveThread(m)}
                className={ACTION_BUTTON}
                title="Reply in thread"
                aria-label="Reply in thread"
              >
                <Reply size={17} aria-hidden="true" />
              </button>
            )}
            {/* Cannot edit Polls. Backend already rejects an edit/delete from
                anyone but the sender (message:edit/message:delete in
                sockets/messages.handlers.ts silently no-op on a mismatch) —
                hiding these for a non-owner here isn't the real security
                boundary, it just avoids showing a button that would otherwise
                do nothing with no feedback when clicked. */}
            {!isPoll && !readOnly && m.senderId === user?.id && (
              <button
                type="button"
                onClick={() => setEditingId(m.id)}
                className={ACTION_BUTTON}
                title="Edit message"
                aria-label="Edit message"
              >
                <Pencil size={17} aria-hidden="true" />
              </button>
            )}
            {!isPoll && !isAudioMsg && htmlToText(m.content) && (
              <button
                type="button"
                onClick={() => void copyMessageText(m)}
                className={ACTION_BUTTON}
                title="Copy text"
                aria-label="Copy text"
              >
                <Copy size={17} aria-hidden="true" />
              </button>
            )}
            {!readOnly && m.senderId === user?.id && (
              <button
                type="button"
                onClick={() => void requestDelete(m.id)}
                className={`${ACTION_BUTTON} hover:!text-danger hover:!bg-danger-soft`}
                title="Delete message"
                aria-label="Delete message"
              >
                <Trash2 size={17} aria-hidden="true" />
              </button>
            )}
          </div>
          )}
        </div>

      </div>
    );
  };

  return (
    <div className="@container/chat flex h-full bg-surface relative w-full overflow-hidden" onClick={() => setReactingToId(null)}>
      <div className={`@container flex flex-col h-full min-w-0 flex-1 ${activeThread ? 'border-r border-border-subtle' : ''}`}>
        
        <div className="border-b border-line bg-surface px-3 @lg:px-5 flex items-center justify-between gap-3 shrink-0 h-14 max-md:h-[calc(3.5rem+env(safe-area-inset-top))] max-md:pt-[env(safe-area-inset-top)] max-md:pl-1.5">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* T.39: phones show the conversation full-screen; back returns to the chat list. */}
            <button
              type="button"
              onClick={() => navigate(`/${workspaceId}/chats`)}
              className="-mr-1 flex h-10 w-9 shrink-0 items-center justify-center rounded-full text-fg active:bg-surface-tertiary md:hidden"
              aria-label="Back to chats"
            >
              <ChevronLeft size={26} aria-hidden="true" />
            </button>
            {channel.isDM && !channel.isGroupDM ? (
              <Avatar name={channel.name} size="sm" presence={dmPartnerOnline ? 'online' : 'offline'} />
            ) : (
              // T.39: phones drop the decorative channel icon (the back button and subtitle already orient).
              <div className={`w-7 h-7 shrink-0 rounded-md bg-surface-tertiary flex items-center justify-center text-fg-muted font-semibold text-sm ${channel.isGroupDM ? '' : 'max-md:hidden'}`} aria-hidden="true">
                {channel.isGroupDM ? <Users size={15} /> : <Hash size={15} />}
              </div>
            )}
            <div className="min-w-0">
              <h2 className="font-semibold text-[15px] text-fg flex items-center gap-2 min-w-0 tracking-[-0.01em]">
                <span className="truncate">{channel.name}</span>
                {!channel.isDM && channelDetails?.visibility === 'PRIVATE' && (
                  <Lock size={16} className="text-gray-400 shrink-0" aria-label="Private channel" />
                )}
                {!channel.isDM && channelDetails?.isAnnouncement && (
                  <Megaphone size={16} className="text-amber-500 shrink-0" aria-label="Announcement channel" />
                )}
                {!channel.isDM && channelDetails?.archived && (
                  <span className="text-xs font-semibold text-gray-500 bg-gray-100 rounded-md px-1.5 py-0.5 flex items-center gap-1">
                    <Archive size={12} aria-hidden="true" /> Archived
                  </span>
                )}
              </h2>
              <p className="text-xs text-fg-subtle truncate">
                {channel.isGroupDM
                  ? `${channel.participants?.length ?? 0} people`
                  : channel.isDM
                    ? (dmPartnerOnline ? 'Active now' : 'Direct message')
                    : channelDetails?.topic || channelDetails?.description || channel.description ||
                      (channelDetails ? channelTypeLabel(channelDetails) : 'Channel')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 @lg:gap-2 shrink-0">
            {channel.isDM && (
              <button
                type="button"
                onClick={() => setShowDetails(true)}
                className={`inline-flex ${HEADER_BUTTON}`}
                aria-label={channel.isGroupDM ? 'Conversation details and members' : 'Conversation details'}
                title="Details"
              >
                <Info size={18} aria-hidden="true" />
                <span className="hidden @3xl:inline">Details</span>
              </button>
            )}
            {!channel.isDM && (
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                disabled={!channelDetails}
                className={`inline-flex ${HEADER_BUTTON} disabled:opacity-50`}
                aria-label="Channel settings"
                title="Channel settings"
              >
                <Settings size={18} aria-hidden="true" />
                <span className="hidden @3xl:inline">Settings</span>
              </button>
            )}
            {canLeaveHere && (
              <button
                type="button"
                onClick={leaveChannel}
                className={`${HEADER_BUTTON} hidden @xl:inline-flex hover:!text-danger hover:!bg-danger-soft`}
                aria-label={`Leave #${channel.name}`}
                title={`Leave #${channel.name}`}
              >
                <LogOut size={18} aria-hidden="true" />
                <span className="hidden @3xl:inline">Leave</span>
              </button>
            )}
            {canAddHere && (
              <button
                type="button"
                onClick={() => setShowAddMemberModal(true)}
                className={`${HEADER_BUTTON} hidden @xl:inline-flex`}
                aria-label="Add people"
                title="Add people"
              >
                <UserPlus size={18} aria-hidden="true" />
                <span className="hidden @3xl:inline">Add people</span>
              </button>
            )}
            {/* Narrow conversations: the same actions behind one menu. */}
            <div className="@xl:hidden">
              <Menu
                label="More channel actions"
                align="right"
                trigger={<MoreHorizontal size={18} aria-hidden="true" />}
                triggerClassName={`inline-flex ${HEADER_BUTTON}`}
                items={headerMenuItems}
              />
            </div>
            <button
              type="button"
              onClick={() => onStartCall('audio')}
              className={`inline-flex ${HEADER_BUTTON}`}
              aria-label="Start audio call"
              title="Start audio call"
            >
              <Phone size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onStartCall('video')}
              className="inline-flex items-center justify-center h-9 w-9 @lg:h-10 @lg:w-10 rounded-lg bg-brand text-on-brand hover:bg-brand-hover shadow-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              aria-label="Start video call"
              title="Start video call"
            >
              <Video size={18} aria-hidden="true" />
            </button>
          </div>
        </div>

        {showDetails && user && (
          <ConversationDetailsModal
            conversation={channel}
            workspaceId={workspaceId}
            currentUserId={user.id}
            onlineUsers={onlineUsers}
            onClose={() => setShowDetails(false)}
            onLeft={() => {
              setShowDetails(false);
              removeConversation(channel.id);
              navigate(`/${workspaceId}`);
            }}
          />
        )}

        {showSettings && channelDetails && user && (
          <ChannelSettingsModal
            details={channelDetails}
            currentUserId={user.id}
            onClose={() => setShowSettings(false)}
            onChanged={(fresh) => setChannelDetails(fresh)}
          />
        )}

        <AddMemberModal
          isOpen={showAddMemberModal}
          onClose={() => setShowAddMemberModal(false)}
          channelId={channel.id}
          channelName={channel.name}
        />

        {pinned.length > 0 && (
          <div className="bg-warning-soft border-b border-amber-200/50 px-3 @lg:px-6 py-2 @lg:py-3 shrink-0 flex items-center gap-3 overflow-x-auto shadow-sm z-10">
            <div className="flex items-center gap-2 text-amber-700 font-bold text-xs uppercase tracking-wider shrink-0">
              <div className="w-6 h-6 rounded-lg bg-amber-100 flex items-center justify-center">
                <Pin size={13} />
              </div>
              <span>{pinned.length} Pinned</span>
            </div>
            <div className="w-px h-5 bg-amber-300 shrink-0"></div>
            <div className="flex gap-2.5 overflow-x-auto no-scrollbar">
              {pinned.map(m => (
                <button
                  type="button"
                  key={m.id}
                  onClick={() => requestMessageFocus({ channelId: channel.id, messageId: m.id })}
                  title="Show this message"
                  className="text-xs text-amber-900 bg-white px-4 py-2 rounded-xl border border-amber-200 truncate max-w-[280px] shadow-sm flex items-center gap-2.5 hover:shadow-md transition-all cursor-pointer"
                >
                  <span className="font-bold text-amber-800">{m.sender?.username}:</span>
                  <span className="truncate font-medium">{truncate(htmlToText(m.content), 35) || 'Attachment...'}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div role="alert" className="mx-3 @lg:mx-6 mt-3 p-3 @lg:p-4 bg-danger-soft text-danger rounded-xl border border-red-200 text-sm flex justify-between items-center gap-3 shadow-sm animate-fade-in shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center shrink-0">
                <X size={16} className="text-red-600" />
              </div>
              <span className="font-medium">{error}</span>
            </div>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss" title="Dismiss" className="p-1.5 hover:bg-red-100 rounded-lg transition-colors">
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        )}

        <div className="flex-1 min-h-0 bg-white px-1 py-2 @lg:px-4 @lg:py-4 relative" onClick={(e) => e.stopPropagation()}>
          {mainMessages.length === 0 ? (
            <div className="h-full flex items-center justify-center text-gray-400 font-medium">
              No messages yet — say hello!
            </div>
          ) : (
            <Virtuoso
              ref={virtuosoRef}
              style={{ height: '100%' }}
              className="slack-scrollbar overflow-x-hidden"
              data={mainMessages}
              firstItemIndex={firstItemIndex}
              initialTopMostItemIndex={mainMessages.length - 1}
              startReached={loadMoreMessages}
              followOutput="smooth"
              atBottomStateChange={setAtBottom}
              computeItemKey={(_index, m) => m.id}
              itemContent={(_index, m) => (
                <>
                  {layout.get(m.id)?.dayLabel && (
                    <div className="flex items-center gap-3 px-5 pt-4 pb-2" role="separator" aria-label={layout.get(m.id)!.dayLabel!}>
                      <div className="flex-1 h-px bg-line" />
                      <span className="text-[11px] font-semibold text-fg-muted border border-line rounded-full px-3 py-0.5 bg-surface">{layout.get(m.id)!.dayLabel}</span>
                      <div className="flex-1 h-px bg-line" />
                    </div>
                  )}
                  {m.id === firstUnreadId && (
                    <div className="flex items-center gap-3 px-5 py-2" role="separator" aria-label="New messages">
                      <div className="flex-1 h-px bg-red-300" />
                      <span className="text-[11px] font-bold uppercase tracking-wider text-red-500">New messages</span>
                      <div className="flex-1 h-px bg-red-300" />
                    </div>
                  )}
                  {renderMessageUI(m, false, !!layout.get(m.id)?.grouped && m.id !== firstUnreadId)}
                </>
              )}
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
          {!atBottom && mainMessages.length > 0 && (
            <button
              type="button"
              onClick={() => virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' })}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 rounded-full bg-brand text-on-brand text-xs font-semibold px-4 py-2 shadow-lg hover:opacity-90"
            >
              <ArrowDown size={14} aria-hidden="true" /> Jump to latest
            </button>
          )}
        </div>

        {typingUsers.length > 0 && (
          <div className="shrink-0 px-4 @lg:px-6 pt-1 bg-surface" aria-live="polite">
            {typingUsers.length > 0 && (
              <div className="flex items-center gap-2 text-xs text-fg-subtle animate-fade-in">
                <span className="flex gap-0.5" aria-hidden="true">
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-fg-subtle" style={{ animationDelay: '0ms' }} />
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-fg-subtle" style={{ animationDelay: '160ms' }} />
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-fg-subtle" style={{ animationDelay: '320ms' }} />
                </span>
                <span className="font-medium">
                  {typingUsers.join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing...
                </span>
              </div>
            )}
          </div>
        )}

        {composer.mode === 'locked' ? (
          <div role="status" className="border-t border-border-subtle bg-gray-50 px-3 @lg:px-6 py-4 shrink-0 text-sm text-gray-600 flex items-center gap-2">
            {composer.reason === 'archived' ? <Archive size={16} aria-hidden="true" /> : <Megaphone size={16} aria-hidden="true" />}
            {COMPOSER_NOTICES[composer.reason]}
          </div>
        ) : (
        <div className="bg-surface px-3 pb-3 pt-1 @lg:px-5 @lg:pb-4 shrink-0 relative max-md:px-2 max-md:pb-[max(env(safe-area-inset-bottom),0.5rem)]" onClick={(e) => e.stopPropagation()}>
          
          {showEmojiPicker && (
            <div className="absolute bottom-full left-4 mb-3 z-50 shadow-2xl rounded-xl border border-border-subtle overflow-hidden bg-white animate-scale-in">
              <EmojiPicker
                onPick={(emoji) => {
                  mainEditorRef.current?.insertText(emoji);
                  setShowEmojiPicker(false);
                }}
              />
            </div>
          )}

          {/* 👇 NAYA: Command Hint Box 👇 */}
          {content.startsWith('/') && !content.startsWith('/poll') && (
            <div className="absolute bottom-full left-4 mb-2 bg-surface border border-line shadow-lg rounded-xl p-2 z-50 min-w-[250px] animate-pop-in" role="listbox" aria-label="Slash commands">
              <div className="text-[11px] font-medium text-fg-subtle px-2 pb-1">Slash commands</div>
              <button
                type="button"
                role="option"
                aria-selected="false"
                className="flex w-full items-center gap-3 p-2 text-left hover:bg-surface-tertiary rounded-lg transition-colors"
                onClick={() => {
                  mainEditorRef.current?.setContent('/poll "Your Question?" "Option 1" "Option 2"');
                  mainEditorRef.current?.focus();
                }}
              >
                <span className="bg-brand-soft text-brand p-1.5 rounded-md" aria-hidden="true"><BarChart2 size={15} /></span>
                <span>
                  <span className="block font-semibold text-sm text-fg">/poll</span>
                  <span className="block text-xs text-fg-subtle">Create a live voting poll</span>
                </span>
              </button>
            </div>
          )}

          {/* T.33: staged attachments with per-file progress, cancel and retry. */}
          <AttachmentTray items={uploads.items} onRemove={uploads.remove} onRetry={uploads.retry} />

          {mentionOpen && (
            <ul
              role="listbox"
              aria-label="People to mention"
              className="absolute bottom-full left-5 mb-2 z-50 w-64 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface shadow-xl py-1"
            >
              {mentionOptions.map((option, index) => (
                <li
                  key={option.id}
                  role="option"
                  aria-selected={index === mentionIndex}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setMentionIndex(index)}
                  onClick={() => chooseMention(option.username)}
                  className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer ${index === mentionIndex ? 'bg-brand-soft text-fg' : 'text-fg'}`}
                >
                  <span aria-hidden="true" className="w-6 h-6 rounded-md bg-brand text-on-brand text-xs font-bold uppercase flex items-center justify-center">
                    {option.username[0]}
                  </span>
                  @{option.username}
                </li>
              ))}
            </ul>
          )}
          <div
            className={`relative border rounded-xl overflow-hidden focus-within:border-brand/60 focus-within:shadow-[0_0_0_3px_var(--color-brand-soft)] transition-[border-color,box-shadow] bg-surface ${dragActive ? 'border-brand shadow-[0_0_0_3px_var(--color-brand-muted)]' : 'border-border-default'}`}
            onDragOver={(e) => {
              if (voiceOpen || !Array.from(e.dataTransfer.types).includes('Files')) return;
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false);
            }}
            onDrop={(e) => {
              if (!Array.from(e.dataTransfer.types).includes('Files')) return;
              e.preventDefault();
              setDragActive(false);
              const files = Array.from(e.dataTransfer.files ?? []);
              if (files.length && !voiceOpen) uploads.add(files);
            }}
          >
            {dragActive && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-brand-soft/90 text-brand text-sm font-semibold pointer-events-none" aria-hidden="true">
                Drop to attach
              </div>
            )}
            {/* T.33: voice notes record, review and send from here; the editor stays
                mounted (hidden) so the typed draft survives. */}
            {voiceOpen && (
              <div className="p-2">
                <VoiceRecorderBar onSend={sendVoiceMessage} onClose={() => setVoiceOpen(false)} />
              </div>
            )}
              <div className={voiceOpen ? 'hidden' : 'w-full px-3 pt-2.5 pb-1 @lg:px-4'}>
                <RichTextEditor
                  ref={mainEditorRef}
                  placeholder={channel.isDM ? `Message ${channel.name}` : isPhone ? `Message #${channel.name}` : `Message #${channel.name} (Type '/' for commands)`}
                  enterSends={!(isPhone && isTouch)}
                  formattingHiddenOnPhone={!formattingOpen}
                  initialContent={initialDraft?.html ?? ''}
                  onSubmit={() => handleSend()}
                  onPasteFiles={(files) => uploads.add(Array.from(files))}
                  onMentionQuery={setMentionQuery}
                  onMentionKey={handleMentionKey}
                  onChangeContent={(html, text) => {
                    setContent(text);
                    saveDraft(user?.id, channel.id, html, text);
                    // Clearing after send also fires this — that isn't typing.
                    if (!text.trim()) return;
                    const now = Date.now();
                    if (now - lastTypingSentRef.current > TYPING_THROTTLE_MS) {
                      lastTypingSentRef.current = now;
                      socket.emit('typing:start', { channelId: channel.id });
                    }
                    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
                    typingTimeoutRef.current = setTimeout(() => {
                      lastTypingSentRef.current = 0;
                      socket.emit('typing:stop', { channelId: channel.id });
                    }, 1500);
                  }}
                />
              </div>

            <div className={voiceOpen ? 'hidden' : 'flex items-center justify-between px-2 @lg:px-3 py-1.5'}>
              <div className="flex items-center gap-1.5">
                <input type="file" multiple hidden ref={fileInputRef} onChange={handleFileUpload} aria-hidden="true" tabIndex={-1} />
                {/* T.39: phone attachment sheet sources (same upload queue). */}
                <input type="file" multiple hidden accept="image/*,video/*" ref={photoInputRef} onChange={handleFileUpload} aria-hidden="true" tabIndex={-1} />
                <input type="file" hidden accept="image/*" capture="environment" ref={cameraInputRef} onChange={handleFileUpload} aria-hidden="true" tabIndex={-1} />
                <button
                  type="button"
                  onClick={() => (isPhone ? setAttachSheetOpen(true) : fileInputRef.current?.click())}
                  disabled={voiceOpen}
                  className={COMPOSER_BUTTON}
                  title="Attach files"
                  aria-label="Attach file"
                >
                  <Plus size={20} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                  disabled={voiceOpen}
                  className={`${COMPOSER_BUTTON} ${showEmojiPicker ? '!bg-brand-soft !text-brand' : ''}`}
                  title="Add emoji"
                  aria-label="Add emoji"
                  aria-expanded={showEmojiPicker}
                >
                  <Smile size={20} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => setFormattingOpen((v) => !v)}
                  disabled={voiceOpen}
                  className={`${COMPOSER_BUTTON} md:hidden ${formattingOpen ? '!bg-brand-soft !text-brand' : ''}`}
                  aria-label={formattingOpen ? 'Hide formatting' : 'Show formatting'}
                  aria-pressed={formattingOpen}
                >
                  <Type size={20} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setVoiceOpen(true);
                  }}
                  disabled={voiceOpen}
                  className={COMPOSER_BUTTON}
                  title="Record voice message"
                  aria-label="Record voice message"
                >
                  <Mic size={20} aria-hidden="true" />
                </button>
              </div>
              <button
                type="button"
                onClick={(e) => handleSend(e)}
                disabled={(!content.trim() && uploads.ready.length === 0) || voiceOpen || uploads.busy}
                title="Send (Enter) · New line (Shift+Enter)"
                className={`h-8 px-3 rounded-lg font-semibold text-[13px] transition-colors flex items-center gap-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                  (content.trim() || uploads.ready.length > 0) && !uploads.busy
                    ? 'bg-brand hover:bg-brand-hover text-on-brand'
                    : 'bg-surface-tertiary text-fg-subtle cursor-not-allowed'
                }`}
              >
                <Send size={14} aria-hidden="true" />
                Send
              </button>
            </div>
          </div>
        </div>
        )}
      </div>

      {activeThread && (
        <ThreadPanel
          messageId={activeThread.id}
          channelId={channel.id}
          channelName={channel.name ?? ''}
          socket={socket}
          onClose={() => setActiveThread(null)}
          canReply={caps?.canReply ?? true}
        />
      )}
      {actionSheet && (() => {
        const { message: am, isThreadView: inThread } = actionSheet;
        const close = () => setActionSheet(null);
        const own = am.senderId === user?.id;
        const poll = Boolean(am.pollData);
        const audio = am.content === '🎙️ Voice Note' || !!(am.fileUrl && (am.fileType?.includes('audio') || am.fileType?.includes('webm')));
        const replies = am._count?.replies ?? 0;
        return (
          <BottomSheet title={`Message from ${am.sender?.username ?? 'someone'}`} onClose={close}>
            {canReactHere && (
              <div className="flex items-center justify-between gap-1 px-3 pb-2" role="group" aria-label="Quick reactions">
                {['👍', '❤️', '😂', '🎉', '😮', '🙏'].map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      close();
                      void handleReact(am.id, emoji);
                    }}
                    className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-secondary text-2xl active:scale-90"
                    aria-label={`React with ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
            <div className="border-t border-line py-1">
              {!inThread && (canReplyHere || replies > 0) && <SheetAction icon={Reply} label={replies > 0 ? `Open thread (${replies})` : 'Reply in thread'} onSelect={() => { close(); setActiveThread(am); }} />}
              {!poll && !audio && htmlToText(am.content) && <SheetAction icon={Copy} label="Copy text" onSelect={() => { close(); void copyMessageText(am); }} />}
              {!inThread && !readOnly && <SheetAction icon={am.isPinned ? PinOff : Pin} label={am.isPinned ? 'Unpin message' : 'Pin message'} onSelect={() => { close(); handlePin(am.id, !!am.isPinned); }} />}
              {!poll && !readOnly && own && <SheetAction icon={Pencil} label="Edit message" onSelect={() => { close(); setEditingId(am.id); }} />}
              {!readOnly && own && <SheetAction icon={Trash2} label="Delete message" tone="danger" onSelect={() => { close(); void requestDelete(am.id); }} />}
            </div>
          </BottomSheet>
        );
      })()}
      {attachSheetOpen && (
        <BottomSheet title="Add to your message" onClose={() => setAttachSheetOpen(false)}>
          <SheetAction icon={Camera} label="Take a photo" onSelect={() => { setAttachSheetOpen(false); cameraInputRef.current?.click(); }} />
          <SheetAction icon={ImagePlus} label="Photos & videos" onSelect={() => { setAttachSheetOpen(false); photoInputRef.current?.click(); }} />
          <SheetAction icon={Paperclip} label="File" onSelect={() => { setAttachSheetOpen(false); fileInputRef.current?.click(); }} />
          <SheetAction icon={Mic} label="Voice message" onSelect={() => { setAttachSheetOpen(false); setError(null); setVoiceOpen(true); }} />
        </BottomSheet>
      )}
      {confirmDialog}
    </div>
  );
};