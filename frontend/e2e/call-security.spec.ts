import { APIRequestContext, Browser, expect, Page, test } from '@playwright/test';
import { io } from 'socket.io-client';
import { API_URL, apiAs, createWorkspace, E2EUser, newUser, signUp, tokenOf, trackPageErrors } from './helpers';

/**
 * P1-A — FA-RT-01 end to end: WebRTC call signaling only reaches participants
 * of the same call, a legitimate channel call still connects for real, and
 * microphone/camera are only requested by an explicit Start call / Accept.
 */

// Counts getUserMedia calls and keeps every RTCPeerConnection the page creates.
const instrument = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __gum: number; __pcs: RTCPeerConnection[] };
    w.__gum = 0;
    w.__pcs = [];
    const devices = navigator.mediaDevices;
    if (devices?.getUserMedia) {
      const original = devices.getUserMedia.bind(devices);
      devices.getUserMedia = (constraints?: MediaStreamConstraints) => {
        w.__gum += 1;
        return original(constraints);
      };
    }
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeerConnection {
      constructor(config?: RTCConfiguration) {
        super(config);
        w.__pcs.push(this);
      }
    } as typeof RTCPeerConnection;
  });

type Probe = { __gum: number; __pcs: RTCPeerConnection[] };
const mediaRequests = (page: Page) => page.evaluate(() => (window as unknown as Probe).__gum);
const peerConnections = (page: Page) => page.evaluate(() => (window as unknown as Probe).__pcs.length);
const hasConnectedPeer = (page: Page) =>
  page.evaluate(() => (window as unknown as Probe).__pcs.some((pc) => pc.connectionState === 'connected'));

const userIdOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).id as string;

const newPage = async (browser: Browser) => {
  const page = await (await browser.newContext()).newPage();
  await instrument(page);
  return page;
};

/** Joins `joiner` to a workspace through the existing invite-link + approval API (setup only). */
const joinViaLink = async (request: APIRequestContext, ownerToken: string, joinerToken: string, workspaceId: string, joiner: E2EUser) => {
  const owner = apiAs(request, ownerToken);
  const link = await (await owner.get(`/api/workspaces/${workspaceId}/invite-link`)).json();
  const token = new URL(link.url).searchParams.get('token');
  expect((await (await apiAs(request, joinerToken).post('/api/workspaces/join', { token })).json()).status).toBe('pending');
  const requests = await (await owner.get(`/api/workspaces/${workspaceId}/requests`)).json();
  const mine = requests.find((r: { user: { username: string } }) => r.user.username === joiner.username);
  expect((await owner.put(`/api/workspaces/${workspaceId}/requests/${mine.id}`, { action: 'APPROVE' })).ok()).toBeTruthy();
};

test('call signaling reaches only participants of the same call; media needs an explicit start or accept', async ({ browser, request }) => {
  const [a, b, c, m] = [await newPage(browser), await newPage(browser), await newPage(browser), await newPage(browser)];
  const errors = [a, b, c, m].map(trackPageErrors);
  const alice = newUser('callee');
  const bob = newUser('peer');
  const carol = newUser('bystander');
  const mallory = newUser('attacker');

  // Workspace A: Alice (owner), Bob and Carol. Workspace M: Mallory only.
  await signUp(a, alice);
  const workspaceA = await createWorkspace(a, `Calls ${alice.username}`);
  const generalA = new URL(a.url()).pathname.split('/')[3];
  await signUp(b, bob);
  await signUp(c, carol);
  const aliceToken = await tokenOf(a);
  await joinViaLink(request, aliceToken, await tokenOf(b), workspaceA, bob);
  await joinViaLink(request, aliceToken, await tokenOf(c), workspaceA, carol);
  await signUp(m, mallory);
  const workspaceM = await createWorkspace(m, `Lair ${mallory.username}`);
  const generalM = new URL(m.url()).pathname.split('/')[3];
  expect(workspaceM).not.toBe(workspaceA);
  for (const page of [b, c]) {
    // P2: "/" returns people to their last active workspace (SmartConnect Collab for a new account), so open the joined one directly.
    await page.goto(`/${workspaceA}`);
    await page.waitForURL(new RegExp(`/${workspaceA}/c/${generalA}$`));
  }

  // 1. Alice starts a call in A's General (explicit action). Media is requested only after that click.
  //    (The dev build runs React StrictMode, which mounts the call overlay twice, so the count may be 2.)
  expect(await mediaRequests(a)).toBe(0);
  await a.getByTitle('Start audio call').click();
  await expect.poll(() => mediaRequests(a)).toBeGreaterThan(0);
  await expect(b.getByText(/Incoming audio call/)).toBeVisible();
  await expect(c.getByText(/Incoming audio call/)).toBeVisible();
  expect(await mediaRequests(b)).toBe(0); // ringing never touches the microphone/camera
  expect(await mediaRequests(c)).toBe(0);

  // 2. Bob accepts (explicit action): the legitimate channel call really connects.
  await b.getByRole('button', { name: /Accept/ }).click();
  await expect.poll(() => mediaRequests(b)).toBeGreaterThan(0);
  await expect.poll(() => hasConnectedPeer(a), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => hasConnectedPeer(b), { timeout: 30_000 }).toBe(true);
  await expect(a.getByText('Connecting audio call…')).toHaveCount(0);
  await expect(b.getByText('Connecting audio call…')).toHaveCount(0);
  expect(await peerConnections(a)).toBe(1);
  expect(await peerConnections(b)).toBe(1);
  const [aliceMedia, bobMedia] = [await mediaRequests(a), await mediaRequests(b)];

  // 3. Mallory (another workspace) joins a call she IS allowed in — her own General —
  //    then aims real WebRTC offers at Alice's call from outside it.
  const attacker = io(API_URL, { auth: { token: await tokenOf(m) }, transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise<void>((resolve, reject) => {
    attacker.once('connect', () => resolve());
    attacker.once('connect_error', reject);
  });
  const joined = new Promise((resolve) => attacker.once('webrtc:existing-participants', resolve));
  attacker.emit('webrtc:join', { channelId: generalM });
  await joined;
  const leaked: unknown[] = [];
  for (const event of ['webrtc:answer', 'webrtc:offer', 'webrtc:ice-candidate']) attacker.on(event, (payload) => leaked.push({ event, payload }));
  const offer = await m.evaluate(async () => {
    const pc = new RTCPeerConnection();
    pc.addTransceiver('audio');
    pc.addTransceiver('video');
    const description = await pc.createOffer();
    return { type: description.type, sdp: description.sdp };
  });
  for (const to of [`user:${userIdOf(aliceToken)}`, `ws:${workspaceA}`, generalA, `call:${generalA}`]) {
    attacker.emit('webrtc:offer', { channelId: generalM, to, offer });
    attacker.emit('webrtc:offer', { channelId: generalA, to, offer });
  }
  await a.waitForTimeout(4_000);

  // Nothing reached Alice's call or anyone else: no answer back, no new peer connection, no media.
  expect(leaked).toEqual([]);
  expect(await peerConnections(a)).toBe(1);
  expect(await peerConnections(b)).toBe(1);
  expect(await peerConnections(c)).toBe(0);
  expect(await mediaRequests(a)).toBe(aliceMedia); // offers never trigger a media request
  expect(await mediaRequests(b)).toBe(bobMedia);
  expect(await mediaRequests(c)).toBe(0); // Carol never accepted
  expect(await hasConnectedPeer(a)).toBe(true); // the legitimate call is unaffected
  attacker.disconnect();

  // 4. The call still ends normally.
  await a.getByTitle('End call').click();
  await b.getByTitle('End call').click();
  await expect(a.getByTitle('End call')).toHaveCount(0);
  for (const list of errors) expect(list).toEqual([]);
});

/** The ringing banner (top-right), not other places a username may appear. */
const incomingBanner = (page: Page) => page.locator('div.fixed').filter({ hasText: /Incoming (audio|video) call/ });

/**
 * P1-B — FA-RT-02 end to end: the incoming-call banner always shows the real,
 * server-derived caller, and spoofed or malformed ring requests from a channel
 * member are refused by the server — they never reach or crash anyone's UI.
 */
test('incoming calls show the real caller; spoofed or malformed rings never reach or crash the recipient', async ({ browser, request }) => {
  const [a, b, c] = [await newPage(browser), await newPage(browser), await newPage(browser)];
  const errors = [a, b, c].map(trackPageErrors);
  const alice = newUser('caller');
  const bob = newUser('callee');
  const carol = newUser('ringer');

  await signUp(a, alice);
  const workspace = await createWorkspace(a, `Rings ${alice.username}`);
  const general = new URL(a.url()).pathname.split('/')[3];
  await signUp(b, bob);
  await signUp(c, carol);
  const aliceToken = await tokenOf(a);
  await joinViaLink(request, aliceToken, await tokenOf(b), workspace, bob);
  await joinViaLink(request, aliceToken, await tokenOf(c), workspace, carol);
  // P2: "/" returns people to their last active workspace (SmartConnect Collab for a new account), so open the joined one directly.
  await b.goto(`/${workspace}`);
  await b.waitForURL(new RegExp(`/${workspace}/c/${general}$`));

  // 1. A normal ring from the UI shows the caller's real (server-derived) name.
  await a.getByTitle('Start audio call').click();
  await expect(incomingBanner(b)).toContainText('Incoming audio call');
  await expect(incomingBanner(b)).toContainText(alice.username);
  await b.getByRole('button', { name: /Decline/ }).click();
  await expect(incomingBanner(b)).toHaveCount(0);
  await a.getByTitle('End call').click();

  // 2. Carol, a real channel member, rings through a raw socket with hostile payloads.
  const ringer = io(API_URL, { auth: { token: await tokenOf(c) }, transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise<void>((resolve, reject) => {
    ringer.once('connect', () => resolve());
    ringer.once('connect_error', reject);
  });
  const refusals: unknown[] = [];
  ringer.on('webrtc:error', (error) => refusals.push(error));
  const hostile = [
    { channelId: general, callType: 'audio', callerName: 'IT Support (Admin)' },
    { channelId: general, callType: 'audio', callerName: alice.username }, // impersonating the workspace owner
    { channelId: general, callType: 'audio', from: userIdOf(aliceToken) },
    { channelId: general, callType: 'audio', callerName: null },
    { channelId: general, callType: 'audio', callerName: { name: 'x' } },
    { channelId: general, callType: 'audio', callerName: 'x'.repeat(50_000) },
    { channelId: general, callType: 'screen' },
    { channelId: general, callType: { type: 'video' } },
  ];
  for (const payload of hostile) ringer.emit('call:initiate', payload);
  await expect.poll(() => refusals.length).toBe(hostile.length);
  await b.waitForTimeout(1_500);
  await expect(incomingBanner(b)).toHaveCount(0);
  await expect(b.getByText('IT Support (Admin)')).toHaveCount(0);

  // 3. Well-formed rings from the same socket arrive under Carol's real name —
  //    including the older payload shape that still carries her own name.
  ringer.emit('call:initiate', { channelId: general, callType: 'audio', callerName: carol.username });
  await expect(incomingBanner(b)).toContainText(carol.username);
  await b.getByRole('button', { name: /Decline/ }).click();
  await expect(incomingBanner(b)).toHaveCount(0);
  ringer.emit('call:initiate', { channelId: general, callType: 'video' });
  await expect(incomingBanner(b)).toContainText('Incoming video call');
  await expect(incomingBanner(b)).toContainText(carol.username);
  await b.getByRole('button', { name: /Decline/ }).click();
  ringer.disconnect();

  expect(refusals).toHaveLength(hostile.length); // the valid rings were not refused
  expect(await mediaRequests(b)).toBe(0); // ringing never touches the microphone/camera
  for (const list of errors) expect(list).toEqual([]);
});
