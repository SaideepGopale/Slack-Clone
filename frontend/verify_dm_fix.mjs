import { chromium } from 'playwright';

const SCREENSHOT_DIR = '/private/tmp/claude-501/-Users-samarthdattatraykarale-Desktop-Slack-Clone/e2d2ac44-3cdc-4ae9-96af-02ab935e28f1/scratchpad';

const EMAIL_A = 'dmA1784713845332@example.com';
const EMAIL_B = 'dmB1784713845332@example.com';
const USERNAME_B = 'dmB1784713845332';
const PASSWORD = 'DmTest123!';

const browser = await chromium.launch();
const pageA = await (await browser.newContext()).newPage();
const pageB = await (await browser.newContext()).newPage();
const errorsA = [];
pageA.on('console', (m) => { if (m.type() === 'error') errorsA.push(m.text()); });
pageA.on('pageerror', (e) => errorsA.push('PAGE ERROR: ' + e.message));

async function login(page, email) {
  await page.goto('http://localhost:5173/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/[a-f0-9-]{36}\/c\/[a-f0-9-]{36}/, { timeout: 15000 });
}

console.log('1. Logging in both users (Default Workspace)...');
await login(pageA, EMAIL_A);
await login(pageB, EMAIL_B);

console.log('2. BEFORE starting any DM: checking A\'s sidebar has no DM entries and CHANNELS only shows General...');
await pageA.waitForTimeout(800);
const channelsTextBefore = await pageA.locator('text=CHANNELS').locator('xpath=ancestor::div[1]/following-sibling::div[1]').innerText().catch(() => '');
await pageA.screenshot({ path: `${SCREENSHOT_DIR}/dmfix-1-before.png` });

console.log('3. A starts a DM with B via People page...');
await pageA.getByRole('button', { name: 'People', exact: true }).click();
await pageA.waitForURL(/\/directory$/, { timeout: 10000 });
await pageA.getByRole('button', { name: 'People', exact: true }).last().click();
await pageA.waitForTimeout(500);
await pageA.getByText(USERNAME_B, { exact: true }).first().click().catch(async () => {
  // Fall back to clicking the "Message" button in that user's card if the name itself isn't the click target.
  const card = pageA.locator('div', { hasText: USERNAME_B }).last();
  await card.getByRole('button', { name: 'Message' }).click();
});
await pageA.waitForURL(/\/c\//, { timeout: 10000 });
console.log('   Navigated into the DM:', pageA.url());

console.log('4. A sends a message in the DM (activating the conversation)...');
await pageA.locator('[contenteditable="true"]').first().click();
await pageA.keyboard.type('Hey B, this is a real DM');
await pageA.keyboard.press('Enter');
await pageA.waitForTimeout(1000);

console.log('5. Checking A\'s sidebar: DM should appear under Direct Messages, NOT under Channels...');
await pageA.screenshot({ path: `${SCREENSHOT_DIR}/dmfix-2-after-dm.png` });

const channelsSectionText = await pageA.locator('text=Channels').first().locator('xpath=../..').innerText();
console.log('   Channels section text snapshot:', JSON.stringify(channelsSectionText));
const bNameInChannels = channelsSectionText.includes(USERNAME_B);
console.log('   Username B leaking into CHANNELS section (expect false):', bNameInChannels);

const dmSectionVisible = await pageA.locator('text=Direct Messages').isVisible();
const dmEntryVisible = await pageA.locator(`text=${USERNAME_B}`).count();
console.log('   Direct Messages section visible:', dmSectionVisible, '| entries matching username B found:', dmEntryVisible);

console.log('6. Console errors on A:', errorsA.length);
errorsA.forEach(e => console.log('   ERROR:', e));

await browser.close();
console.log('DONE');
