import axios from 'axios';
import { AlertCircle, Download, FileText, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isPreviewableImage } from '../../lib/chatPresentation';
import { parseWaveform } from '../../lib/voice';
import { VoiceMessagePlayer } from './voice/VoiceMessagePlayer';

/**
 * T.32 (audit H3) — private attachments. Files sent after T.32 are referenced
 * as "/api/attachments/<id>": the browser asks the API (with the session
 * token) for a short-lived signed link and only then loads the file, so a
 * file is only reachable by people who can see its message. Older messages
 * carry a direct (public) Cloudinary URL and render exactly as before.
 */
export const ATTACHMENT_PATH = /^\/api\/attachments\/[0-9a-f-]{36}$/i;
export const isPrivateAttachment = (fileUrl: string | null | undefined): fileUrl is string => !!fileUrl && ATTACHMENT_PATH.test(fileUrl);

interface SignedLink {
  url: string;
  expiresAt: string;
  // T.33: recorded with voice notes (absent for other files and older notes).
  durationMs?: number | null;
  waveform?: string | null;
}

export interface AttachmentMeta {
  durationMs: number | null;
  waveform: number[] | null;
}

// One signed link per attachment, reused until shortly before it expires.
const cache = new Map<string, { link: SignedLink; pending?: undefined } | { pending: Promise<SignedLink>; link?: undefined }>();
const FRESH_MARGIN_MS = 60_000;

const isFresh = (link: SignedLink) => new Date(link.expiresAt).getTime() - Date.now() > FRESH_MARGIN_MS;

export const fetchSignedLink = (path: string, download = false): Promise<SignedLink> => {
  if (download) return axios.get<SignedLink>(path, { params: { download: 1 } }).then((r) => r.data);
  const hit = cache.get(path);
  if (hit?.link && isFresh(hit.link)) return Promise.resolve(hit.link);
  if (hit?.pending) return hit.pending;
  const pending = axios
    .get<SignedLink>(path)
    .then((r) => {
      cache.set(path, { link: r.data });
      return r.data;
    })
    .catch((err) => {
      cache.delete(path);
      throw err;
    });
  cache.set(path, { pending });
  return pending;
};

/** Test hook. */
export const clearAttachmentLinkCache = () => cache.clear();

/** The URL to load for a message's file (signed for private attachments). */
export const useAttachmentUrl = (fileUrl: string | null | undefined) => {
  const [state, setState] = useState<{ url: string | null; error: boolean; meta?: AttachmentMeta }>(() => ({
    url: isPrivateAttachment(fileUrl) ? null : fileUrl ?? null,
    error: false,
  }));

  useEffect(() => {
    if (!isPrivateAttachment(fileUrl)) {
      setState({ url: fileUrl ?? null, error: false });
      return;
    }
    let cancelled = false;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetchSignedLink(fileUrl).then(
        (link) => {
          if (cancelled) return;
          setState({
            url: link.url,
            error: false,
            meta: { durationMs: typeof link.durationMs === 'number' ? link.durationMs : null, waveform: parseWaveform(link.waveform) },
          });
          // Re-sign shortly before expiry so a long-open view keeps working.
          const delay = Math.max(new Date(link.expiresAt).getTime() - Date.now() - FRESH_MARGIN_MS, 30_000);
          refresh = setTimeout(load, delay);
        },
        () => {
          if (!cancelled) setState({ url: null, error: true });
        }
      );
    };
    setState({ url: null, error: false });
    load();
    return () => {
      cancelled = true;
      if (refresh) clearTimeout(refresh);
    };
  }, [fileUrl]);

  return state;
};

/** Opens a download of the file (a fresh signed link with a "save as" disposition). */
export const downloadAttachment = async (fileUrl: string) => {
  if (!isPrivateAttachment(fileUrl)) {
    window.open(fileUrl, '_blank', 'noopener,noreferrer');
    return;
  }
  const link = await fetchSignedLink(fileUrl, true);
  window.open(link.url, '_blank', 'noopener,noreferrer');
};

interface MessageAttachmentProps {
  fileUrl: string;
  fileName?: string | null;
  fileType?: string | null;
  /** Voice-note style (audio player). */
  audio?: boolean;
  compact?: boolean;
}

const Unavailable = () => (
  <span className="inline-flex items-center gap-1.5 text-xs text-fg-subtle">
    <AlertCircle size={14} aria-hidden="true" /> This file is no longer available.
  </span>
);

export const MessageAttachment = ({ fileUrl, fileName, fileType, audio = false, compact = false }: MessageAttachmentProps) => {
  const { url, error, meta } = useAttachmentUrl(fileUrl);
  const [downloading, setDownloading] = useState(false);
  const label = fileName || 'file';

  const download = async () => {
    setDownloading(true);
    try {
      await downloadAttachment(fileUrl);
    } finally {
      setDownloading(false);
    }
  };

  if (error) return <div className="mt-2"><Unavailable /></div>;

  if (audio) {
    // T.33: waveform player (seek, speed, download) for voice notes.
    return (
      <VoiceMessagePlayer
        src={url}
        durationMs={meta?.durationMs}
        waveform={meta?.waveform}
        label={`Voice message ${label}`}
        onDownload={() => void download()}
        downloading={downloading}
      />
    );
  }

  if (isPreviewableImage(fileType, fileUrl)) {
    if (!url) {
      return <div className={`mt-2 animate-pulse rounded-lg bg-surface-tertiary ${compact ? 'h-32 w-48' : 'h-48 w-72'} max-w-full`} aria-label={`Loading ${label}`} />;
    }
    return (
      <a href={url} target="_blank" rel="noreferrer noopener" className="mt-2 block w-fit max-w-full" title={`Open ${label}`}>
        <img
          src={url}
          alt={fileName ?? 'Shared image'}
          loading="lazy"
          className={`${compact ? 'max-h-60' : 'max-h-80 sm:max-w-md'} max-w-full rounded-lg border border-line object-contain bg-surface-secondary`}
        />
      </a>
    );
  }

  return (
    <div className={`mt-2 flex max-w-md items-center justify-between gap-3 rounded-lg border border-line bg-surface-secondary ${compact ? 'p-2' : 'p-3'} transition-colors hover:border-border-strong`}>
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand" aria-hidden="true">
          <FileText size={18} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-fg">{label}</div>
          {fileType && <div className="mt-0.5 truncate text-xs text-fg-subtle">{fileType}</div>}
        </div>
      </div>
      {isPrivateAttachment(fileUrl) ? (
        // Private: a fresh signed "save as" link is fetched on click.
        <button
          type="button"
          onClick={download}
          disabled={downloading}
          aria-label={`Download ${label}`}
          title={`Download ${label}`}
          className="rounded-lg p-2 text-brand transition-colors hover:bg-brand-soft disabled:opacity-50"
        >
          {downloading ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : <Download size={18} aria-hidden="true" />}
        </button>
      ) : (
        // Older public files: a plain link, as before.
        <a
          href={fileUrl}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`Download ${label}`}
          title={`Download ${label}`}
          className="rounded-lg p-2 text-brand transition-colors hover:bg-brand-soft"
        >
          <Download size={18} aria-hidden="true" />
        </a>
      )}
    </div>
  );
};
