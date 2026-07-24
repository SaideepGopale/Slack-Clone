import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { AuthenticatedRequest, authenticate } from '../../middleware/auth.middleware';
import { upload } from './upload.middleware';

const router = Router();

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
router.post('/upload', authenticate, upload.single('attachment'), (req: AuthenticatedRequest, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file was uploaded.' });
  }

  const { path: url, originalname: name, mimetype: type } = req.file;
  return res.status(200).json({ success: true, url, name, type });
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
export const handleUploadErrors = (err: unknown, _req: Request, res: Response, next: NextFunction) => {
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
