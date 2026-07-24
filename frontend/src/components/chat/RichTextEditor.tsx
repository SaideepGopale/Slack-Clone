import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, Strikethrough } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface RichTextEditorHandle {
  getHTML: () => string;
  getText: () => string;
  isEmpty: () => boolean;
  clear: () => void;
  focus: () => void;
  setContent: (html: string) => void;
  insertText: (text: string) => void;
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
}

const ToolbarButton = ({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    // Clicking a toolbar button would otherwise blur the editor and collapse
    // the text selection *before* the click handler runs — preventDefault on
    // mousedown keeps focus (and the selection) in the editor throughout.
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    title={title}
    className={`p-1.5 rounded-lg transition-colors ${
      active ? 'bg-violet-100 text-violet-700' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-700'
    }`}
  >
    {children}
  </button>
);

export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(
  ({ placeholder, initialContent = '', autoFocus, compact, onChangeContent, onSubmit }, ref) => {
    // useEditor's `editorProps.handleKeyDown` is a raw ProseMirror option —
    // unlike onUpdate/onCreate, TipTap doesn't necessarily re-bind it on
    // every render, so closing over `onSubmit` directly risks calling a
    // stale version. Reading through a ref sidesteps that entirely.
    const onSubmitRef = useRef(onSubmit);
    useEffect(() => {
      onSubmitRef.current = onSubmit;
    }, [onSubmit]);

    const editor = useEditor({
      extensions: [
        StarterKit.configure({ heading: false }),
        TextAlign.configure({ types: ['paragraph'] }),
        Placeholder.configure({ placeholder: placeholder ?? 'Message...' }),
      ],
      content: initialContent,
      autofocus: autoFocus ? 'end' : false,
      editorProps: {
        attributes: {
          class: 'outline-none text-gray-800 text-base leading-relaxed min-h-[1.5em]',
        },
        handleKeyDown: (_view, event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmitRef.current?.();
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor }) => {
        onChangeContent?.(editor.getHTML(), editor.getText());
      },
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
      }),
      [editor]
    );

    if (!editor) return null;

    return (
      <div>
        <div className={`flex items-center gap-0.5 ${compact ? 'mb-1.5 pb-1.5' : 'mb-2 pb-2'} border-b border-gray-100`}>
          <ToolbarButton active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">
            <Bold size={compact ? 13 : 15} />
          </ToolbarButton>
          <ToolbarButton active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">
            <Italic size={compact ? 13 : 15} />
          </ToolbarButton>
          <ToolbarButton active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough">
            <Strikethrough size={compact ? 13 : 15} />
          </ToolbarButton>
          <div className="w-px h-4 bg-gray-200 mx-1" />
          <ToolbarButton
            active={editor.isActive({ textAlign: 'left' })}
            onClick={() => editor.chain().focus().setTextAlign('left').run()}
            title="Align left"
          >
            <AlignLeft size={compact ? 13 : 15} />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive({ textAlign: 'center' })}
            onClick={() => editor.chain().focus().setTextAlign('center').run()}
            title="Align center"
          >
            <AlignCenter size={compact ? 13 : 15} />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive({ textAlign: 'right' })}
            onClick={() => editor.chain().focus().setTextAlign('right').run()}
            title="Align right"
          >
            <AlignRight size={compact ? 13 : 15} />
          </ToolbarButton>
        </div>
        <EditorContent editor={editor} />
      </div>
    );
  }
);

RichTextEditor.displayName = 'RichTextEditor';
