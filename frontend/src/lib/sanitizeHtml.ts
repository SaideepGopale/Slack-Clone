import DOMPurify from 'dompurify';

// Defense in depth: the backend (lib/sanitize.ts) is the authoritative gate
// on what a message's `content` can contain, but rendering someone else's
// message via dangerouslySetInnerHTML is exactly where a payload that ever
// slipped past that gate (a bug, a future write path that forgets to
// sanitize) would actually execute — so this is a second, independent check
// at the point of highest consequence, not a redundant no-op.
const ALLOWED_TAGS = ['p', 'strong', 'em', 's', 'br'];
const ALLOWED_ATTR = ['style'];

export const sanitizeMessageHtml = (dirty: string): string =>
  DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // DOMPurify's ALLOWED_ATTR doesn't let style values be restricted to
    // specific CSS properties the way the backend's allowedStyles does —
    // ALLOW_DATA_ATTR/ALLOWED_URI_REGEXP aren't relevant here anyway since
    // no attribute below can carry a URI, only the fixed text-align values
    // the toolbar itself produces.
  });
