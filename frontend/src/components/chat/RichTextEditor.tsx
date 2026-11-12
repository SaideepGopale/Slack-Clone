import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  SquareCode,
  Strikethrough,
  Underline as UnderlineIcon,
} from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface RichTextEditorHandle {
  getHTML: () => string;
  getText: () => string;
  isEmpty: () => boolean;
  clear: () => void;
  focus: () => void;
  setContent: (html: string) => void;
  insertText: (text: string) => void;
  /** P2: replaces the "@query" being typed with "@username ". */
  completeMention: (username: string) => void;
}

interface RichTextEditorProps {
  placeholder?: string;
  initialContent?: string;
  autoFocus?: boolean;
  compact?: boolean;
  // Fired on every keystroke — HTML for storage, plain text for UI logic
  // that can't operate on markup (slash-command detection, empty-state
  // checks, poll parsing — see ChatArea.tsx's handleSend).
  onChangeContent?: (html: string, text: string) => void;
  // Enter-without-Shift. Takes no args — callers read current content via
  // the ref (getHTML/getText) rather than through this callback, since a
  // stale closure over "content at editor-creation time" is exactly the bug
  // this ref-based design avoids.
  onSubmit?: () => void;
  /**
   * T.39: false on touch phones — Enter inserts a new line (no Shift key on a
   * phone keyboard) and the Send button sends. Ctrl/⌘+Enter always sends.
   */
  enterSends?: boolean;
  /** T.39: hide the formatting toolbar below 768px (the composer's "Aa" button shows it). */
  formattingHiddenOnPhone?: boolean;
  /** P2: files pasted into the editor (images/screenshots) — the composer attaches them. */
  onPasteFiles?: (files: File[]) => void;
  /** P2: the "@query" being typed right before the cursor, or null when there is none. */
  onMentionQuery?: (query: string | null) => void;
  /**
   * P2: while a mention list is open, the composer gets first refusal on
   * ArrowUp/ArrowDown/Enter/Tab/Escape; returning true consumes the key.
   */
  onMentionKey?: (key: string) => boolean;
}

const MENTION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape']);
// "@" at the start of the block or after whitespace/an opening bracket.
const MENTION_BEFORE_CURSOR = /(?:^|[\s(])@([A-Za-z0-9._-]{0,30})$/;

/** The "@query" ending at the cursor (outside code), with its document range. */
const mentionAtCursor = (editor: NonNullable<ReturnType<typeof useEditor>>) => {
  const { $from, empty } = editor.state.selection;
  if (!empty || editor.isActive('code') || editor.isActive('codeBlock')) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
  const match = MENTION_BEFORE_CURSOR.exec(before);
  if (!match) return null;
  return { query: match[1], from: $from.pos - match[1].length - 1, to: $from.pos };
};

const LINK_PROTOCOLS = /^(https?:\/\/|mailto:)/i;

const ToolbarButton = ({
  active = false,
  onClick,
  label,
  shortcut,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  label: string;
  shortcut?: string;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    // Clicking a toolbar button would otherwise blur the editor and collapse
    // the text selection *before* the click handler runs — preventDefault on
    // mousedown keeps focus (and the selection) in the editor throughout.
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    title={shortcut ? `${label} (${shortcut})` : label}
    aria-label={label}
    aria-pressed={active}
    className={`p-1.5 rounded-md transition-colors shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
      active ? 'bg-brand-muted text-brand' : 'text-fg-subtle hover:bg-surface-tertiary hover:text-fg'
    }`}
  >
    {children}
  </button>
);

const Divider = () => <span aria-hidden="true" className="w-px h-4 bg-line mx-1 shrink-0" />;

export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(
  ({ placeholder, initialContent = '', autoFocus, compact, onChangeContent, onSubmit, enterSends = true, formattingHiddenOnPhone = false, onPasteFiles, onMentionQuery, onMentionKey }, ref) => {
    const enterSendsRef = useRef(enterSends);
    enterSendsRef.current = enterSends;
    // useEditor's `editorProps.handleKeyDown` is a raw ProseMirror option —
    // unlike onUpdate/onCreate, TipTap doesn't necessarily re-bind it on
    // every render, so closing over `onSubmit` directly risks calling a
    // stale version. Reading through a ref sidesteps that entirely.
    const onSubmitRef = useRef(onSubmit);
    const onPasteFilesRef = useRef(onPasteFiles);
    const onMentionQueryRef = useRef(onMentionQuery);
    const onMentionKeyRef = useRef(onMentionKey);
    const lastMentionRef = useRef<string | null>(null);
    useEffect(() => {
      onSubmitRef.current = onSubmit;
      onPasteFilesRef.current = onPasteFiles;
      onMentionQueryRef.current = onMentionQuery;
      onMentionKeyRef.current = onMentionKey;
    }, [onSubmit, onPasteFiles, onMentionQuery, onMentionKey]);
    // Reports the "@query" at the cursor whenever it changes.
    const reportMention = (e: NonNullable<ReturnType<typeof useEditor>>) => {
      if (!onMentionQueryRef.current) return;
      const query = mentionAtCursor(e)?.query ?? null;
      if (query === lastMentionRef.current) return;
      lastMentionRef.current = query;
      onMentionQueryRef.current(query);
    };
    const [linkDraft, setLinkDraft] = useState<string | null>(null);

    const editor = useEditor({
      extensions: [
        // StarterKit v3 bundles bold/italic/underline/strike, inline code,
        // code blocks, quotes, lists, headings and links.
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          link: {
            openOnClick: false,
            autolink: true,
            linkOnPaste: true,
            defaultProtocol: 'https',
            protocols: ['http', 'https', 'mailto'],
            isAllowedUri: (url) => LINK_PROTOCOLS.test(url),
            HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer nofollow' },
          },
        }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Placeholder.configure({ placeholder: placeholder ?? 'Message...' }),
      ],
      content: initialContent,
      autofocus: autoFocus ? 'end' : false,
      editorProps: {
        attributes: {
          class: 'rich-text outline-none text-fg text-base leading-relaxed min-h-[1.5em] max-h-60 overflow-y-auto',
          'aria-label': placeholder ?? 'Message',
          'aria-multiline': 'true',
          role: 'textbox',
        },
        handleKeyDown: (view, event) => {
          if (MENTION_KEYS.has(event.key) && !event.isComposing && onMentionKeyRef.current?.(event.key)) {
            event.preventDefault();
            return true;
          }
          if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return false;
          // Ctrl/⌘+Enter always sends; plain Enter continues a list or code
          // block, and sends everywhere else.
          const { $from } = view.state.selection;
          const inBlock = Array.from({ length: $from.depth + 1 }, (_, d) => $from.node(d).type.name).some((n) => n === 'codeBlock' || n === 'listItem');
          if (inBlock && !(event.metaKey || event.ctrlKey)) return false;
          if (!enterSendsRef.current && !(event.metaKey || event.ctrlKey)) return false;
          event.preventDefault();
          onSubmitRef.current?.();
          return true;
        },
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length === 0 || !onPasteFilesRef.current) return false;
          event.preventDefault();
          onPasteFilesRef.current(files);
          return true;
        },
      },
      onUpdate: ({ editor }) => {
        onChangeContent?.(editor.getHTML(), editor.getText());
        reportMention(editor);
      },
      onSelectionUpdate: ({ editor }) => reportMention(editor),
    });

    // Re-render the toolbar when the selection's formatting changes.
    const state = useEditorState({
      editor,
      selector: ({ editor: e }) =>
        e
          ? {
              bold: e.isActive('bold'),
              italic: e.isActive('italic'),
              underline: e.isActive('underline'),
              strike: e.isActive('strike'),
              code: e.isActive('code'),
              link: e.isActive('link'),
              bullet: e.isActive('bulletList'),
              ordered: e.isActive('orderedList'),
              quote: e.isActive('blockquote'),
              codeBlock: e.isActive('codeBlock'),
              heading: e.isActive('heading', { level: 2 }),
              left: e.isActive({ textAlign: 'left' }),
              center: e.isActive({ textAlign: 'center' }),
              right: e.isActive({ textAlign: 'right' }),
            }
          : null,
    });

    useImperativeHandle(
      ref,
      () => ({
        getHTML: () => editor?.getHTML() ?? '',
        getText: () => editor?.getText() ?? '',
        isEmpty: () => editor?.isEmpty ?? true,
        clear: () => editor?.commands.clearContent(true),
        focus: () => editor?.commands.focus('end'),
        setContent: (html: string) => editor?.commands.setContent(html, { emitUpdate: true }),
        insertText: (text: string) => editor?.chain().focus().insertContent(text).run(),
        completeMention: (username: string) => {
          if (!editor) return;
          const at = mentionAtCursor(editor);
          if (!at) return;
          editor.chain().focus().insertContentAt({ from: at.from, to: at.to }, `@${username} `).run();
        },
      }),
      [editor]
    );

    if (!editor || !state) return null;
    const size = compact ? 13 : 15;
    const chain = () => editor.chain().focus();

    const applyLink = () => {
      const href = (linkDraft ?? '').trim();
      if (!href) chain().extendMarkRange('link').unsetLink().run();
      else {
        const url = LINK_PROTOCOLS.test(href) ? href : `https://${href}`;
        chain().extendMarkRange('link').setLink({ href: url }).run();
      }
      setLinkDraft(null);
    };

    return (
      <div>
        {linkDraft !== null ? (
          <div className={`flex items-center gap-2 ${compact ? 'mb-1.5 pb-1.5' : 'mb-2 pb-2'} border-b border-line`}>
            <label className="sr-only" htmlFor="composer-link-url">Link address</label>
            <input
              id="composer-link-url"
              autoFocus
              value={linkDraft}
              onChange={(e) => setLinkDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyLink();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setLinkDraft(null);
                  editor.commands.focus();
                }
              }}
              placeholder="https://example.com"
              className="flex-1 min-w-0 h-8 rounded-md border border-line bg-surface px-2 text-sm text-fg outline-none focus:border-brand"
            />
            <button type="button" onClick={applyLink} className="h-8 px-3 rounded-md bg-brand text-on-brand text-xs font-semibold">Apply</button>
            {state.link && (
              <button type="button" onClick={() => { setLinkDraft(''); chain().extendMarkRange('link').unsetLink().run(); setLinkDraft(null); }} className="h-8 px-2 rounded-md text-xs font-semibold text-fg-muted hover:text-danger">
                Remove
              </button>
            )}
            <button type="button" onClick={() => setLinkDraft(null)} className="h-8 px-2 rounded-md text-xs font-semibold text-fg-muted hover:text-fg">Cancel</button>
          </div>
        ) : (
          <div
            role="toolbar"
            aria-label="Formatting"
            className={`flex items-center gap-0.5 overflow-x-auto no-scrollbar ${compact ? 'mb-1.5 pb-1.5' : 'mb-2 pb-2'} border-b border-line ${formattingHiddenOnPhone ? 'max-md:hidden' : ''}`}
          >
            <ToolbarButton active={state.bold} onClick={() => chain().toggleBold().run()} label="Bold" shortcut="Ctrl+B"><Bold size={size} /></ToolbarButton>
            <ToolbarButton active={state.italic} onClick={() => chain().toggleItalic().run()} label="Italic" shortcut="Ctrl+I"><Italic size={size} /></ToolbarButton>
            <ToolbarButton active={state.underline} onClick={() => chain().toggleUnderline().run()} label="Underline" shortcut="Ctrl+U"><UnderlineIcon size={size} /></ToolbarButton>
            <ToolbarButton active={state.strike} onClick={() => chain().toggleStrike().run()} label="Strikethrough"><Strikethrough size={size} /></ToolbarButton>
            <Divider />
            <ToolbarButton active={state.code} onClick={() => chain().toggleCode().run()} label="Inline code"><Code size={size} /></ToolbarButton>
            <ToolbarButton active={state.link} onClick={() => setLinkDraft(editor.getAttributes('link').href ?? '')} label="Link"><Link2 size={size} /></ToolbarButton>
            <Divider />
            <ToolbarButton active={state.bullet} onClick={() => chain().toggleBulletList().run()} label="Bulleted list"><List size={size} /></ToolbarButton>
            <ToolbarButton active={state.ordered} onClick={() => chain().toggleOrderedList().run()} label="Numbered list"><ListOrdered size={size} /></ToolbarButton>
            <ToolbarButton active={state.quote} onClick={() => chain().toggleBlockquote().run()} label="Quote"><Quote size={size} /></ToolbarButton>
            <ToolbarButton active={state.codeBlock} onClick={() => chain().toggleCodeBlock().run()} label="Code block"><SquareCode size={size} /></ToolbarButton>
            <ToolbarButton active={state.heading} onClick={() => chain().toggleHeading({ level: 2 }).run()} label="Heading"><Heading2 size={size} /></ToolbarButton>
            <Divider />
            <ToolbarButton active={state.left} onClick={() => chain().setTextAlign('left').run()} label="Align left"><AlignLeft size={size} /></ToolbarButton>
            <ToolbarButton active={state.center} onClick={() => chain().setTextAlign('center').run()} label="Align center"><AlignCenter size={size} /></ToolbarButton>
            <ToolbarButton active={state.right} onClick={() => chain().setTextAlign('right').run()} label="Align right"><AlignRight size={size} /></ToolbarButton>
          </div>
        )}
        <EditorContent editor={editor} />
      </div>
    );
  }
);

RichTextEditor.displayName = 'RichTextEditor';
