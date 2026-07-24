import { v2 as cloudinary } from 'cloudinary';
import type { Request } from 'express';
import multer, { StorageEngine } from 'multer';
import { CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_CLOUD_NAME } from '../../config/env';

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure: true,
});

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB — accommodates larger presentations/videos

// Never trust the file extension — only these exact mimetypes are accepted.
// The multipart Content-Type header is client-reported (not a cryptographic
// guarantee the bytes match), but rejecting everything outside this
// whitelist closes off the large majority of malicious-upload vectors
// (executables, scripts, HTML with embedded XSS, etc.) before a single byte
// ever reaches Cloudinary.
//
// image/svg+xml is deliberately included per spec, but is worth flagging:
// SVGs can embed <script> tags/event handlers and are a known XSS vector if
// ever rendered inline rather than downloaded — that's a "how we serve files
// back" concern, not something this whitelist alone can close off.
//
// application/octet-stream is ALSO included per spec, and deserves a much
// louder flag: it's the generic "unknown binary data" fallback — plenty of
// legitimate Office files get reported as this by inconsistent OS/browser
// mime registries, but it's just as often what a renamed/disguised
// executable or arbitrary binary reports as, since it's the fallback for
// literally anything the client doesn't recognize. Allowing it measurably
// weakens what this whitelist protects against. Included because it was
// explicitly requested, not because it's risk-free.
const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml',
  // Videos
  'video/mp4', 'video/webm', 'video/quicktime',
  // Audio / voice notes
  'audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/wav',
  'audio/mp3', 'audio/mpeg', 'audio/m4a', 'audio/x-m4a', 'audio/aac',
  // PDFs
  'application/pdf',
  // Excel
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv',
  // Word
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // PowerPoint
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Text & archives
  'text/plain', 'application/zip', 'application/x-zip-compressed',
  // Generic fallback — see the comment above this Set.
  'application/octet-stream',
]);

// Fallback extension-by-mimetype, used ONLY when the incoming filename has no
// extension at all (e.g. a raw Blob upload named "blob" with no File
// wrapper). This codebase's own voice-note recorder already names its Blob
// properly (see ChatArea.tsx: `new File([blob], 'voice-<ts>.webm', ...)`),
// so this mainly guards against a future/other client that appends a bare
// Blob without a filename — cheap insurance, not the primary fix.
const EXTENSION_BY_MIMETYPE: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/mp3': '.mp3',
  'audio/mpeg': '.mp3',
  'audio/m4a': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
};

// Strips everything except alphanumerics/dash/underscore from the original
// filename (spaces, unicode, path separators, "..", etc.) before it becomes
// part of the Cloudinary public_id — untrusted user input must never flow
// unescaped into a resource identifier that's also a URL path segment.
// Extension is returned separately (see buildPublicId below) rather than
// stripped and discarded.
const sanitizeFilename = (originalname: string): string => {
  const withoutExtension = originalname.replace(/\.[^/.]+$/, '');
  const sanitized = withoutExtension.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
  return sanitized || 'file';
};

const getExtension = (originalname: string, mimetype: string): string => {
  if (originalname.includes('.')) {
    return originalname.slice(originalname.lastIndexOf('.'));
  }
  // No extension in the filename at all (e.g. "blob") — fall back to the
  // mimetype, stripping any ";codecs=..." parameter first.
  const baseMimetype = mimetype.split(';')[0].trim();
  return EXTENSION_BY_MIMETYPE[baseMimetype] ?? '';
};

// For resource_type: 'auto', Cloudinary only auto-appends a format suffix to
// the delivery URL for image/video assets (it tracks the detected format
// separately and always adds it, regardless of what's in public_id) —
// everything else (including audio, which resolves to 'video' internally at
// Cloudinary but is worth double-checking per account config) or 'raw'
// resolves with the public_id AS the literal filename in the URL, nothing
// added on top. Without embedding the extension ourselves, a raw upload's
// URL has no file extension at all — verified live earlier: an uploaded .txt
// produced a URL with no ".txt" at the end, breaking "open with the right
// app" for anyone who downloads the link.
//
// This can't be applied unconditionally, though: doing the same for
// image/video would double up (Cloudinary already appends its own detected
// format, so embedding ".png" too would produce "photo-123.png.png"). Only
// non-image/video mimetypes get the extension embedded here.
const isImageOrVideo = (mimetype: string): boolean => mimetype.startsWith('image/') || mimetype.startsWith('video/');

const buildPublicId = (originalname: string, mimetype: string): string => {
  const base = `${sanitizeFilename(originalname)}-${Date.now()}`;
  if (isImageOrVideo(mimetype)) return base;
  return `${base}${getExtension(originalname, mimetype)}`;
};

/**
 * Hand-rolled multer StorageEngine rather than the community
 * `multer-storage-cloudinary` package: that package peer-depends on
 * Cloudinary v1 and hasn't been published since 2022, which hard-conflicts
 * with the v2 SDK used here (`npm install` refuses to resolve both without
 * --legacy-peer-deps, which would just force together an abandoned
 * dependency never tested against v2). This engine does exactly what that
 * package would have: pipe the incoming multipart file stream straight into
 * Cloudinary's own upload stream, so the file body never touches local disk.
 *
 * No `allowed_formats` param here on purpose — Cloudinary's allowed_formats
 * is an image-transformation-pipeline concept and silently misbehaves for
 * audio/raw resource types under `resource_type: 'auto'`. All type
 * validation happens once, up front, in multer's fileFilter below.
 */
class CloudinaryStorage implements StorageEngine {
  _handleFile(
    _req: Request,
    file: Express.Multer.File,
    callback: (error?: any, info?: Partial<Express.Multer.File>) => void
  ): void {
    const publicId = buildPublicId(file.originalname, file.mimetype);

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'workspace-uploads',
        public_id: publicId,
        // 'auto' lets Cloudinary route the file to the correct resource type
        // internally (image / video / raw) — the default ('image') rejects
        // PDFs, audio, and other documents outright.
        resource_type: 'auto',
      },
      (error, result) => {
        if (error || !result) {
          callback(error ?? new Error('Cloudinary upload returned no result.'));
          return;
        }

        callback(null, {
          // The field the route handler reads as req.file.path — Cloudinary's
          // secure (https) delivery URL for the uploaded asset.
          path: result.secure_url,
          filename: result.public_id,
          size: result.bytes,
        });
      }
    );

    file.stream.pipe(uploadStream);
  }

  _removeFile(_req: Request, file: Express.Multer.File, callback: (error: Error | null) => void): void {
    // `filename` here is the Cloudinary public_id set in _handleFile's
    // callback above — used if a later file in the same request fails and
    // multer needs to clean up ones that already succeeded.
    const publicId = file.filename;
    if (!publicId) {
      callback(null);
      return;
    }
    cloudinary.uploader.destroy(publicId, (error) => callback(error ?? null));
  }
}

export const upload = multer({
  storage: new CloudinaryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, callback) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      callback(null, true);
    } else {
      callback(new Error('Invalid file type. Only images, videos, audio, PDFs, Office documents (Excel, Word, PowerPoint), text, and ZIP files are allowed.'));
    }
  },
});
