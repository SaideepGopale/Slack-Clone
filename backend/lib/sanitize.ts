import sanitizeHtml from 'sanitize-html';

// The rich text editor's own UI only lets a user produce a narrow set of
// marks (bold/italic/strike + paragraph text-align) — but message:send is a
// socket event, not a form submission: nothing stops a client from bypassing
// the editor entirely and emitting arbitrary HTML directly. This is the
// actual security boundary, run server-side on every write, not just relied
// on client-side.
// P2: the full set the composer produces — marks (bold, italic, underline,
// strike, inline code, links), blocks (paragraphs, headings 1–3, bullet and
// ordered lists, quotes, code blocks) and paragraph/heading alignment.
// Everything else is still discarded. frontend/src/lib/sanitizeHtml.ts mirrors
// this list for rendering; this server-side pass is the security boundary.
const ALIGN = { 'text-align': [/^left$/, /^center$/, /^right$/, /^justify$/] };

export const sanitizeMessageHtml = (dirty: string): string =>
  sanitizeHtml(dirty, {
    allowedTags: ['p', 'strong', 'em', 'u', 's', 'br', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3'],
    allowedAttributes: {
      p: ['style'],
      h1: ['style'],
      h2: ['style'],
      h3: ['style'],
      a: ['href', 'target', 'rel'],
      code: ['class'],
    },
    // Links: web and e-mail only — no javascript:, data:, or protocol-relative URLs.
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    // Code-block language hints only (e.g. "language-ts").
    allowedClasses: { code: [/^language-[a-z0-9+#-]{1,30}$/] },
    // Restrict to the exact values the alignment toolbar can produce —
    // deliberately not a generic "allow any CSS" rule, which would let
    // `style` become a fresh injection surface of its own (e.g.
    // `expression()`/url() tricks in older engines, or just layout abuse).
    allowedStyles: { p: ALIGN, h1: ALIGN, h2: ALIGN, h3: ALIGN },
    // Every link opens safely in a new tab, whatever the client sent.
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...(attribs.href ? { href: attribs.href } : {}), target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
    },
    disallowedTagsMode: 'discard',
  });

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};

const decodeEntities = (text: string): string =>
  text
    .replace(/&(amp|lt|gt|quot|nbsp|#39|#x27);/g, (entity) => ENTITY_MAP[entity] ?? entity)
    .replace(/&#(\d{1,6});/g, (_m, code) => String.fromCodePoint(Number(code)));

/**
 * Plain-text rendering of stored message HTML — for previews (DM list, search
 * snippets, notifications) and for "is this message actually empty?" checks.
 * Block-level closers become spaces so "<p>a</p><p>b</p>" reads "a b", not "ab".
 */
export const htmlToPlainText = (html: string | null | undefined): string => {
  if (!html) return '';
  const withBreaks = html.replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>|<br\s*\/?>/gi, ' ');
  const stripped = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} });
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
};
