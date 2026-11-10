import dotenv from 'dotenv';
import { corsOrigins, DEV_APP_URL, normalizeAppUrl, trustProxySetting } from './deployment';

dotenv.config();

export const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Exiting.');
  process.exit(1);
}

export const PORT = Number(process.env.PORT) || 3000;
export const NODE_ENV = process.env.NODE_ENV || 'development';

// The frontend's public origin: the CORS / Socket.IO origin and the base of every
// link the backend sends (invitations, activation, password reset). Required in
// production (on Render: the frontend static site's URL); locally it defaults to
// the Vite dev server.
const appUrl = normalizeAppUrl(process.env.APP_URL);
if (process.env.APP_URL && !appUrl) {
  console.error('FATAL: APP_URL must be an absolute http(s) URL such as https://smartconnect-frontend.onrender.com. Exiting.');
  process.exit(1);
}
if (NODE_ENV === 'production' && !appUrl) {
  console.error('FATAL: APP_URL (the frontend URL) must be set in production. Exiting.');
  process.exit(1);
}
export const APP_URL = appUrl ?? DEV_APP_URL;
export const ALLOWED_ORIGINS = corsOrigins(NODE_ENV, APP_URL);
export const TRUST_PROXY = trustProxySetting(NODE_ENV, process.env.TRUST_PROXY);

// Fail fast rather than let every upload silently 500 the first time someone
// attaches a file — same reasoning as JWT_SECRET above.
export const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
export const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
export const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.error('FATAL: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET must all be set. Exiting.');
  process.exit(1);
}
