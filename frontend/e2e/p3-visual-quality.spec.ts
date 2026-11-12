import { expect, Page, test } from '@playwright/test';
import { apiAs, createWorkspace, logIn, newUser, sendMessage, signUp, tokenOf, trackPageErrors } from './helpers';

/**
 * P3 — visual quality and responsive layout across the main screens, in both
 * themes and at phone / tablet / desktop widths. Every screen must render
 * without page errors and without horizontal page overflow; a screenshot of
 * each is kept in the test output for design review.
 */

type Theme = 'light' | 'dark';
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
} as const;

const setTheme = async (page: Page, theme: Theme) => {
  await page.evaluate((t) => localStorage.setItem('smartconnect:theme', t), theme);
  await page.reload();
};

/** The page never scrolls sideways (a sign of a broken responsive layout). */
const expectNoHorizontalOverflow = async (page: Page, label: string) => {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scroll: doc.scrollWidth, client: doc.clientWidth };
  });
  expect(overflow.scroll, `${label}: horizontal overflow`).toBeLessThanOrEqual(overflow.client + 1);
};

test('P3: main screens render cleanly in light and dark, phone to desktop', async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const owner = newUser('p3owner');
  const peer = newUser('p3peer');

  const ownerCtx = await browser.newContext({ viewport: VIEWPORTS.desktop });
  const page = await ownerCtx.newPage();
  const errors = trackPageErrors(page);
  const shot = async (name: string) => {
    await page.waitForTimeout(400);
    await expectNoHorizontalOverflow(page, name);
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  };

  // Signed-out screens.
  for (const theme of ['light', 'dark'] as const) {
    await page.goto('/login');
    await setTheme(page, theme);
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
    await shot(`desktop-${theme}-login`);
  }

  // Two people, a private workspace with real conversation content.
  const peerPage = await (await browser.newContext()).newPage();
  await signUp(peerPage, peer);
  await peerPage.waitForURL(/\/[0-9a-f-]{36}\//);
  const peerToken = await tokenOf(peerPage);

  await signUp(page, owner);
  await page.waitForURL(/\/[0-9a-f-]{36}\//);
  const ws = await createWorkspace(page, `Design Review ${owner.username.slice(-6)}`);
  const general = new URL(page.url()).pathname.split('/')[3];
  const ownerToken = await tokenOf(page);

  const request = page.request;
  const candidates = await (await apiAs(request, ownerToken).get(`/api/workspaces/${ws}/member-candidates?q=${peer.username}`)).json();
  const peerId = candidates.users.find((u: { username: string }) => u.username === peer.username).id;
  expect((await apiAs(request, ownerToken).post(`/api/workspaces/${ws}/members`, { userId: peerId })).ok()).toBeTruthy();

  await sendMessage(page, 'Welcome to the **design review** channel');
  await sendMessage(page, 'Agenda for today:');
  await peerPage.goto(`/${ws}/c/${general}`);
  await sendMessage(peerPage, `Thanks @${owner.username}, a quick note with \`inline code\` and a link https://example.com`);
  await expect(page.getByText('a quick note with')).toBeVisible();
  void peerToken;

  const screens: { name: string; open: () => Promise<void> }[] = [
    {
      name: 'channel',
      open: async () => {
        await page.goto(`/${ws}/c/${general}`);
        await expect(page.getByText('a quick note with')).toBeVisible();
        // Calls stay reachable at every width, and the message list never
        // scrolls sideways.
        const width = page.viewportSize()!.width;
        for (const name of ['Start audio call', 'Start video call']) {
          const box = (await page.getByRole('button', { name }).boundingBox())!;
          expect(box.x + box.width, `${name} fits on screen`).toBeLessThanOrEqual(width);
        }
        const list = await page.locator('[data-virtuoso-scroller]').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
        expect(list.scroll, 'message list horizontal overflow').toBeLessThanOrEqual(list.client + 1);
      },
    },
    {
      name: 'thread',
      open: async () => {
        await page.goto(`/${ws}/c/${general}`);
        const msg = page.getByText('Agenda for today:');
        await msg.hover();
        await page.getByRole('button', { name: 'Reply in thread' }).first().click();
        await expect(page.getByText('Thread', { exact: false }).first()).toBeVisible();
      },
    },
    { name: 'dms', open: async () => { await page.goto(`/${ws}/dms`); } },
    { name: 'activity', open: async () => { await page.goto(`/${ws}/activity`); } },
    { name: 'directory', open: async () => { await page.goto(`/${ws}/directory`); } },
    { name: 'settings', open: async () => { await page.goto(`/${ws}/settings`); } },
    { name: 'home', open: async () => { await page.goto(`/${ws}/home`); } },
    { name: 'projects', open: async () => { await page.goto(`/${ws}/projects`); } },
    {
      name: 'navigation',
      open: async () => {
        await page.goto(`/${ws}/c/${general}`);
        const opener = page.getByRole('button', { name: 'Open navigation' });
        // Phones: the workspace rail and sidebar live in one drawer.
        if (await opener.isVisible()) {
          await opener.click();
          await expect(page.getByRole('navigation', { name: 'Workspaces' })).toBeInViewport();
          // …and the drawer starts below the app bar, not underneath it.
          const rail = (await page.getByRole('navigation', { name: 'Workspaces' }).boundingBox())!;
          expect(rail.y).toBeGreaterThanOrEqual(48);
        }
      },
    },
    {
      name: 'account-menu',
      open: async () => {
        await page.goto(`/${ws}/c/${general}`);
        await page.getByRole('button', { name: 'Account menu' }).click();
      },
    },
  ];

  for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark'] as const) {
      await page.goto(`/${ws}/c/${general}`);
      await setTheme(page, theme);
      // Phones and tablets get the core screens; desktop gets every screen.
      const list = vpName === 'desktop' ? screens : screens.filter((s) => ['channel', 'thread', 'dms', 'activity', 'settings', 'navigation'].includes(s.name));
      for (const screen of list) {
        await screen.open();
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await shot(`${vpName}-${theme}-${screen.name}`);
        await page.keyboard.press('Escape');
      }
    }
  }

  expect(errors, 'no uncaught page errors').toEqual([]);
});
