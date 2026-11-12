import { expect, Page, test } from '@playwright/test';
import { API_URL, apiAs, createWorkspace, newUser, pageToken, signUp, trackPageErrors } from './helpers';

/**
 * T.37 — several users side by side in ONE browser profile: three tabs of one
 * browser context (shared localStorage and cookies, like tabs of one Chrome
 * profile), each with its own development tab sign-in (?tabSession=1).
 *
 * Every API request and Socket.IO handshake is recorded per tab and checked
 * against the user that tab signed in as; Socket.IO frames are recorded to
 * show which tab received which events.
 */

const userIdOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).id as string;
const frameText = (payload: string | Buffer) => (typeof payload === 'string' ? payload : payload.toString('utf8'));

/** The users behind every authenticated API request and socket handshake this tab makes, plus the socket frames it receives. */
const watchTab = (page: Page) => {
  const seen = { apiUsers: new Set<string>(), socketUsers: new Set<string>(), framesIn: [] as string[], apiRequests: 0 };
  page.on('request', (req) => {
    if (!req.url().startsWith(`${API_URL}/api/`)) return;
    const auth = req.headers()['authorization'];
    if (!auth?.startsWith('Bearer ')) return;
    seen.apiRequests++;
    seen.apiUsers.add(userIdOf(auth.slice(7)));
  });
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      const m = /^40(\{.*\})$/.exec(frameText(f.payload)); // Socket.IO CONNECT with the auth payload
      if (m) {
        const token = (JSON.parse(m[1]) as { token?: string }).token;
        if (token) seen.socketUsers.add(userIdOf(token));
      }
    });
    ws.on('framereceived', (f) => seen.framesIn.push(frameText(f.payload)));
  });
  return seen;
};

const panel = (page: Page) => page.getByRole('region', { name: 'Development tab sign-in' });

test('three users in three tabs of one browser profile: separate identities, requests, sockets and logout', async ({ browser, request }) => {
  const context = await browser.newContext(); // ONE profile for all tabs
  const run = Date.now().toString(36);
  const users = { lead: newUser('t37lead'), dev1: newUser('t37dev1'), dev2: newUser('t37dev2') };
  const tabs = { lead: await context.newPage(), dev1: await context.newPage(), dev2: await context.newPage() };
  const watch = { lead: watchTab(tabs.lead), dev1: watchTab(tabs.dev1), dev2: watchTab(tabs.dev2) };
  const errors = { lead: trackPageErrors(tabs.lead), dev1: trackPageErrors(tabs.dev1), dev2: trackPageErrors(tabs.dev2) };
  const ids: Record<keyof typeof users, string> = { lead: '', dev1: '', dev2: '' };
  const tokens: Record<keyof typeof users, string> = { lead: '', dev1: '', dev2: '' };

  await test.step('1. each tab gets its own sign-in and signs in as a different user', async () => {
    for (const key of ['lead', 'dev1', 'dev2'] as const) {
      const tab = tabs[key];
      await tab.goto('/login?tabSession=1');
      await expect(panel(tab)).toContainText('This tab: signed out');
      await expect(tab).toHaveURL(/\/login$/); // the switch is taken out of the address bar
      await signUp(tab, users[key]);
      await expect(panel(tab)).toContainText(`This tab: ${users[key].username}`);
      tokens[key] = (await pageToken(tab))!;
      ids[key] = userIdOf(tokens[key]);
    }
    // Three different sessions; the shared (localStorage) sign-in was never written.
    expect(new Set(Object.values(tokens)).size).toBe(3);
    expect(await tabs.lead.evaluate(() => localStorage.getItem('token'))).toBeNull();
    // Earlier tabs were not taken over by later sign-ins — after a reload too.
    for (const key of ['lead', 'dev1', 'dev2'] as const) {
      await tabs[key].reload();
      await expect(panel(tabs[key])).toContainText(`This tab: ${users[key].username}`);
      await expect(tabs[key]).toHaveTitle(new RegExp(`^\\[${users[key].username}\\] `));
      const me = await (await apiAs(request, tokens[key]).get('/api/auth/me')).json();
      expect(me.username).toBe(users[key].username);
    }
  });

  let workspaceId = '';
  let projectId = '';
  const title = `Integrate payments ${run}`;
  await test.step('2. setup: the lead’s workspace with both developers; a private project with Developer 1 only', async () => {
    workspaceId = await createWorkspace(tabs.lead, `T37 Team ${run}`);
    tokens.lead = (await pageToken(tabs.lead))!; // unchanged session, re-read after the reload in createWorkspace
    const lead = apiAs(request, tokens.lead);
    for (const key of ['dev1', 'dev2'] as const) expect((await lead.post(`/api/workspaces/${workspaceId}/members`, { userId: ids[key] })).status()).toBe(201);
    const project = await lead.post(`/api/workspaces/${workspaceId}/projects`, { name: `Payments ${run}`, visibility: 'PRIVATE', key: 'PAY' });
    expect(project.status(), await project.text()).toBe(201);
    projectId = (await project.json()).id ?? (await project.json()).project?.id;
    expect((await lead.post(`/api/projects/${projectId}/members`, { userId: ids.dev1 })).status()).toBe(201);
  });
  const projectUrl = `/${workspaceId}/projects/${projectId}`;

  await test.step('3. Team Lead tab: create the task and assign it to Developer 1', async () => {
    await tabs.lead.goto(projectUrl);
    const input = tabs.lead.getByLabel('New task in To do');
    if (!(await input.isVisible())) await tabs.lead.getByRole('listitem', { name: /^To do column/ }).getByRole('button', { name: 'Add task' }).click();
    await input.fill(title);
    await input.press('Enter');
    await tabs.lead.getByRole('button', { name: new RegExp(`PAY-\\d+: ${title}`) }).click();
    const drawer = tabs.lead.getByRole('dialog');
    await drawer.getByRole('combobox', { name: 'Assignee' }).selectOption({ label: users.dev1.username });
    await expect(drawer.getByRole('combobox', { name: 'Assignee' })).toHaveValue(ids.dev1);
    await tabs.lead.keyboard.press('Escape');
  });

  await test.step('4. Developer 1 tab: sees it under My Tasks and moves it to In progress; the lead’s board updates live', async () => {
    await tabs.dev1.goto(`/${workspaceId}/tasks`);
    await tabs.dev1.getByText(title).click();
    const drawer = tabs.dev1.getByRole('dialog');
    await drawer.getByRole('combobox', { name: 'Status' }).selectOption('IN_PROGRESS');
    await expect(drawer.getByRole('combobox', { name: 'Status' })).toHaveValue('IN_PROGRESS');
    // The lead's tab (no reload) receives the change over its own socket.
    await expect(tabs.lead.getByRole('listitem', { name: /^In progress column, 1 task/ })).toBeVisible();
    const task = (await (await apiAs(request, tokens.lead).get(`/api/projects/${projectId}/tasks`)).json()) as { id: string; title: string; status: string; assignee?: { id: string } | null; assigneeId?: string }[] | { tasks: { id: string; title: string; status: string }[] };
    const list = Array.isArray(task) ? task : task.tasks;
    expect(list.find((t) => t.title === title)?.status).toBe('IN_PROGRESS');
  });

  await test.step('5. Developer 2 tab: no access to the private project or its task, and none of its events', async () => {
    const dev2 = apiAs(request, tokens.dev2);
    expect((await dev2.get(`/api/projects/${projectId}`)).status()).toBe(404);
    expect((await dev2.get(`/api/projects/${projectId}/tasks`)).status()).toBe(404);
    await tabs.dev2.goto(projectUrl);
    await expect(tabs.dev2.getByText(/not found/i).first()).toBeVisible();
    await expect(tabs.dev2.getByText(title)).toHaveCount(0);
    // Positive control: the lead's socket did receive the task's events; Developer 2's never did.
    expect(watch.lead.framesIn.some((f) => f.includes(title))).toBe(true);
    expect(watch.dev2.framesIn.some((f) => f.includes(title) || f.includes(projectId))).toBe(false);
  });

  await test.step('6. every API request and socket handshake carried its own tab’s identity', async () => {
    for (const key of ['lead', 'dev1', 'dev2'] as const) {
      expect(watch[key].apiRequests, `${key} made API requests`).toBeGreaterThan(0);
      expect([...watch[key].apiUsers], `${key} API identity`).toEqual([ids[key]]);
      expect([...watch[key].socketUsers], `${key} socket identity`).toEqual([ids[key]]);
    }
  });

  await test.step('7. Developer 1 signs out: only that session ends; the other two tabs stay signed in', async () => {
    await tabs.dev1.goto(`/${workspaceId}`);
    await tabs.dev1.getByRole('button', { name: 'Sign out' }).first().click();
    await tabs.dev1.waitForURL(/\/login/);
    await expect(panel(tabs.dev1)).toContainText('This tab: signed out');
    await expect.poll(async () => (await apiAs(request, tokens.dev1).get('/api/auth/me')).status()).toBe(401); // revoked on the server
    for (const key of ['lead', 'dev2'] as const) {
      await tabs[key].reload();
      await expect(panel(tabs[key])).toContainText(`This tab: ${users[key].username}`);
      expect((await apiAs(request, tokens[key]).get('/api/auth/me')).status()).toBe(200);
    }
    await expect(tabs.lead.getByRole('listitem', { name: /^In progress column, 1 task/ })).toBeVisible();
  });

  await test.step('8. a normal tab in the same profile is unaffected: it uses the shared sign-in, which nobody wrote', async () => {
    const shared = await context.newPage();
    await shared.goto('/');
    await shared.waitForURL(/\/login/);
    await expect(panel(shared)).toContainText('Shared sign-in');
    await shared.close();
  });

  expect(errors).toEqual({ lead: [], dev1: [], dev2: [] });
  await context.close();
});
