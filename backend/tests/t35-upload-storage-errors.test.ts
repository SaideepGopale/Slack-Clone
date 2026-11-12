import { createServer, Server } from 'http';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { handleUploadErrors } from '../modules/uploads/message.routes';
import { uniqueEmail, uniqueUsername } from './helpers';
import { freePort, ServerProcess, startServerProcess } from './server-process';

/**
 * T.35 — sending a voice message showed "Unknown API key local-disabled":
 * the local .env holds placeholder Cloudinary values, Cloudinary rejects them
 * (HTTP 401), and the upload error handler passed Cloudinary's own text to
 * the user as a 400. That text names the API key in use, and it is a
 * server-side storage problem, not something wrong with the user's file.
 *
 * Storage rejections of the server's credentials, storage outages and network
 * failures are a 503 with a plain message and no provider text. File problems
 * (type, size, content) stay 400 with their own message.
 */

const NOT_CONFIGURED = 'File uploads are not available on this server right now. Your file was not sent.';
const UNAVAILABLE = 'File storage is temporarily unavailable. Your file was not sent — please try again.';

const run = (err: unknown) => {
  const headers: Record<string, string> = {};
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    setHeader: vi.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    }),
  };
  const next = vi.fn();
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  handleUploadErrors(err, {} as never, res as never, next);
  log.mockRestore();
  return { status: res.status.mock.calls[0]?.[0] as number | undefined, body: res.json.mock.calls[0]?.[0] as { message: string } | undefined, headers, next };
};

describe('T.35 — upload errors: storage problems are 503, file problems stay 400', () => {
  it('a storage credential rejection (401/403/404) is a 503 "not available" without the provider text', () => {
    for (const http_code of [401, 403, 404]) {
      const out = run({ message: 'Unknown API key 123456789012345', http_code, name: 'Error' });
      expect(out.status).toBe(503);
      expect(out.body).toEqual({ success: false, message: NOT_CONFIGURED });
      expect(JSON.stringify(out.body)).not.toMatch(/API key|123456789012345|cloudinary/i);
    }
  });

  it('storage outages, rate limits, timeouts and network failures are a 503 "try again" with Retry-After', () => {
    const cases: unknown[] = [
      { message: 'Server returned unexpected status code - 502', http_code: 502, name: 'UnexpectedResponse' },
      { message: 'Internal error', http_code: 500, name: 'Error' },
      { message: 'Rate Limit Exceeded', http_code: 420, name: 'Error' },
      { message: 'Request Timeout', http_code: 499, name: 'TimeoutError' },
      Object.assign(new Error('connect ECONNREFUSED 104.18.0.1:443'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('getaddrinfo ENOTFOUND api.cloudinary.com'), { code: 'ENOTFOUND' }),
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    ];
    for (const err of cases) {
      const out = run(err);
      expect(out.status).toBe(503);
      expect(out.body).toEqual({ success: false, message: UNAVAILABLE });
      expect(out.headers['retry-after']).toMatch(/^\d+$/);
      expect(JSON.stringify(out.body)).not.toMatch(/ECONN|ENOTFOUND|104\.18|cloudinary|status code/i);
    }
  });

  it('file problems keep their 400 and message (filter rejections, multer limits, storage refusing the file)', () => {
    expect(run(new Error('This file type is not allowed.'))).toMatchObject({ status: 400, body: { success: false, message: 'This file type is not allowed.' } });
    expect(run(new multer.MulterError('LIMIT_FILE_SIZE'))).toMatchObject({ status: 400, body: { success: false, message: 'File is too large. Maximum size is 25MB.' } });
    expect(run({ message: 'File size too large. Got 30000000. Maximum is 26214400.', http_code: 400, name: 'Error' })).toMatchObject({
      status: 400,
      body: { success: false, message: 'File size too large. Got 30000000. Maximum is 26214400.' },
    });
  });
});

/**
 * The real server and the real Cloudinary SDK, pointed (CLOUDINARY_URL
 * upload_prefix — a standard SDK setting) at a local endpoint that answers
 * exactly what Cloudinary answers for unknown credentials, and at a port where
 * nothing listens.
 */
describe('T.35 — real server, real SDK: what the user sees when storage refuses or is unreachable', () => {
  let fakeStorage: Server;
  let rejecting: ServerProcess;
  let unreachable: ServerProcess;
  let email = '';
  const password = 'T35-upload-pass!';
  const uploads: string[] = [];

  beforeAll(async () => {
    const storagePort = await freePort();
    fakeStorage = createServer((req, res) => {
      uploads.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unknown API key local-disabled' } }));
      });
    });
    await new Promise<void>((r) => fakeStorage.listen(storagePort, '127.0.0.1', r));

    email = uniqueEmail();
    await prisma.user.create({ data: { email, username: uniqueUsername(), password: await bcrypt.hash(password, 12) } });

    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL as string,
      JWT_SECRET: process.env.JWT_SECRET as string,
      CLOUDINARY_CLOUD_NAME: 'local-disabled',
      CLOUDINARY_API_KEY: 'local-disabled',
      CLOUDINARY_API_SECRET: 'local-disabled',
    };
    rejecting = await startServerProcess({ ...base, CLOUDINARY_URL: `cloudinary://local-disabled:local-disabled@local-disabled?upload_prefix=http://127.0.0.1:${storagePort}` });
    unreachable = await startServerProcess({ ...base, CLOUDINARY_URL: `cloudinary://local-disabled:local-disabled@local-disabled?upload_prefix=http://127.0.0.1:${await freePort()}` });
  }, 90_000);

  afterAll(async () => {
    await rejecting?.stop();
    await unreachable?.stop();
    await new Promise((r) => fakeStorage?.close(r));
  });

  const voiceUpload = async (server: ServerProcess) => {
    const login = await fetch(`${server.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const { token } = await login.json();
    const form = new FormData();
    form.append('durationMs', '2000');
    form.append('waveform', '10,40,80');
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), randomBytes(1000)]);
    form.append('attachment', new Blob([webm], { type: 'audio/webm' }), 'voice-message.webm');
    return fetch(`${server.url}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  };

  it('storage rejecting the configured key: 503 "not available", no key in the response, nothing stored', async () => {
    const before = await prisma.attachment.count();
    const res = await voiceUpload(rejecting);
    const text = await res.text();
    expect(uploads.some((u) => /^POST \/v1_1\/local-disabled\/auto\/upload$/.test(u))).toBe(true); // it really asked storage
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ success: false, message: NOT_CONFIGURED });
    expect(text).not.toMatch(/local-disabled|API key/i);
    expect(await prisma.attachment.count()).toBe(before);
    // The operator still gets the reason in the server log.
    expect(rejecting.output()).toMatch(/storage rejected the server's credentials/i);
  }, 30_000);

  it('storage unreachable: 503 "temporarily unavailable" with Retry-After', async () => {
    const res = await voiceUpload(unreachable);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await res.json()).toEqual({ success: false, message: UNAVAILABLE });
  }, 30_000);
});
