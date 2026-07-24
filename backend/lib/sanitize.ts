import sanitizeHtml from 'sanitize-html';

// The rich text editor's own UI only lets a user produce a narrow set of
// marks (bold/italic/strike + paragraph text-align) — but message:send is a
// socket event, not a form submission: nothing stops a client from bypassing
// the editor entirely and emitting arbitrary HTML directly. This is the
// actual security boundary, run server-side on every write, not just relied
// on client-side.
export const sanitizeMessageHtml = (dirty: string): string =>
  sanitizeHtml(dirty, {
    allowedTags: ['p', 'strong', 'em', 's', 'br'],
    allowedAttributes: {
      p: ['style'],
    },
    // Restrict to the exact values the alignment toolbar can produce —
    // deliberately not a generic "allow any CSS" rule, which would let
    // `style` become a fresh injection surface of its own (e.g.
    // `expression()`/url() tricks in older engines, or just layout abuse).
    allowedStyles: {
      p: {
        'text-align': [/^left$/, /^center$/, /^right$/, /^justify$/],
      },
    },
    disallowedTagsMode: 'discard',
  });
