import { execFileSync } from 'node:child_process';
import { Browser, expect, Page, test } from '@playwright/test';
import { apiAs, createWorkspace, E2EUser, logIn, newUser, sendMessage, signUp, tokenOf, trackPageErrors, workspaceIdFrom } from './helpers';

/**
 * P2 — the primary business flow, end to end in real browsers:
 * platform admin provisions accounts → people sign in (no e-mail, no OTP) →
 * everyone shares SmartConnect Collab → an owner's private workspace, with
 * people added directly → strict isolation for everyone else → the chat,
 * mention, draft, search, call and theme features on top.
 */

const DB = process.env.E2E_DATABASE_URL ?? '';
const LOCAL_DB = /^postgres(ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\//;
const UUID = '[0-9a-f-]{36}';

/**
 * There is no self-service way to become a platform admin (by design), so the
 * test promotes its own freshly signed-up account directly in the LOCAL
 * throwaway E2E database — the same guard playwright.config.ts applies.
 */
const promoteToPlatformAdmin = (email: string) => {
  if (!LOCAL_DB.test(DB)) throw new Error('Refusing to touch a non-local database.');
  const out = execFileSync(process.env.E2E_PSQL ?? 'psql', [DB, '-v', 'ON_ERROR_STOP=1', '-qtA', '-v', `email=${email}`], {
    input: `UPDATE "User" SET role = 'ADMIN' WHERE email = :'email' RETURNING id;\n`,
  }).toString();
  expect(out.trim().split('\n').filter(Boolean), 'exactly one account promoted').toHaveLength(1);
};

const freshPage = async (browser: Browser) => (await browser.newContext()).newPage();

interface Provisioned extends E2EUser {
  loginId: string;
  displayName: string;
}

const provision = (label: string): Provisioned => {
  const base = newUser(label);
  const tag = base.username.split('_')[1];
  return { ...base, loginId: `sam${tag}@2003`, email: `sam${tag}@2003`, password: 'sam123', displayName: `${label.toUpperCase()} Person` };
};

const createUserAsAdmin = async (admin: Page, user: Provisioned) => {
  await admin.getByRole('button', { name: 'Create user' }).first().click();
  const dialog = admin.getByRole('dialog', { name: 'Create user' });
  await dialog.getByLabel('Username', { exact: true }).fill(user.username);
  await dialog.getByLabel('Login (e-mail or identifier)').fill(user.loginId);
  await dialog.getByLabel('Password', { exact: true }).fill(user.password);
  await dialog.getByLabel('Display name (optional)').fill(user.displayName);
  await dialog.getByRole('button', { name: 'Create user' }).click();
  await expect(dialog).toBeHidden();
};

const logInWithId = async (page: Page, user: Provisioned) => {
  await logIn(page, { username: user.username, email: user.loginId, password: user.password });
  await page.waitForURL(new RegExp(`/${UUID}/`));
};

const rail = (page: Page) => page.getByRole('navigation', { name: 'Workspaces' });
const composer = (page: Page) => page.locator('main [contenteditable="true"]').first();
const channelButton = (page: Page, name: string) => page.getByRole('group', { name: 'Channels' }).getByRole('button', { name, exact: true });

test('P2: provisioning, login, Collab, private workspace, direct add, isolation, chat, mentions, drafts, search, calls, theme', async ({ browser, request }, testInfo) => {
  test.setTimeout(240_000);
  const shots = (page: Page, name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false });

  const a = provision('ua');
  const b = provision('ub');
  const c = provision('uc');
  let teamWs = '';
  let teamGeneral = '';
  let collabWs = '';

  // 1 ── A platform admin signs in (bootstrap: sign up, promote in the local DB, sign in).
  const adminUser = newUser('padmin');
  const admin = await freshPage(browser);
  const adminErrors = trackPageErrors(admin);
  await test.step('1. platform admin signs in', async () => {
    const boot = await freshPage(browser);
    await signUp(boot, adminUser);
    await boot.waitForURL(new RegExp(`/${UUID}/`));
    await boot.context().close();
    promoteToPlatformAdmin(adminUser.email);
    await logIn(admin, adminUser);
    await admin.waitForURL('**/admin');
  });

  // 2 ── The admin creates accounts directly (no e-mail, no OTP, no link).
  await test.step('2. admin creates three accounts', async () => {
    await admin.getByRole('button', { name: /User Management/ }).click();
    for (const user of [a, b, c]) await createUserAsAdmin(admin, user);
  });

  // 3 ── …and finds them, with their login ids, in the account list.
  await test.step('3. accounts are listed and searchable', async () => {
    await admin.getByPlaceholder('Search by name, username or login').fill(a.username);
    const accounts = admin.getByRole('region', { name: 'Accounts' });
    await expect(accounts.getByText(a.username).first()).toBeVisible();
    await expect(accounts.getByText(a.loginId).first()).toBeVisible();
    await expect(accounts.getByText(b.username)).toHaveCount(0);
    // The API never returns password material.
    const list = await (await apiAs(request, await tokenOf(admin)).get(`/api/admin/users?q=${encodeURIComponent(a.username)}`)).text();
    expect(list).not.toMatch(/password|\$2[aby]\$/i);
  });

  // 4 ── A provisioned person signs in with the login id and password.
  const pa = await freshPage(browser);
  const aErrors = trackPageErrors(pa);
  await test.step('4. user signs in with the admin-issued login id', async () => {
    await logInWithId(pa, a);
  });

  // 5 ── Everyone is in SmartConnect Collab, with its three channels.
  await test.step('5. SmartConnect Collab is there with General, Announcements, Random', async () => {
    const collab = rail(pa).getByRole('group', { name: 'SmartConnect Collab' });
    await expect(collab.getByRole('button', { name: /SmartConnect Collab/ })).toBeVisible();
    await collab.getByRole('button', { name: /SmartConnect Collab/ }).click();
    await pa.waitForURL(new RegExp(`/${UUID}/`));
    collabWs = workspaceIdFrom(pa);
    for (const name of ['General', 'Announcements', 'Random']) {
      await expect(channelButton(pa, name)).toBeVisible();
    }
  });

  // 6 ── Rich text: bold from the toolbar is stored and rendered.
  await test.step('6. formatted message in Collab #General', async () => {
    await channelButton(pa, 'General').click();
    await pa.waitForURL(new RegExp(`/${collabWs}/c/${UUID}$`));
    const editor = composer(pa);
    await editor.click();
    await editor.pressSequentially(`hello collab from ${a.username}`);
    await editor.press('ControlOrMeta+a');
    await pa.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Bold' }).click();
    await editor.press('End');
    await editor.press('Enter');
    await expect(pa.locator('main .rich-text strong', { hasText: `hello collab from ${a.username}` })).toBeVisible();
  });

  // 7 ── A creates a private workspace and owns it.
  await test.step('7. user creates a private workspace', async () => {
    teamWs = await createWorkspace(pa, `Team ${a.username}`);
    teamGeneral = new URL(pa.url()).pathname.split('/')[3];
    await expect(rail(pa).getByRole('group', { name: 'My workspaces' }).getByRole('button', { name: new RegExp(`Team ${a.username}`) })).toBeVisible();
  });

  // 8 ── The owner adds B directly (search → Add); no e-mail involved.
  await test.step('8. owner adds a registered user directly', async () => {
    await pa.goto(`/${teamWs}/settings?tab=members`);
    await pa.getByRole('button', { name: 'Add people' }).click();
    const dialog = pa.getByRole('dialog');
    await dialog.getByPlaceholder('Search by name, username or exact login').fill(b.username);
    await dialog.getByRole('button', { name: `Add ${b.username}` }).click();
    await expect(dialog.getByText('Added')).toBeVisible();
    // C is searchable but never added.
    await dialog.getByPlaceholder('Search by name, username or exact login').fill(c.username);
    await expect(dialog.getByRole('button', { name: `Add ${c.username}` })).toBeVisible();
    await pa.keyboard.press('Escape');
  });

  // 9 ── B sees the workspace under "Shared with me" and can read/post in it.
  const pb = await freshPage(browser);
  const bErrors = trackPageErrors(pb);
  await test.step('9. added user sees it under "Shared with me"', async () => {
    await logInWithId(pb, b);
    const shared = rail(pb).getByRole('group', { name: 'Shared with me' });
    await shared.getByRole('button', { name: new RegExp(`Team ${a.username}`) }).click();
    await pb.waitForURL(new RegExp(`/${teamWs}/`));
    await pb.goto(`/${teamWs}/c/${teamGeneral}`);
    await expect(composer(pb)).toBeVisible();
  });

  // 10 ── Live chat between them.
  await test.step('10. live messages in the private workspace', async () => {
    await pa.goto(`/${teamWs}/c/${teamGeneral}`);
    await sendMessage(pa, 'kickoff notes for the team');
    await expect(pb.getByText('kickoff notes for the team')).toBeVisible();
  });

  // 11 ── @mentions reach the Activity feed.
  await test.step('11. an @mention shows up in Activity', async () => {
    await sendMessage(pb, `@${a.username} thanks for the notes`);
    await expect(pa.locator('main').getByText('thanks for the notes')).toBeVisible();
    await pa.goto(`/${teamWs}/activity`);
    const feed = pa.getByRole('list', { name: 'Activity' });
    await expect(feed.getByRole('button', { name: new RegExp(`${b.username} mentioned you in #general`, 'i') })).toBeVisible();
    await feed.getByRole('button', { name: new RegExp(`${b.username} mentioned you`, 'i') }).click();
    await pa.waitForURL(new RegExp(`/${teamWs}/c/${teamGeneral}$`));
  });

  // 12 ── Someone not added sees nothing of the private workspace.
  await test.step('12. isolation: a non-member cannot see or open it', async () => {
    const pc = await freshPage(browser);
    await logInWithId(pc, c);
    await expect(rail(pc).getByRole('button', { name: new RegExp(`Team ${a.username}`) })).toHaveCount(0);
    await pc.goto(`/${teamWs}/c/${teamGeneral}`);
    await expect(pc).not.toHaveURL(new RegExp(teamWs));
    await expect(pc.getByText('kickoff notes for the team')).toHaveCount(0);
    const asC = apiAs(request, await tokenOf(pc));
    expect((await asC.get(`/api/channels/${teamGeneral}/messages`)).status()).toBe(403);
    expect((await asC.get(`/api/workspaces/${teamWs}/search?q=kickoff`)).status()).toBe(403);
    await pc.context().close();
  });

  // 13 ── Drafts survive switching conversations and never leak between them.
  await test.step('13. per-conversation drafts', async () => {
    const editor = composer(pa);
    await editor.click();
    await editor.pressSequentially('unsent draft for team');
    await rail(pa).getByRole('button', { name: /SmartConnect Collab/ }).click();
    await pa.waitForURL(new RegExp(`/${collabWs}/`));
    await channelButton(pa, 'General').click();
    await expect(composer(pa)).not.toContainText('unsent draft for team');
    await pa.goto(`/${teamWs}/c/${teamGeneral}`);
    await expect(composer(pa)).toContainText('unsent draft for team');
  });

  // 14 ── Workspace search across conversations.
  let dmId = '';
  await test.step('14. search the whole workspace from a DM and jump to the match', async () => {
    // Setup only: A opens a DM with B in the team workspace.
    const bId = (await (await apiAs(request, await tokenOf(pb)).get('/api/auth/me')).json()).id as string;
    const dm = await (await apiAs(request, await tokenOf(pa)).post('/api/channels/dm', { targetUserId: bId, workspaceId: teamWs })).json();
    dmId = dm.id;
    expect(dmId, 'DM created in the team workspace').toMatch(new RegExp(`^${UUID}$`));
    await pb.goto(`/${teamWs}/c/${dmId}`);
    const box = pb.getByRole('combobox', { name: /Search messages in/ });
    await box.fill('kickoff');
    await pb.getByRole('button', { name: `All of Team ${a.username}` }).click();
    const option = pb.getByRole('option', { name: /kickoff notes for the team/ });
    await expect(option).toContainText('in #General');
    await option.click();
    await pb.waitForURL(new RegExp(`/${teamWs}/c/${teamGeneral}$`));
    await expect(pb.getByText('kickoff notes for the team')).toBeVisible();
  });

  // 15 ── Calls: the callee declines; the caller is told and the call ends.
  await test.step('15. a declined call ends for the caller', async () => {
    await pa.goto(`/${teamWs}/c/${dmId}`);
    await pa.getByTitle('Start audio call').click();
    // T.33: calls open in the pre-join lobby first.
    await pa.getByRole('button', { name: 'Start call' }).click();
    await expect(pb.getByText(/Incoming audio call/)).toBeVisible();
    await pb.getByRole('button', { name: /Decline/ }).click();
    await expect(pa.getByText(`${b.username} declined the call.`)).toBeVisible();
    await expect(pa.locator('.theme-fixed.inset-0')).toHaveCount(0);
  });

  // 16 ── Dark theme, chosen in the account menu and remembered.
  await test.step('16. dark theme toggles and persists', async () => {
    await shots(pa, 'p2-light');
    await pa.getByRole('button', { name: 'Account menu' }).click();
    await pa.getByRole('button', { name: 'dark', exact: true }).click();
    await expect(pa.locator('html')).toHaveClass(/dark/);
    await pa.keyboard.press('Escape');
    await pa.reload();
    await expect(pa.locator('html')).toHaveClass(/dark/);
    await expect(composer(pa)).toBeVisible();
    await shots(pa, 'p2-dark');
  });

  expect(adminErrors, 'admin page errors').toEqual([]);
  expect(aErrors, 'user A page errors').toEqual([]);
  expect(bErrors, 'user B page errors').toEqual([]);
});
