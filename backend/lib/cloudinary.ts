import { v2 as cloudinary } from 'cloudinary';
import { CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_CLOUD_NAME } from '../config/env';

/**
 * The one configured Cloudinary client (T.32). Previously configured as a
 * side effect of importing the upload middleware, which left modules that
 * only sign URLs or delete files (lib/attachments.ts) depending on import
 * order. Credentials come from the environment (config/env.ts refuses to
 * start without them) and are never logged.
 */
cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure: true,
});

export { cloudinary };
