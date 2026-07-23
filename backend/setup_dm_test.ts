import crypto from 'crypto';
import { prisma } from './lib/prisma';

const JWT_SECRET = 'dev_secret_for_local';
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
  const a = await signupUser(`dmA${ts}@example.com`, `dmA${ts}`, 'DmTest123!');
  const b = await signupUser(`dmB${ts}@example.com`, `dmB${ts}`, 'DmTest123!');
  console.log('EMAIL_A=dmA' + ts + '@example.com');
  console.log('EMAIL_B=dmB' + ts + '@example.com');
  console.log('USERNAME_B=' + b.user.username);
}

main().finally(() => prisma.$disconnect());
