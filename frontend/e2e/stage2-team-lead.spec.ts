import { execFileSync } from 'node:child_process';
import { Browser, expect, Page, test } from '@playwright/test';
import { API_URL, apiAs, createWorkspace, logIn, newUser, signUp, tokenOf, trackPageErrors } from './helpers';

/**
 * Stage 2 (T.20), end to end in real browsers: the Company Admin adds a Team
 * Lead in Admin → Team Management and gets a single-use link + temporary
 * password (shown once); the temporary password never signs in; the Team
 * Lead activates once, signs in through the normal sign-in page with their
 * own password and can create a workspace; the link can't be replayed; a
 * pending invitation can be revoked.
 */

const DB = process.env.E2E_DATABASE_URL ?? '';
const LOCAL_DB = /^postgres(ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\//;
const UUID = '[0-9a-f-]{36}';

/** No self-service way to become a Company Admin (by design): promote the test's own account in the LOCAL throwaway E2E database. */
const promoteToCompanyAdmin = (email: string) => {
  if (!LOCAL_DB.test(DB)) throw new Error('Refusing to touch a non-local database.');
  const out = execFileSync(process.env.E2E_PSQL ?? 'psql', [DB, '-v', 'ON_ERROR_STOP=1', '-qtA', '-v', `email=${email}`], {
    input: `UPDATE "User" SET role = 'ADMIN' WHERE email = :'email' RETURNING id;\n`,
  }).toString();
  expect(out.trim().split('\n').filter(Boolean), 'exactly one account promoted').toHaveLength(1);
};

const freshPage = async (browser: Browser) => (await browser.newContext()).newPage();

const addTeamLead = async (admin: Page, email: string, displayName: string) => {
  await admin.getByRole('button', { name: 'Add Team Lead' }).click();
  const form = admin.getByRole('dialog', { name: 'Add Team Lead' });
  await form.getByLabel('E-mail address').fill(email);
  await form.getByLabel('Display name (optional)').fill(displayName);
  await form.getByLabel('Team label (optional)').fill('Design');
  await form.getByRole('button', { name: 'Create Team Lead' }).click();
  const shown = admin.getByRole('dialog', { name: 'Team Lead invitation' });
  await expect(shown.getByText(/only time/i)).toBeVisible();
  const values = shown.locator('code');
  const credentials = {
    activationUrl: (await values.nth(0).textContent())!.trim(),
    loginId: (await values.nth(1).textContent())!.trim(),
    temporaryPassword: (await values.nth(2).textContent())!.trim(),
  };
  await shown.getByRole('button', { name: 'Done' }).click();
  await expect(shown).toHaveCount(0);
  await expect(admin.getByText(credentials.temporaryPassword)).toHaveCount(0); // never shown again
  return credentials;
};

const activate = async (page: Page, activationUrl: string, temporaryPassword: string, newPassword: string) => {
  await page.goto(activationUrl);
  await expect(page.getByRole('heading', { name: 'Activate your SmartConnect account' })).toBeVisible();
  await expect(page).toHaveURL(/\/activate$/); // the token is taken out of the address bar
  await page.getByLabel('Temporary password').fill(temporaryPassword);
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password').fill(newPassword);
  await page.getByRole('button', { name: 'Activate account' }).click();
};

test('Stage 2: Company Admin adds a Team Lead; single-use activation; the temporary password never signs in', async ({ browser }) => {
  test.setTimeout(180_000);
  const adminUser = newUser('s2admin');
  const admin = await freshPage(browser);
  const adminErrors = trackPageErrors(admin);

  await test.step('1. the Company Admin signs in and opens Team Management', async () => {
    const boot = await freshPage(browser);
    await signUp(boot, adminUser);
    await boot.waitForURL(new RegExp(`/${UUID}/`));
    await boot.context().close();
    promoteToCompanyAdmin(adminUser.email);
    await logIn(admin, adminUser);
    await admin.waitForURL('**/admin');
    await admin.getByRole('button', { name: /Team Management/ }).click();
    await expect(admin.getByRole('heading', { name: 'Team Management' })).toBeVisible();
  });

  // Unique per run, so the spec can be re-run against the same throwaway database.
  const run = Date.now().toString(36);
  const priya = `Priya Lead ${run}`;
  const omar = `Omar Lead ${run}`;
  const leadEmail = `e2e_lead_${run}@example.test`;
  const newPassword = `Lead-own-password-${Date.now().toString(36)}`;
  let credentials = { activationUrl: '', loginId: '', temporaryPassword: '' };

  await test.step('2. adding a Team Lead shows a single-use link and temporary password once', async () => {
    credentials = await addTeamLead(admin, leadEmail, priya);
    expect(credentials.loginId).toBe(leadEmail);
    expect(credentials.activationUrl).toMatch(/\/activate#token=[A-Za-z0-9_-]{43}$/);
    expect(credentials.temporaryPassword).toMatch(/^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){3}$/);
    const row = admin.getByRole('listitem').filter({ hasText: priya });
    await expect(row.getByText('Pending', { exact: true })).toBeVisible();
    await expect(row.getByText('Awaiting activation', { exact: true })).toBeVisible(); // T.21: suspended until activation
  });

  const lead = await freshPage(browser);
  const leadErrors = trackPageErrors(lead);

  await test.step('3. the temporary password does not work on the normal sign-in page', async () => {
    const attempt = lead.waitForResponse((r) => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST');
    await logIn(lead, { username: 'x', email: leadEmail, password: credentials.temporaryPassword });
    expect((await attempt).status()).toBe(401);
    // Shown on the form (and also as a toast) — assert the form's message.
    await expect(lead.getByText('Invalid credentials').first()).toBeVisible();
    await expect(lead).toHaveURL(/\/login$/);
  });

  await test.step('4. the Team Lead activates once, then signs in normally with their own password', async () => {
    await activate(lead, credentials.activationUrl, credentials.temporaryPassword, newPassword);
    await expect(lead.getByRole('heading', { name: 'Your account is ready' })).toBeVisible();
    await expect(lead.getByText(leadEmail)).toBeVisible();
    expect(await lead.evaluate(() => localStorage.getItem('token'))).toBeNull(); // activation issued no session
    await lead.getByRole('link', { name: 'Go to sign in' }).click();
    await logIn(lead, { username: 'x', email: leadEmail, password: newPassword });
    await lead.waitForURL(new RegExp(`/${UUID}/`));
    await expect(lead.getByRole('navigation', { name: 'Workspaces' }).getByRole('group', { name: 'SmartConnect Collab' })).toBeVisible();
  });

  await test.step('5. as a Team Lead (granted by the Company Admin, nothing else), they create a team workspace', async () => {
    const before = new URL(lead.url()).pathname.split('/')[1];
    await lead.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Create a workspace' }).click();
    await lead.getByPlaceholder('Acme Corp').fill(`Priya Team ${run}`);
    await lead.getByRole('button', { name: 'Create Workspace' }).click();
    await lead.waitForURL((url) => /^\/[0-9a-f-]{36}\/c\/[0-9a-f-]{36}$/.test(url.pathname) && url.pathname.split('/')[1] !== before);
  });

  await test.step('6. the activation link cannot be replayed', async () => {
    const replay = await freshPage(browser);
    await activate(replay, credentials.activationUrl, credentials.temporaryPassword, `${newPassword}-again`);
    await expect(replay.getByRole('alert')).toContainText('already been used');
    await replay.context().close();
  });

  await test.step('7. the admin sees it Accepted, and can revoke another pending invitation', async () => {
    await admin.getByRole('button', { name: /User Management/ }).click();
    await admin.getByRole('button', { name: /Team Management/ }).click();
    const activated = admin.getByRole('listitem').filter({ hasText: priya });
    await expect(activated.getByText('Accepted', { exact: true })).toBeVisible();
    await expect(activated.getByText('Active', { exact: true })).toBeVisible();

    const second = await addTeamLead(admin, `e2e_lead2_${run}@example.test`, omar);
    const row = admin.getByRole('listitem').filter({ hasText: omar });
    await row.getByRole('button', { name: `Revoke invitation for ${omar}` }).click();
    await admin.getByRole('dialog', { name: 'Revoke invitation?' }).getByRole('button', { name: 'Revoke' }).click();
    await expect(row.getByText('Revoked', { exact: true })).toBeVisible();

    const blocked = await freshPage(browser);
    await activate(blocked, second.activationUrl, second.temporaryPassword, `${newPassword}-omar`);
    await expect(blocked.getByRole('alert')).toContainText('revoked');
    await blocked.context().close();
  });

  expect(adminErrors).toEqual([]);
  expect(leadErrors).toEqual([]);
});

test('T.21: sign-up is invitation-only — refused without an invitation, works through an e-mail invitation link', async ({ browser, request }) => {
  test.setTimeout(120_000);
  // A Team Lead's workspace issues an e-mail invitation (the existing Invitations flow).
  const owner = newUser('s21owner');
  const o = await freshPage(browser);
  const ownerErrors = trackPageErrors(o);
  await signUp(o, owner);
  const workspaceId = await createWorkspace(o, `Invites ${owner.username.slice(-6)}`);
  const ownerToken = await tokenOf(o);
  const SIGNUP_FORM = (page: Page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Create Account' }) });

  await test.step('1. without an invitation, the form explains it and the server refuses it — in the UI and via the API', async () => {
    const stranger = newUser('s21stranger');
    const page = await freshPage(browser);
    await page.goto('/signup');
    await expect(page.getByText(/Sign-up is by invitation only — open the invitation link/)).toBeVisible();
    const form = SIGNUP_FORM(page);
    await form.getByPlaceholder('Samarth Karale').fill(stranger.username);
    await form.locator('input[type="email"]').fill(stranger.email);
    await form.locator('input[type="password"]').fill(stranger.password);
    const attempt = page.waitForResponse((r) => r.url().endsWith('/api/auth/signup') && r.request().method() === 'POST');
    await form.getByRole('button', { name: 'Create Account' }).click();
    expect((await attempt).status()).toBe(403);
    await expect(page.getByText('Sign-up is by invitation only. Open the invitation link you received to create your account.').first()).toBeVisible();
    await expect(page).toHaveURL(/\/signup$/);
    const direct = await request.post(`${API_URL}/api/auth/signup`, { data: { username: stranger.username, email: stranger.email, password: stranger.password } });
    expect(direct.status()).toBe(403);
    expect((await request.post(`${API_URL}/api/auth/login`, { data: { email: stranger.email, password: stranger.password } })).status()).toBe(401);
    await page.context().close();
  });

  const invitee = newUser('s21invitee');
  let inviteToken = '';
  await test.step('2. an e-mail invitation link leads through sign-up into the inviting workspace', async () => {
    const issued = await apiAs(request, ownerToken).post(`/api/workspaces/${workspaceId}/invites`, { email: invitee.email });
    expect(issued.status()).toBe(201);
    inviteToken = (await issued.json()).token;
    const page = await freshPage(browser);
    const errors = trackPageErrors(page);
    await page.goto(`/invite/${inviteToken}`);
    await page.waitForURL(/\/signup\?/);
    await expect(page.getByText('Create your account to get started.')).toBeVisible();
    const form = SIGNUP_FORM(page);
    await expect(form.locator('input[type="email"]')).toHaveValue(invitee.email);
    await form.getByPlaceholder('Samarth Karale').fill(invitee.username);
    await form.locator('input[type="password"]').fill(invitee.password);
    await form.getByRole('button', { name: 'Create Account' }).click();
    await page.waitForURL(new RegExp(`/${workspaceId}/`));
    expect(errors).toEqual([]);
    await page.context().close();
  });

  await test.step('3. the used invitation cannot open another account', async () => {
    const other = newUser('s21other');
    const reuse = await request.post(`${API_URL}/api/auth/signup`, { data: { username: other.username, email: other.email, password: other.password, inviteToken } });
    expect(reuse.status()).toBe(403);
  });

  expect(ownerErrors).toEqual([]);
});
