import { mkdirSync } from 'node:fs';
import { BrowserContext, expect, Locator, Page, test } from '@playwright/test';
import { apiAs, createWorkspace, logIn, newUser, pageToken, sendMessage, signUp, trackPageErrors } from './helpers';

/**
 * T.39 — the phone and tablet experience in a real browser (Chromium with
 * touch emulation), against the real API and a local throwaway database.
 * Setup uses the desktop layout (the shared helpers drive the desktop UI);
 * every assertion below runs at the phone/tablet size under test.
 */
const SHOTS = process.env.T39_SHOTS_DIR; // optional: also save screenshots (visual QA)

const THEME = process.env.T39_THEME; // optional: 'dark' or 'light' (visual QA)
const touchContext = async (browser: Parameters<Parameters<typeof test>[2]>[0]['browser']) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, permissions: ['microphone', 'camera'] });
  if (THEME) await context.addInitScript((theme) => localStorage.setItem('smartconnect:theme', theme), THEME);
  return context;
};

const noHorizontalOverflow = async (page: Page, where: string) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontal overflow at ${where}`).toBeLessThanOrEqual(0);
};

/** Press and hold with a finger (pointer events, as on a phone). */
const longPress = async (target: Locator) => {
  const box = (await target.boundingBox())!;
  const init = { pointerType: 'touch', isPrimary: true, pointerId: 7, clientX: box.x + 40, clientY: box.y + box.height / 2, bubbles: true };
  await target.dispatchEvent('pointerdown', init);
  await target.page().waitForTimeout(650);
  await target.dispatchEvent('pointerup', init);
};

const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

const setupLeadWorkspace = async (context: BrowserContext, label: string) => {
  const page = await context.newPage();
  const lead = newUser(label);
  await signUp(page, lead);
  const workspaceId = await createWorkspace(page, `T39 ${label} ${Date.now()}`);
  return { page, lead, workspaceId, token: (await pageToken(page))! };
};

test('phone: tab bar, chat list, full-screen conversation, multiline, action sheets, calls, more', async ({ browser }) => {
  const context = await touchContext(browser);
  const { page, lead, workspaceId } = await setupLeadWorkspace(context, 't39phone');
  const errors = trackPageErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  // Chats tab: the chat list with the tab bar.
  await page.goto(`/${workspaceId}/chats`);
  await expect(mainNav(page)).toBeVisible();
  await expect(mainNav(page).getByRole('button', { name: 'Chats' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { level: 2, name: 'Channels' })).toBeVisible();
  await noHorizontalOverflow(page, 'chats');

  // A conversation fills the screen: no app header, no tab bar, a back button.
  await page.getByRole('button', { name: /^#General/ }).click();
  await page.waitForURL(new RegExp(`/${workspaceId}/c/`));
  await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible();
  await expect(mainNav(page)).toHaveCount(0);
  await expect(page.locator('header').first()).toBeHidden();
  await noHorizontalOverflow(page, 'conversation');

  // Enter adds a line on a phone; Send sends both lines.
  const editor = page.locator('main [contenteditable="true"]').first();
  await editor.click();
  await editor.pressSequentially('First line');
  await editor.press('Enter');
  await editor.pressSequentially('Second line');
  await expect(page.locator('[data-message-id]').filter({ hasText: 'First line' })).toHaveCount(0);
  await page.getByRole('button', { name: /Send/ }).click();
  const message = page.locator('[data-message-id]').filter({ hasText: 'Second line' });
  await expect(message).toContainText('First line');

  // Press and hold → the message action sheet → react.
  await longPress(message);
  const sheet = page.getByRole('dialog', { name: /^Message from/ });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'React with 👍' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(message.getByRole('button', { name: /^👍 1/ })).toBeVisible();
  // …and pin it from the sheet.
  await longPress(message);
  await page.getByRole('dialog', { name: /^Message from/ }).getByRole('button', { name: 'Pin message' }).click();
  await longPress(message);
  await expect(page.getByRole('dialog', { name: /^Message from/ }).getByRole('button', { name: 'Unpin message' })).toBeVisible();
  await page.keyboard.press('Escape');

  // "+" → the attachment sheet → Voice message opens the recorder.
  await page.getByRole('button', { name: 'Attach file' }).click();
  const attach = page.getByRole('dialog', { name: 'Add to your message' });
  for (const option of ['Take a photo', 'Photos & videos', 'File', 'Voice message']) await expect(attach.getByRole('button', { name: option })).toBeVisible();
  await attach.getByRole('button', { name: 'Voice message' }).click();
  await expect(page.getByRole('button', { name: 'Pause recording' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel recording' }).click();
  // The formatting toolbar is behind "Aa" on phones.
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeHidden();
  await page.getByRole('button', { name: 'Show formatting' }).click();
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/flow-390x844-conversation.png` });

  // Back to the chat list.
  await page.getByRole('button', { name: 'Back to chats' }).click();
  await page.waitForURL(new RegExp(`/${workspaceId}/chats$`));

  // Calls tab → the pre-join lobby.
  await mainNav(page).getByRole('button', { name: 'Calls' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Calls' })).toBeVisible();
  await page.getByRole('button', { name: 'Audio call #General' }).click();
  const lobby = page.getByRole('dialog').filter({ has: page.locator('#call-lobby-title') });
  await expect(lobby).toBeVisible();
  await noHorizontalOverflow(page, 'call lobby');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/flow-390x844-call-lobby.png` });
  await lobby.getByRole('button', { name: 'Close call setup' }).click();

  // Tasks tab.
  await mainNav(page).getByRole('button', { name: 'Tasks' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My tasks' })).toBeVisible();

  // More tab: account, theme, sign out.
  await mainNav(page).getByRole('button', { name: 'More' }).click();
  await expect(page.getByText(lead.username).first()).toBeVisible();
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/flow-390x844-more-dark.png` });
  await page.getByRole('radio', { name: 'Light' }).click();
  await page.getByRole('button', { name: 'Sign out' }).last().click();
  await page.waitForURL(/\/login/);
  expect(errors).toEqual([]);
  await context.close();
});

test('phone: a member starts and completes a task; the lead assigns from the Team tasks sheet', async ({ browser, request }) => {
  const context = await touchContext(browser);
  const { page: leadPage, workspaceId, token } = await setupLeadWorkspace(context, 't39lead');
  const memberPage = await context.newPage();
  // Separate tab sign-ins (T.37) so both people stay signed in in one browser context.
  await memberPage.goto('/login?tabSession=1');
  const member = newUser('t39member');
  await signUp(memberPage, member);
  await expect.poll(async () => pageToken(memberPage)).toBeTruthy();
  const memberId = (await (await apiAs(request, (await pageToken(memberPage))!).get('/api/auth/me')).json()).id;
  const lead = apiAs(request, token);
  expect((await lead.post(`/api/workspaces/${workspaceId}/members`, { userId: memberId })).status()).toBe(201);
  expect((await lead.post(`/api/workspaces/${workspaceId}/team-tasks`, { title: 'Phone task', assigneeId: memberId, priority: 'HIGH' })).status()).toBe(201);
  const errors = trackPageErrors(memberPage);

  await memberPage.setViewportSize({ width: 375, height: 812 });
  await memberPage.goto(`/${workspaceId}/tasks`);
  await memberPage.getByRole('button', { name: 'Start Phone task' }).click();
  await memberPage.getByRole('button', { name: 'Mark Phone task as completed' }).click();
  await memberPage.getByRole('dialog', { name: 'Mark this task as completed?' }).getByRole('button', { name: 'Mark completed' }).click();
  await memberPage.getByRole('tab', { name: /Completed/ }).click();
  await expect(memberPage.getByText(/Completed [A-Z][a-z]{2} \d+, \d+:\d\d (AM|PM)/)).toBeVisible();
  await noHorizontalOverflow(memberPage, 'member tasks');

  // The lead on a phone: Team tasks → Create task as a bottom sheet.
  await leadPage.setViewportSize({ width: 390, height: 844 });
  await leadPage.goto(`/${workspaceId}/team-tasks`);
  await expect(leadPage.getByRole('button', { name: 'Completed: 1' })).toBeVisible();
  await leadPage.getByRole('button', { name: 'Create task' }).first().click();
  const dialog = leadPage.getByRole('dialog', { name: 'Create task' });
  // Once its slide-up has finished: anchored to the bottom edge, full width, within the screen.
  await expect.poll(async () => { const b = (await dialog.boundingBox())!; return Math.round(b.y + b.height); }).toBe(844);
  const box = (await dialog.boundingBox())!;
  expect(Math.round(box.width)).toBe(390);
  expect(box.y).toBeGreaterThanOrEqual(0);
  await dialog.getByLabel('Task title').fill('Assigned from a phone');
  await dialog.getByLabel('Assign to').selectOption({ label: member.username });
  await dialog.getByRole('button', { name: 'Assign task' }).click();
  await expect(dialog.getByRole('status')).toContainText('Assigned “Assigned from a phone”');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(leadPage.getByRole('button', { name: 'Total tasks: 2' })).toBeVisible();
  await noHorizontalOverflow(leadPage, 'team tasks');
  expect(errors).toEqual([]);
  await context.close();
});

test('tablet: split view with a collapsible sidebar (remembered), no phone tab bar', async ({ browser }) => {
  const context = await touchContext(browser);
  const { page, workspaceId } = await setupLeadWorkspace(context, 't39tablet');
  await sendMessage(page, 'Tablet hello');
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto(`/${workspaceId}`);
  await page.waitForURL(new RegExp(`/${workspaceId}/c/`));
  const rail = page.getByRole('navigation', { name: 'Workspaces' });
  await expect(rail).toBeVisible(); // sidebar (master) …
  await expect(page.locator('[data-message-id]').filter({ hasText: 'Tablet hello' })).toBeVisible(); // … and conversation (detail)
  await expect(mainNav(page)).toBeHidden();
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(rail).toBeHidden();
  await noHorizontalOverflow(page, 'tablet, sidebar hidden');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
  await expect(rail).toBeHidden();
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(rail).toBeVisible();
  await context.close();
});

const VIEWPORTS = [
  [320, 568], [375, 812], [390, 844], [430, 932], // phones
  [768, 1024], [820, 1180], [1024, 768], [1180, 820], // tablets (portrait/landscape)
  [1280, 800], [1440, 900], [1920, 1080], // desktop
] as const;

test('every required viewport: no horizontal overflow; tab bar only on phones; desktop keeps its sidebar', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await touchContext(browser);
  const { page, workspaceId } = await setupLeadWorkspace(context, 't39matrix');
  await sendMessage(page, 'Matrix message');
  const channelPath = new URL(page.url()).pathname;
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const screens: [string, string][] = [
    ['chats', `/${workspaceId}/chats`],
    ['conversation', channelPath],
    ['my-tasks', `/${workspaceId}/tasks`],
    ['team-tasks', `/${workspaceId}/team-tasks`],
    ['calls', `/${workspaceId}/calls`],
    ['more', `/${workspaceId}/more`],
  ];
  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    for (const [name, url] of screens) {
      await page.goto(url);
      await expect(page.locator('main').first()).toBeVisible();
      await page.waitForTimeout(350);
      await noHorizontalOverflow(page, `${w}x${h} ${name}`);
      const phone = w < 768;
      const tabBar = mainNav(page);
      if (phone && name !== 'conversation') await expect(tabBar, `${w}x${h} ${name}: tab bar`).toBeVisible();
      else await expect(tabBar, `${w}x${h} ${name}: no tab bar`).toBeHidden();
      if (!phone) await expect(page.getByRole('navigation', { name: 'Workspaces' }), `${w}x${h} ${name}: sidebar`).toBeVisible();
      if (name === 'conversation') {
        const composer = page.locator('main [contenteditable="true"]').first();
        const box = (await composer.boundingBox())!;
        expect(box.y + box.height, `${w}x${h}: composer inside the viewport`).toBeLessThanOrEqual(h);
      }
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${w}x${h}-${name}${THEME ? `-${THEME}` : ''}.png` });
    }
  }
  await context.close();
});
