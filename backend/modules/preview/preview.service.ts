import * as cheerio from 'cheerio';
import { BlockedUrlError, fetchPublicPage } from './safeFetch';

export interface LinkPreview {
  title: string;
  description: string;
  image: string;
  url: string;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, { value: LinkPreview; expiresAt: number }>();

const remember = (key: string, value: LinkPreview) => {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
};

const fallback = (url: string): LinkPreview => ({ title: url, description: '', image: '', url });

const clip = (value: string | undefined, max: number) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const absoluteHttpUrl = (raw: string | undefined, base: URL): string => {
  if (!raw) return '';
  try {
    const resolved = new URL(raw, base);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.toString() : '';
  } catch {
    return '';
  }
};

/**
 * OpenGraph/meta preview for a public URL. BlockedUrlError propagates (the
 * route turns it into a 400); any other failure degrades to the bare-URL
 * fallback the UI already treats as "no preview".
 */
export const getLinkPreview = async (rawUrl: string): Promise<LinkPreview> => {
  const cached = cache.get(rawUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const page = await fetchPublicPage(rawUrl);
    if (!/text\/html|application\/xhtml\+xml/i.test(page.contentType)) {
      const value = fallback(rawUrl);
      remember(rawUrl, value);
      return value;
    }
    const $ = cheerio.load(page.body);
    const meta = (name: string) =>
      $(`meta[property="og:${name}"]`).attr('content') || $(`meta[name="${name}"]`).attr('content');
    const value: LinkPreview = {
      title: clip(meta('title') || $('title').first().text(), 300) || rawUrl,
      description: clip(meta('description'), 500),
      image: absoluteHttpUrl(meta('image'), page.finalUrl),
      url: rawUrl,
    };
    remember(rawUrl, value);
    return value;
  } catch (err) {
    if (err instanceof BlockedUrlError) throw err;
    const value = fallback(rawUrl);
    remember(rawUrl, value);
    return value;
  }
};

/** Test hook. */
export const clearPreviewCache = () => cache.clear();
