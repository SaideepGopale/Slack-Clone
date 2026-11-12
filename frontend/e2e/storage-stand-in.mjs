/**
 * E2E only — a local stand-in for the two Cloudinary HTTP endpoints the app
 * uses, so tests can send real files without cloud credentials:
 *
 *   POST /v1_1/<cloud>/<resource_type>/upload    signed upload (multipart)
 *   GET  /v1_1/<cloud>/<resource_type>/download  signed, expiring private download
 *
 * The backend reaches it through the Cloudinary SDK's standard `upload_prefix`
 * setting (CLOUDINARY_URL in playwright.config.ts); no application code knows
 * it exists. It verifies request signatures with the SDK's own signing
 * function and the configured secret, refuses expired or tampered download
 * links, and keeps files in memory for the lifetime of the test run.
 *
 * Test controls (never part of the app):
 *   POST /__stand-in/fail-next-upload?status=503   the next upload fails with that status
 *   GET  /__stand-in/assets                          what is stored (no file bytes)
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('../../backend/package.json', import.meta.url)));
const { utils } = require('cloudinary').v2;

const PORT = Number(process.env.STORAGE_STAND_IN_PORT);
const CLOUD = process.env.STORAGE_STAND_IN_CLOUD;
const API_KEY = process.env.STORAGE_STAND_IN_API_KEY;
const SECRET = process.env.STORAGE_STAND_IN_SECRET;
if (!PORT || !CLOUD || !API_KEY || !SECRET) throw new Error('storage stand-in: STORAGE_STAND_IN_PORT/CLOUD/API_KEY/SECRET are required');

const assets = new Map(); // `${resourceType}:${type}:${publicId}` → { bytes, format, contentType }
const failures = []; // queued upload failures (HTTP status codes)

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const error = (res, status, message) => json(res, status, { error: { message } });

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/** Minimal multipart/form-data parser: { fields, file } (file = { name, bytes }). */
const parseMultipart = (body, contentType) => {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const fields = {};
  let file = null;
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const part = body.subarray(start + delimiter.length + 2, next - 2); // skip CRLF after delimiter, before next
    const split = part.indexOf('\r\n\r\n');
    if (split !== -1) {
      const head = part.subarray(0, split).toString('utf8');
      const value = part.subarray(split + 4);
      const name = /name="([^"]*)"/i.exec(head)?.[1];
      const filename = /filename="([^"]*)"/i.exec(head)?.[1];
      if (name === 'file' || filename !== undefined) file = { name: filename ?? 'file', bytes: value };
      else if (name) fields[name] = value.toString('utf8');
    }
    start = next;
  }
  return { fields, file };
};

const startsWith = (b, sig, offset = 0) => sig.every((x, i) => b[offset + i] === x);
/** What Cloudinary's `resource_type: auto` would decide, plus the format it reports. */
const classify = (b) => {
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { resourceType: 'video', format: 'webm', contentType: 'audio/webm' };
  if (startsWith(b, [0x4f, 0x67, 0x67, 0x53])) return { resourceType: 'video', format: 'ogg', contentType: 'audio/ogg' };
  if (startsWith(b, [0x66, 0x74, 0x79, 0x70], 4)) return { resourceType: 'video', format: 'mp4', contentType: 'audio/mp4' };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return { resourceType: 'image', format: 'png', contentType: 'image/png' };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { resourceType: 'image', format: 'jpg', contentType: 'image/jpeg' };
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46])) return { resourceType: 'image', format: 'pdf', contentType: 'application/pdf' };
  return { resourceType: 'raw', format: null, contentType: 'application/octet-stream' };
};

/** True when `params` carry a valid SDK signature (everything but api_key/signature is signed). */
const signedCorrectly = (params) => {
  const { signature, api_key: apiKey, ...signed } = params;
  if (apiKey !== API_KEY || typeof signature !== 'string') return false;
  return utils.api_sign_request(utils.clear_blank(signed), SECRET) === signature;
};

const upload = async (req, res, cloud, requestedType) => {
  const body = await readBody(req);
  if (cloud !== CLOUD) return error(res, 401, `Invalid cloud_name ${cloud}`);
  const failure = failures.shift();
  if (failure) return error(res, failure, 'Simulated storage failure');
  const form = parseMultipart(body, req.headers['content-type']);
  if (!form?.file) return error(res, 400, 'Missing required parameter - file');
  if (form.fields.api_key !== API_KEY) return error(res, 401, `Unknown API key ${form.fields.api_key}`);
  if (!signedCorrectly(form.fields)) return error(res, 401, 'Invalid Signature');
  const kind = classify(form.file.bytes);
  const resourceType = requestedType === 'auto' ? kind.resourceType : requestedType;
  const type = form.fields.type || 'upload';
  const publicId = [form.fields.folder, form.fields.public_id || createHash('sha1').update(form.file.bytes).digest('hex').slice(0, 20)].filter(Boolean).join('/');
  assets.set(`${resourceType}:${type}:${publicId}`, { bytes: form.file.bytes, format: kind.format, contentType: kind.contentType });
  const version = Math.floor(Date.now() / 1000);
  return json(res, 200, {
    public_id: publicId,
    version,
    resource_type: resourceType,
    type,
    ...(kind.format ? { format: kind.format } : {}),
    bytes: form.file.bytes.length,
    created_at: new Date().toISOString(),
    secure_url: `http://127.0.0.1:${PORT}/${CLOUD}/${resourceType}/${type}/v${version}/${publicId}${kind.format ? `.${kind.format}` : ''}`,
  });
};

const download = (req, res, cloud, resourceType, query) => {
  const params = Object.fromEntries(query);
  if (cloud !== CLOUD || !signedCorrectly(params)) return error(res, 401, 'Invalid Signature');
  if (!params.expires_at || Number(params.expires_at) * 1000 < Date.now()) return error(res, 401, 'Link expired');
  const asset = assets.get(`${resourceType}:${params.type || 'upload'}:${params.public_id}`);
  if (!asset || (params.format && asset.format && params.format !== asset.format)) return error(res, 404, 'Resource not found');
  const headers = {
    'Content-Type': asset.contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=60',
    'Access-Control-Allow-Origin': '*',
    ...(params.attachment ? { 'Content-Disposition': 'attachment' } : {}),
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  const size = asset.bytes.length;
  if (range) {
    const startByte = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    const endByte = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
    if (startByte >= size || startByte > endByte) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${startByte}-${endByte}/${size}`, 'Content-Length': endByte - startByte + 1 });
    return res.end(req.method === 'HEAD' ? undefined : asset.bytes.subarray(startByte, endByte + 1));
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  return res.end(req.method === 'HEAD' ? undefined : asset.bytes);
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const api = /^\/v1_1\/([^/]+)\/([^/]+)\/(upload|download)$/.exec(url.pathname);
  Promise.resolve()
    .then(() => {
      if (api && api[3] === 'upload' && req.method === 'POST') return upload(req, res, api[1], api[2]);
      if (api && api[3] === 'download' && (req.method === 'GET' || req.method === 'HEAD')) return download(req, res, api[1], api[2], url.searchParams);
      if (url.pathname === '/__stand-in/fail-next-upload' && req.method === 'POST') {
        failures.push(Number(url.searchParams.get('status') ?? 503));
        return json(res, 200, { queued: failures.length });
      }
      if (url.pathname === '/__stand-in/assets' && req.method === 'GET') {
        return json(res, 200, [...assets.entries()].map(([key, a]) => ({ key, format: a.format, bytes: a.bytes.length, contentType: a.contentType })));
      }
      return error(res, 404, 'Not found');
    })
    .catch((err) => error(res, 500, String(err?.message ?? err)));
}).listen(PORT, '127.0.0.1', () => console.log(`storage stand-in on http://127.0.0.1:${PORT}`));
