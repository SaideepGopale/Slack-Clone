import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { requireSessionUser } from '../../middleware/identity.middleware';
import { userRateLimit } from '../../middleware/userRateLimit.middleware';
import { attachmentPath, cleanOriginalName, destroyAttachments, loadVisibleAttachment, signedAttachmentUrl } from '../../lib/attachments';
import { prisma } from '../../lib/prisma';
import { StoredAsset, upload } from './upload.middleware';

const router = Router();

/** T.33: optional voice-note fields sent with an audio upload. */
export const parseVoiceMetadata = (body: unknown): { durationMs: number | null; waveform: string | null } => {
  const fields = (body ?? {}) as Record<string, unknown>;
  const ms = Number(fields.durationMs);
  const durationMs = typeof fields.durationMs === 'string' && /^\d{1,7}$/.test(fields.durationMs) && ms <= 3_600_000 ? ms : null;
  const raw = typeof fields.waveform === 'string' ? fields.waveform : '';
  const parts = raw ? raw.split(',') : [];
  const waveform = parts.length > 0 && parts.length <= 64 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 100) ? parts.join(',') : null;
  return { durationMs, waveform };
};

/**
 * P3: uploads are limited per user (after authentication, before a byte is
 * streamed to storage) so one account can't exhaust the storage quota.
 */
export const UPLOAD_LIMIT = { max: 60, windowMs: 10 * 60_000 } as const;
const uploadLimiter = userRateLimit(UPLOAD_LIMIT.max, UPLOAD_LIMIT.windowMs, 'Too many uploads. Please wait a few minutes and try again.');

// POST /api/upload — multipart file upload, streamed straight to Cloudinary
// (see upload.middleware.ts, which never touches local disk). Authenticated:
// an unauthenticated upload endpoint lets anyone burn this app's storage/
// bandwidth quota with zero accountability.
//
// Field name is 'attachment' — this MUST match what the frontend sends
// (ChatArea.tsx's formData.append('attachment', ...)). A mismatch here is
// exactly what was silently breaking every upload (voice notes included)
// before both sides were aligned on this name: multer rejects any field name
// it isn't expecting with a MulterError('LIMIT_UNEXPECTED_FILE'), which
// looks identical to "no file sent" from the caller's side unless you go
// looking for it specifically.
router.post('/upload', ...requireSessionUser, uploadLimiter, upload.single('attachment'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file was uploaded.' });
  }
  const stored = (req.file as Express.Multer.File & { stored?: StoredAsset }).stored;
  if (!stored) return res.status(500).json({ success: false, message: 'File upload failed. Please try again.' });

  // T.32 (audit H3/M9): record who uploaded what at upload time. The client
  // gets an app path, not a storage URL; only this uploader can attach it.
  const name = cleanOriginalName(req.file.originalname);
  const type = req.file.mimetype;
  // T.33: a voice note's recorded length and waveform (audio only; invalid
  // values are dropped, never stored).
  const voice = type.startsWith('audio/') ? parseVoiceMetadata(req.body) : { durationMs: null, waveform: null };
  try {
    const attachment = await prisma.attachment.create({
      data: {
        publicId: stored.publicId,
        resourceType: stored.resourceType,
        deliveryType: stored.deliveryType,
        format: stored.format,
        originalName: name,
        mimeType: type,
        size: stored.bytes,
        uploaderId: req.user!.id,
        durationMs: voice.durationMs,
        waveform: voice.waveform,
      },
      select: { id: true, size: true },
    });
    return res.status(200).json({ success: true, id: attachment.id, url: attachmentPath(attachment.id), name, type, size: attachment.size });
  } catch (err) {
    // Never leave an unrecorded asset behind.
    await destroyAttachments([{ id: '', publicId: stored.publicId, resourceType: stored.resourceType, deliveryType: stored.deliveryType }]).catch(() => undefined);
    return next(err);
  }
});

// GET /api/attachments/:id[?download=1] — a short-lived signed link to a
// private upload, only for someone who may see the message it belongs to
// (or its uploader, before it is sent). 404 for anything else, so ids cannot
// be probed. Rate limited per user (each visible file asks once per ~10 min).
const attachmentLinkLimiter = userRateLimit(600, 60_000, 'Too many file requests. Please slow down.');
router.get('/attachments/:id', ...requireSessionUser, attachmentLinkLimiter, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const attachment = await loadVisibleAttachment(req.user!.id, req.params.id);
    if (!attachment) return res.status(404).json({ error: 'File not found.' });
    const link = signedAttachmentUrl(attachment, { download: req.query.download === '1' });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ ...link, name: attachment.originalName, type: attachment.mimeType, size: attachment.size, durationMs: attachment.durationMs, waveform: attachment.waveform });
  } catch (err) {
    return next(err);
  }
});

/**
 * Dedicated upload error-handling middleware — mounted immediately after
 * this router in app.ts so any error thrown by `upload.single(...)` above
 * (file too large, disallowed mimetype, wrong field name, a genuine
 * Cloudinary failure) lands here with a clean 400 instead of falling
 * through to the app's generic 500 handler. Multer's own errors are a
 * `MulterError` with a `.code`; fileFilter's rejection is a plain `Error`.
 * Anything neither of those falls through to the app's normal error
 * handler via next(err).
 */
// T.35: storage-side failures, as the Cloudinary SDK reports them. HTTP
// rejections carry `http_code` (401/403/404: the server's own credentials or
// cloud name are wrong, e.g. placeholder values in a local .env; 420, 499
// timeout, 5xx: Cloudinary is struggling). Network failures are Node errors
// with a `code`. None of these is a problem with the user's file, and the
// provider's text can name the API key in use, so the user gets a plain 503;
// the reason goes to the server log only.
const STORAGE_NOT_CONFIGURED = 'File uploads are not available on this server right now. Your file was not sent.';
const STORAGE_UNAVAILABLE = 'File storage is temporarily unavailable. Your file was not sent — please try again.';
const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']);

const storageFailure = (err: unknown): 'credentials' | 'unavailable' | null => {
  const httpCode = (err as { http_code?: unknown })?.http_code;
  if (typeof httpCode === 'number') {
    if (httpCode === 401 || httpCode === 403 || httpCode === 404) return 'credentials';
    if (httpCode === 400) return null; // storage refused this particular file: a file problem
    return 'unavailable';
  }
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code) ? 'unavailable' : null;
};

export const handleUploadErrors = (err: unknown, _req: Request, res: Response, next: NextFunction) => {
  const storage = storageFailure(err);
  if (storage === 'credentials') {
    console.error(`Upload failed: storage rejected the server's credentials (HTTP ${(err as { http_code: number }).http_code}). Check CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.`);
    return res.status(503).json({ success: false, message: STORAGE_NOT_CONFIGURED });
  }
  if (storage === 'unavailable') {
    console.error('Upload failed: file storage unavailable:', (err as { message?: string })?.message ?? err);
    res.setHeader('Retry-After', '30');
    return res.status(503).json({ success: false, message: STORAGE_UNAVAILABLE });
  }

  if (err instanceof multer.MulterError) {
    const friendlyMessages: Partial<Record<string, string>> = {
      LIMIT_FILE_SIZE: 'File is too large. Maximum size is 25MB.',
      LIMIT_UNEXPECTED_FILE: 'Upload rejected: unexpected field name.',
    };
    console.error('Multer upload error:', err.code, err.message);
    return res.status(400).json({ success: false, message: friendlyMessages[err.code] ?? err.message });
  }

  // Anything else reaching this middleware is either fileFilter's own
  // rejection (a real Error) or a genuine Cloudinary API rejection — e.g. an
  // account-tier size/format restriction below this app's own 25MB limit.
  // Deliberately NOT gated on `instanceof Error`: Cloudinary's SDK doesn't
  // always throw real Error instances, and one of those silently fell
  // through this exact check to the app's generic 500 handler during
  // testing (surfaced as a bare account-level file-size rejection). This
  // middleware is mounted only immediately after the upload route (see
  // app.ts), so anything arriving here is upload-related by construction —
  // safe to treat uniformly as a 400, not a server bug.
  const message = (err as { message?: string })?.message || 'File upload failed. Please try again.';
  console.error('Upload rejected:', message);
  return res.status(400).json({ success: false, message });
};

export default router;
