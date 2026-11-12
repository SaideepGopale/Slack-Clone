import { AxiosError, InternalAxiosRequestConfig } from 'axios';

/**
 * P1-E (FA-SEC-04) safety net: a request whose path contains a dot segment is
 * rejected before it is sent.
 *
 * Browsers resolve "." and ".." segments before sending a request, so a value
 * put into a path — "/api/invitations/accept/" + "../../admin/users/<id>/ban"
 * — can silently become a different endpoint ("/api/admin/users/<id>/ban").
 * No legitimate request in this app has a dot segment in its path (ids are
 * UUIDs and other values are encodeURIComponent-ed), so rejecting them breaks
 * nothing and closes the whole class, not just the invitation pages.
 *
 * Checked the way the URL parser sees the path: tabs/newlines are dropped,
 * the path ends at the first "?" or "#" (queries and fragments are never
 * checked), "/" and "\" both separate segments, and ".", "..", ".%2e",
 * "%2e.", "%2e%2e" (any case) are dot segments. Each segment is also checked
 * once percent-decoded, so dots hidden behind an encoded separator
 * ("..%2F..%2Fadmin") or a second layer of encoding ("%252e%252e") are caught.
 * URLs are only checked, never rewritten.
 */

const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
const SEPARATORS = /[/\\]/;

const pathOf = (url: string) => {
  const withoutControls = url.replace(/[\t\n\r]/g, '');
  const beforeQuery = withoutControls.split(/[?#]/, 1)[0];
  const authority = /^(?:[a-z][a-z\d+.-]*:)?[/\\]{2}[^/\\]*/i.exec(beforeQuery); // "scheme://host" or "//host"
  return authority ? beforeQuery.slice(authority[0].length) : beforeQuery;
};

const decodeOnce = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed encoding is left to the server; it can't form a dot segment by itself
  }
};

/** True when the URL's path contains a dot segment in any spelling the browser (or a server) would resolve. */
export const hasPathTraversal = (url: string): boolean =>
  pathOf(url)
    .split(SEPARATORS)
    .some((segment) => DOT_SEGMENT.test(segment) || decodeOnce(segment).split(SEPARATORS).some((part) => DOT_SEGMENT.test(part)));

/** Axios request interceptor: refuse the request before dispatch (registered asynchronously, so a throw stops it). */
export const rejectPathTraversal = (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
  for (const value of [config.baseURL, config.url]) {
    if (typeof value === 'string' && hasPathTraversal(value)) {
      throw new AxiosError('Blocked a request whose URL path contains a "." or ".." segment.', 'ERR_PATH_TRAVERSAL', config);
    }
  }
  return config;
};
