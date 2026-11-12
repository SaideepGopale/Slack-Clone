import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { corsOrigins, DEV_APP_URL, LOCAL_DEV_ORIGINS, normalizeAppUrl, trustProxySetting } from '../config/deployment';

/**
 * Render deployment settings (config/deployment.ts) and e-mail branding
 * (utils/mailer.ts). Pure unit tests: no database, no app import.
 */

const sent: Array<Record<string, string>> = [];
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (message: Record<string, string>) => {
        sent.push(message);
        return { data: { id: 'test-message' }, error: null };
      },
    };
  },
}));

describe('APP_URL normalisation', () => {
  it('accepts absolute http(s) URLs, trimming whitespace and trailing slashes', () => {
    expect(normalizeAppUrl('https://smartconnect-frontend.onrender.com')).toBe('https://smartconnect-frontend.onrender.com');
    expect(normalizeAppUrl('  https://smartconnect-frontend.onrender.com//  ')).toBe('https://smartconnect-frontend.onrender.com');
    expect(normalizeAppUrl('http://localhost:5174/')).toBe('http://localhost:5174');
  });

  it('rejects missing, relative and non-http values', () => {
    for (const value of [undefined, '', '   ', 'smartconnect-frontend.onrender.com', '/app', 'ftp://example.com', 'javascript:alert(1)']) {
      expect(normalizeAppUrl(value)).toBeNull();
    }
  });

  it('defaults locally to the Vite dev server origin', () => {
    expect(DEV_APP_URL).toBe('http://localhost:5174');
  });
});

describe('CORS origins', () => {
  const appUrl = 'https://smartconnect-frontend.onrender.com';

  it('production allows only APP_URL — never a localhost origin', () => {
    expect(corsOrigins('production', appUrl)).toEqual([appUrl]);
  });

  it('outside production also allows the local dev origins (Vite dev 5174/5173, preview 4173), without duplicates', () => {
    const origins = corsOrigins('development', 'http://localhost:5174');
    expect(origins[0]).toBe('http://localhost:5174');
    for (const origin of ['http://localhost:5174', 'http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5174']) {
      expect(origins).toContain(origin);
    }
    expect(new Set(origins).size).toBe(origins.length);
    expect(corsOrigins('test', appUrl)).toEqual([appUrl, ...LOCAL_DEV_ORIGINS]);
  });
});

describe('Express trust proxy', () => {
  it('trusts exactly one hop (Render\'s load balancer) in production and nothing elsewhere', () => {
    expect(trustProxySetting('production', undefined)).toBe(1);
    expect(trustProxySetting('production', '')).toBe(1);
    expect(trustProxySetting('development', undefined)).toBe(false);
    expect(trustProxySetting('test', undefined)).toBe(false);
  });

  it('TRUST_PROXY overrides it with a hop count, a boolean or an Express trust value', () => {
    expect(trustProxySetting('production', '2')).toBe(2);
    expect(trustProxySetting('production', 'false')).toBe(false);
    expect(trustProxySetting('development', 'true')).toBe(true);
    expect(trustProxySetting('production', 'loopback')).toBe('loopback');
  });
});

describe('e-mail branding', () => {
  const saved = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };
  beforeEach(() => {
    sent.length = 0;
    process.env.RESEND_API_KEY = 'test-resend-key';
    delete process.env.EMAIL_FROM;
  });
  afterEach(() => {
    if (saved.key === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = saved.key;
    if (saved.from === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = saved.from;
  });

  it('every e-mail is SmartConnect-branded and, by default, uses Resend\'s test sender (no invented domain)', async () => {
    const { sendInviteEmail, sendOtpEmail, sendResetPasswordEmail } = await import('../utils/mailer');
    await sendInviteEmail('a@example.com', 'https://app.example/invite/x', 'Design');
    await sendOtpEmail('a@example.com', '123456');
    await sendResetPasswordEmail('a@example.com', 'https://app.example/reset-password?token=t&id=i');
    expect(sent).toHaveLength(3);
    for (const message of sent) {
      expect(message.from).toBe('SmartConnect <onboarding@resend.dev>');
      expect(`${message.subject} ${message.html}`).not.toContain('Slick');
    }
    expect(sent.map((m) => m.subject)).toEqual([
      "You've been invited to join Design on SmartConnect",
      '123456 is your SmartConnect verification code',
      'Password Reset Request - SmartConnect',
    ]);
  });

  it('EMAIL_FROM sets the sender (a domain verified in Resend)', async () => {
    process.env.EMAIL_FROM = '  SmartConnect <no-reply@verified.example>  ';
    const { sendResetPasswordEmail } = await import('../utils/mailer');
    await sendResetPasswordEmail('a@example.com', 'https://app.example/reset-password?token=t&id=i');
    expect(sent[0].from).toBe('SmartConnect <no-reply@verified.example>');
  });
});
