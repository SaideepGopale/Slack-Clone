import crypto from 'crypto';
import { prisma } from './lib/prisma';

// Stage 1B (T.30): local development utility. It derives the OTP key the
// running local server uses, so it needs that server's JWT_SECRET from the
// environment — there is no built-in value. The two disposable test accounts
// get random per-run passwords, which are never printed.
const refuse = (reason: string): never => {
  console.error(`Refusing to run: ${reason}`);
  process.exit(1);
};
if (process.env.NODE_ENV === 'production') refuse('local development utility only (NODE_ENV=production).');
const JWT_SECRET = process.env.JWT_SECRET || refuse('set JWT_SECRET to the local backend\'s value (it is never printed).');
const disposablePassword = () => `${crypto.randomBytes(18).toString('base64url')}-Aa1!`;
const otpKey = () => `${JWT_SECRET}:otp`;
const hashOtp = (code: string) => crypto.createHmac('sha256', otpKey()).update(code).digest('hex');

async function signupUser(email: string, username: string, password: string) {
  const r1 = await fetch('http://localhost:4000/api/auth/signup-request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password }),
  });
  if (!r1.ok) throw new Error('request-otp failed: ' + await r1.text());
  const record = await prisma.oTPVerification.findUnique({ where: { email } });
  if (!record) throw new Error('no OTP record found');
  let code: string | null = null;
  for (let i = 0; i < 1000000; i++) {
    const candidate = String(i).padStart(6, '0');
    if (hashOtp(candidate) === record.otpHash) { code = candidate; break; }
  }
  if (!code) throw new Error('failed to crack OTP');
  const r2 = await fetch('http://localhost:4000/api/auth/verify-otp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  if (!r2.ok) throw new Error('verify-otp failed: ' + await r2.text());
  return r2.json() as Promise<{ token: string; user: { id: string; username: string } }>;
}

async function main() {
  const ts = Date.now();
  const a = await signupUser(`dmA${ts}@example.com`, `dmA${ts}`, disposablePassword());
  const b = await signupUser(`dmB${ts}@example.com`, `dmB${ts}`, disposablePassword());
  console.log('EMAIL_A=dmA' + ts + '@example.com');
  console.log('EMAIL_B=dmB' + ts + '@example.com');
  console.log('USERNAME_B=' + b.user.username);
}

main().finally(() => prisma.$disconnect());
