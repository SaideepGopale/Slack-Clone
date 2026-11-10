import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RichTextEditor, RichTextEditorHandle } from './RichTextEditor';

// jsdom has no layout engine; ProseMirror measures the selection to scroll
// it into view. Zero-size rects are enough for these behavioural tests.
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  const rects = Object.assign([rect], { item: () => rect }) as unknown as DOMRectList;
  for (const proto of [Range.prototype, Element.prototype, Text.prototype] as unknown as { getClientRects?: () => DOMRectList; getBoundingClientRect?: () => DOMRect }[]) {
    if (!proto.getClientRects) proto.getClientRects = () => rects;
    if (!proto.getBoundingClientRect) proto.getBoundingClientRect = () => rect;
  }
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
});

const setup = (props: Partial<React.ComponentProps<typeof RichTextEditor>> = {}) => {
  const ref = createRef<RichTextEditorHandle>();
  const utils = render(<RichTextEditor ref={ref} placeholder="Message #general" {...props} />);
  return { ref, ...utils };
};

const editorEl = () => screen.getByRole('textbox', { name: 'Message #general' });

describe('RichTextEditor (P2 composer)', () => {
  it('offers the full formatting toolbar with accessible names', async () => {
    setup();
    const toolbar = await screen.findByRole('toolbar', { name: 'Formatting' });
    for (const label of [
      'Bold', 'Italic', 'Underline', 'Strikethrough', 'Inline code', 'Link',
      'Bulleted list', 'Numbered list', 'Quote', 'Code block', 'Heading',
      'Align left', 'Align center', 'Align right',
    ]) {
      expect(toolbar.querySelector(`[aria-label="${label}"]`), label).not.toBeNull();
    }
  });

  it('restores initial content (a saved draft) and reports changes as HTML + text', async () => {
    const onChangeContent = vi.fn();
    const { ref } = setup({ initialContent: '<p><strong>draft</strong></p>', onChangeContent });
    await waitFor(() => expect(editorEl().innerHTML).toContain('<strong>draft</strong>'));
    act(() => ref.current!.setContent('<p><em>new</em> text</p>'));
    expect(onChangeContent).toHaveBeenLastCalledWith('<p><em>new</em> text</p>', 'new text');
    expect(ref.current!.getText()).toBe('new text');
  });

  it('applies a mark from the toolbar and reflects it with aria-pressed', async () => {
    const { ref } = setup({ initialContent: '<p>hello</p>' });
    await screen.findByRole('toolbar');
    act(() => ref.current!.focus());
    // Select the whole paragraph, then toggle bold from the toolbar.
    fireEvent.keyDown(editorEl(), { key: 'a', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    await waitFor(() => expect(ref.current!.getHTML()).toContain('<strong>hello</strong>'));
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('sends on Enter, but not on Shift+Enter', async () => {
    const onSubmit = vi.fn();
    const { ref } = setup({ initialContent: '<p>hi</p>', onSubmit });
    await screen.findByRole('toolbar');
    act(() => ref.current!.focus());
    fireEvent.keyDown(editorEl(), { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(editorEl(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('keeps Enter for new lines inside lists and code blocks, Ctrl+Enter still sends', async () => {
    const onSubmit = vi.fn();
    const { ref } = setup({ initialContent: '<ul><li><p>item</p></li></ul>', onSubmit });
    await screen.findByRole('toolbar');
    act(() => ref.current!.focus());
    fireEvent.keyDown(editorEl(), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(editorEl(), { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('hands pasted files to the composer instead of inserting them', async () => {
    const onPasteFiles = vi.fn();
    setup({ onPasteFiles });
    await screen.findByRole('toolbar');
    const file = new File(['png'], 'shot.png', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [file], types: ['Files'], getData: () => '' },
    });
    act(() => {
      editorEl().dispatchEvent(event);
    });
    expect(onPasteFiles).toHaveBeenCalledWith([file]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('only accepts web and e-mail links from the link editor', async () => {
    const { ref } = setup({ initialContent: '<p>site</p>' });
    await screen.findByRole('toolbar');
    act(() => ref.current!.focus());
    fireEvent.keyDown(editorEl(), { key: 'a', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    const input = screen.getByLabelText('Link address');
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(ref.current!.getHTML()).toContain('href="https://example.com"'));
  });

  it('reports the @query at the cursor and completes it with the chosen name (P2 mentions)', async () => {
    const onMentionQuery = vi.fn();
    const { ref } = setup({ onMentionQuery });
    await screen.findByRole('toolbar');
    act(() => ref.current!.setContent('<p>hi @al</p>'));
    act(() => ref.current!.focus());
    await waitFor(() => expect(onMentionQuery).toHaveBeenLastCalledWith('al'));
    act(() => ref.current!.completeMention('alice'));
    expect(ref.current!.getHTML()).toBe('<p>hi @alice </p>');
    await waitFor(() => expect(onMentionQuery).toHaveBeenLastCalledWith(null));
  });

  it('ignores e-mail addresses and code when looking for mentions', async () => {
    const onMentionQuery = vi.fn();
    const { ref } = setup({ onMentionQuery });
    await screen.findByRole('toolbar');
    act(() => ref.current!.setContent('<p>mail bob@exa</p>'));
    act(() => ref.current!.focus());
    act(() => ref.current!.setContent('<p><code>@al</code></p>'));
    act(() => ref.current!.focus());
    expect(onMentionQuery).not.toHaveBeenCalledWith('exa');
    expect(onMentionQuery).not.toHaveBeenCalledWith('al');
  });

  it('lets an open mention list take Enter instead of sending', async () => {
    const onSubmit = vi.fn();
    const onMentionKey = vi.fn((key: string) => key === 'Enter');
    const { ref } = setup({ initialContent: '<p>@al</p>', onSubmit, onMentionKey });
    await screen.findByRole('toolbar');
    act(() => ref.current!.focus());
    fireEvent.keyDown(editorEl(), { key: 'Enter' });
    expect(onMentionKey).toHaveBeenCalledWith('Enter');
    expect(onSubmit).not.toHaveBeenCalled();
    onMentionKey.mockReturnValue(false);
    fireEvent.keyDown(editorEl(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
