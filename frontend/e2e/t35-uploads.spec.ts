import { execFileSync } from 'node:child_process';
import { APIRequestContext, expect, Locator, Page, test } from '@playwright/test';
import { createWorkspace, newUser, signUp, trackPageErrors } from './helpers';

/**
 * T.35 — voice messages and file uploads, sent for real: real browser, real
 * microphone (Chromium's fake device), real API, real local database. Storage
 * is the local Cloudinary stand-in (e2e/storage-stand-in.mjs), reached through
 * the SDK's upload_prefix: it checks the SDK's signatures and only serves
 * files through signed, expiring links, like the real service.
 */

const STORAGE_URL = `http://127.0.0.1:${Number(process.env.E2E_STORAGE_PORT ?? Number(process.env.E2E_API_PORT ?? 4100) + 2)}`;
const DB = process.env.E2E_DATABASE_URL ?? '';
const LOCAL_DB = /^postgres(ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\//;

/** Rows from the LOCAL E2E database (one row per line, columns joined by |). */
const query = (sql: string, vars: Record<string, string>) => {
  if (!LOCAL_DB.test(DB)) throw new Error('Refusing to touch a non-local database.');
  const args = [DB, '-v', 'ON_ERROR_STOP=1', '-qtA', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`])];
  return execFileSync(process.env.E2E_PSQL ?? 'psql', args, { input: sql }).toString().trim().split('\n').filter(Boolean);
};

const failNextUpload = async (request: APIRequestContext, status: number) =>
  expect((await request.post(`${STORAGE_URL}/__stand-in/fail-next-upload?status=${status}`)).ok()).toBeTruthy();
const storedAssets = async (request: APIRequestContext) =>
  (await (await request.get(`${STORAGE_URL}/__stand-in/assets`)).json()) as { key: string; format: string | null; bytes: number }[];

/** The <audio> inside a voice player, as the browser sees it. */
const audioState = (player: Locator) =>
  player.locator('audio').evaluate((a: HTMLAudioElement) => ({ currentTime: a.currentTime, paused: a.paused, rate: a.playbackRate, error: a.error?.code ?? null, src: a.currentSrc }));

const recordNote = async (page: Page) => {
  await page.getByRole('button', { name: 'Record voice message' }).click();
  await expect(page.getByRole('button', { name: 'Pause recording' })).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Pause recording' }).click();
  await expect(page.getByRole('button', { name: 'Resume recording' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume recording' }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Stop and review voice message' }).click();
};

test('voice message: record, preview, a failed send keeps it, retry sends it, it is stored and plays after a refresh', async ({ page, request }) => {
  const errors = trackPageErrors(page);
  const user = newUser('t35voice');
  await signUp(page, user);
  await createWorkspace(page, `T35 voice ${Date.now()}`);
  const assetsBefore = (await storedAssets(request)).length;

  // 1–3. Record, pause/resume, preview.
  await recordNote(page);
  const review = page.getByRole('group', { name: 'Recorded voice message' });
  await expect(review.getByRole('slider', { name: /Seek/ })).toBeVisible();
  await review.getByRole('button', { name: /^Play / }).click();
  await expect.poll(async () => (await audioState(review)).currentTime, { message: 'preview plays' }).toBeGreaterThan(0.2);
  await review.getByRole('button', { name: /^Pause / }).click();

  // 9. Storage fails on the first try: clear message, the recording is kept, nothing stored.
  await failNextUpload(request, 503);
  await page.getByRole('button', { name: 'Send voice message' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'File storage is temporarily unavailable' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Your recording is kept');
  await expect(review).toBeVisible();
  expect((await storedAssets(request)).length).toBe(assetsBefore);

  // 4. Retry sends it.
  await page.getByRole('button', { name: 'Retry sending voice message' }).click();
  const sent = page.getByRole('main').getByRole('group', { name: /^Voice message / });
  await expect(sent).toBeVisible();
  await expect(review).toBeHidden();

  // 5. Stored: one private (authenticated) asset in storage, one Attachment row linked to the message.
  const assets = await storedAssets(request);
  expect(assets.length).toBe(assetsBefore + 1);
  expect(assets.at(-1)).toMatchObject({ format: 'webm' });
  expect(assets.at(-1)!.key).toMatch(/^video:authenticated:workspace-uploads\//);
  const rows = query(
    `SELECT a."mimeType", a."durationMs", length(a.waveform) > 0, a."deliveryType", m.id IS NOT NULL, m."fileUrl" = '/api/attachments/' || a.id
       FROM "Attachment" a JOIN "User" u ON u.id = a."uploaderId" LEFT JOIN "Message" m ON m.id = a."messageId"
      WHERE u.email = :'email';`,
    { email: user.email }
  );
  expect(rows).toHaveLength(1);
  const [mimeType, durationMs, hasWaveform, deliveryType, linked, privatePath] = rows[0].split('|');
  expect(mimeType).toMatch(/^audio\/webm/);
  expect(Number(durationMs)).toBeGreaterThan(2000);
  expect([hasWaveform, deliveryType, linked, privatePath]).toEqual(['t', 'authenticated', 't', 't']);

  // 6–8. After a refresh: the message is there, plays from a signed link, speed and waveform work.
  await page.reload();
  const player = page.getByRole('main').getByRole('group', { name: /^Voice message / });
  await expect(player).toBeVisible();
  await expect(player.getByRole('slider', { name: /Seek/ }).locator('[aria-hidden="true"]')).toHaveCount(48); // stored waveform bars
  await player.getByRole('button', { name: /^Play / }).click();
  await expect.poll(async () => (await audioState(player)).currentTime, { message: 'sent note plays' }).toBeGreaterThan(0.3);
  const playing = await audioState(player);
  expect(playing.error).toBeNull();
  expect(playing.src).toMatch(/\/download\?.*signature=/); // a signed storage link, never a public URL
  await player.getByRole('button', { name: /Playback speed 1×/ }).click();
  await expect(player.getByRole('button', { name: /Playback speed 1\.5×/ })).toBeVisible();
  expect((await audioState(player)).rate).toBe(1.5);
  // The link is signed: a tampered copy is refused by storage.
  expect((await request.get(playing.src.replace(/signature=[^&]+/, 'signature=0000'))).status()).toBe(401);

  expect(errors).toEqual([]);
});

test('file uploads: an image is sent, stored privately and shown after a refresh; a disguised file is refused', async ({ page, request }) => {
  const errors = trackPageErrors(page);
  const user = newUser('t35file');
  await signUp(page, user);
  await createWorkspace(page, `T35 files ${Date.now()}`);
  const assetsBefore = (await storedAssets(request)).length;

  // A real 2×2 PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAAMIM/////w8AH+4F+7C4l8kAAAAASUVORK5CYII=', 'base64');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach file' }).click();
  await (await chooser).setFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('list', { name: 'Attachments' })).toContainText('diagram.png');
  await expect(page.getByTitle(/^Send \(Enter\)/)).toBeEnabled();
  await page.getByTitle(/^Send \(Enter\)/).click();

  const image = page.getByRole('main').getByRole('img', { name: 'diagram.png' });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2);
  expect((await storedAssets(request)).length).toBe(assetsBefore + 1);
  expect(query(`SELECT a."deliveryType", a."messageId" IS NOT NULL FROM "Attachment" a JOIN "User" u ON u.id = a."uploaderId" WHERE u.email = :'email';`, { email: user.email })).toEqual(['authenticated|t']);

  await page.reload();
  await expect.poll(() => page.getByRole('main').getByRole('img', { name: 'diagram.png' }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2);

  // Content checks still apply: text pretending to be a PNG is refused and never reaches storage.
  const chooser2 = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach file' }).click();
  await (await chooser2).setFiles({ name: 'not-really.png', mimeType: 'image/png', buffer: Buffer.from('#!/bin/sh\necho hello\n') });
  await expect(page.getByRole('list', { name: 'Attachments' }).getByRole('alert')).toBeVisible();
  expect((await storedAssets(request)).length).toBe(assetsBefore + 1);

  expect(errors).toEqual([]);
});
