import { describe, expect, it } from 'vitest';
import { isValidEmail, MAX_EMAIL_LENGTH } from '../lib/email';

/**
 * P1-C — FA-SEC-02: the e-mail check shared by signup, signup-request and
 * invitations (lib/email.ts). Database-free.
 *
 * Before P1-C, `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` ran on input of any length and
 * backtracked quadratically on "a@" + "."×n + "@" (measured: 224 ms at 16k
 * characters, 3.4 s at 64k, ~14 minutes at the 1 MB body limit — one request
 * blocked the whole event loop). The pattern is unchanged; it must now only
 * ever see strings of at most 254 characters.
 */

// The pattern signup and invitations used before P1-C: what counts as a valid
// address below the length limit must not change.
const LEGACY_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const adversarial = (dots: number) => `a@${'.'.repeat(dots)}@`;
const ofLength = (length: number, domain = '@example.com') => `${'x'.repeat(length - domain.length)}${domain}`;
const elapsedMs = (fn: () => unknown) => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

const VALID = [
  'user@example.com',
  'first.last@example.com',
  'first.last+tag@sub.example.co.uk',
  'USER_01-x@Example.COM',
  'a@b.co',
  "o'brien@example.ie",
  'user@localhost.localdomain',
  'user@[192.168.0.1]',
  'δοκιμή@παράδειγμα.δοκιμή',
  'e2e_caller_abc123@example.test', // the E2E suite's addresses
  'test-6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f@example.com', // the backend suite's addresses
];

const INVALID = [
  'plainaddress',
  'a@b',
  'a@b.',
  '@example.com',
  'a@.com',
  'a@@example.com',
  'a@b@example.com',
  'a b@example.com',
  'a@exa mple.com',
  ' a@example.com',
  'a@example.com ',
  'a@example.com\n',
  'a@b,co',
];

describe('isValidEmail (FA-SEC-02)', () => {
  it('accepts normal addresses', () => {
    for (const email of VALID) expect(isValidEmail(email), email).toBe(true);
  });

  it('rejects malformed addresses', () => {
    for (const email of INVALID) expect(isValidEmail(email), JSON.stringify(email)).toBe(false);
  });

  it('rejects empty and whitespace-only input', () => {
    for (const email of ['', ' ', '   ', '\t', '\n', ' \t\r\n ', ' ', ' 　']) {
      expect(isValidEmail(email), JSON.stringify(email)).toBe(false);
    }
  });

  it('rejects anything that is not a string, including values the pattern would coerce to a valid address', () => {
    const coercible = { toString: () => 'user@example.com' };
    for (const value of [undefined, null, 0, 42, true, {}, [], ['user@example.com'], coercible, [adversarial(64_000)]]) {
      expect(isValidEmail(value), String(value).slice(0, 40)).toBe(false);
    }
  });

  it('boundary lengths: 254 characters is accepted, 255 is rejected', () => {
    expect(MAX_EMAIL_LENGTH).toBe(254);
    expect(isValidEmail(ofLength(253))).toBe(true);
    expect(isValidEmail(ofLength(254))).toBe(true);
    expect(isValidEmail(ofLength(255))).toBe(false);
    expect(isValidEmail(ofLength(256))).toBe(false);
  });

  it('rejects extremely long input without scanning it', () => {
    for (const email of [ofLength(1_000_000), ofLength(10_000_000)]) {
      let result: boolean | undefined;
      const ms = elapsedMs(() => (result = isValidEmail(email)));
      expect(result).toBe(false);
      expect(ms).toBeLessThan(20);
    }
  });

  it('rejects the adversarial pattern in bounded time at every size', () => {
    for (const dots of [2_000, 16_000, 64_000]) {
      let result: boolean | undefined;
      const ms = elapsedMs(() => (result = isValidEmail(adversarial(dots))));
      expect(result, `${dots} dots`).toBe(false);
      expect(ms, `${dots} dots`).toBeLessThan(20);
    }
  });

  it('the worst input that still reaches the pattern (254 characters) costs well under a millisecond', () => {
    const worst = adversarial(251);
    expect(worst).toHaveLength(MAX_EMAIL_LENGTH);
    expect(isValidEmail(worst)).toBe(false);
    const ms = elapsedMs(() => {
      for (let i = 0; i < 1_000; i++) isValidEmail(worst);
    });
    expect(ms / 1_000).toBeLessThan(1); // measured ≈ 0.08 ms per call
  });

  it('accepts exactly what the previous pattern accepted, for every input up to the limit', () => {
    // Deterministic pseudo-random corpus (mulberry32): identical on every run.
    let seed = 0x5eed;
    const next = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const ALPHABET = ['a', 'b', 'Z', '0', '.', '.', '.', '@', '-', '+', '_', "'", ' ', '\t', '\n', ' ', 'é', 'δ'];
    const piece = (max: number) => {
      let s = '';
      for (let i = Math.floor(next() * max); i > 0; i--) s += ALPHABET[Math.floor(next() * ALPHABET.length)];
      return s;
    };
    const corpus: string[] = [];
    for (let i = 0; i < 20_000; i++) corpus.push(piece(24)); // unstructured
    for (let i = 0; i < 20_000; i++) corpus.push(`${piece(8)}@${piece(8)}.${piece(8)}`); // address-shaped
    for (let i = 0; i < 2_000; i++) {
      const tail = `@${piece(6)}.${piece(6)}`;
      corpus.push(`${'y'.repeat(MAX_EMAIL_LENGTH - 1 - tail.length)}${piece(3)}${tail}`); // 253–255 characters
    }

    let accepted = 0;
    for (const email of corpus) {
      const expected = email.length <= MAX_EMAIL_LENGTH && LEGACY_PATTERN.test(email);
      expect(isValidEmail(email), JSON.stringify(email)).toBe(expected);
      if (expected) accepted++;
    }
    // The corpus exercises both outcomes (this seed: 925 accepted, 41,075 rejected).
    expect(accepted).toBeGreaterThan(500);
    expect(corpus.length - accepted).toBeGreaterThan(500);
  });
});
