// Browser smoke test driving the real UI with the system Chrome.
// Prereq: dovecot + seeded server running (see npm run e2e in package.json,
// or run test/start-dovecot.sh, seed.js and the server yourself).
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://127.0.0.1:8399';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const fail = (msg) => { console.error('E2E FAIL:', msg); process.exit(1); };
const ok = (msg) => console.log('  ok -', msg);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const page = await browser.newPage();
page.on('pageerror', (e) => fail(`page error: ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle0' });

// 1. Folder tree renders
await page.waitForSelector('.folder-row', { timeout: 5000 });
const rootFolders = await page.$$eval('.folder-row .folder-name', (els) => els.map((e) => e.textContent));
if (!rootFolders.includes('INBOX') || !rootFolders.includes('Archive')) fail(`tree missing folders: ${rootFolders}`);
ok(`tree renders ${rootFolders.length} root folders`);

// 2. Expand Archive (twisty) and see children
const archiveRow = await page.evaluateHandle(() =>
  [...document.querySelectorAll('.folder-row')].find((r) => r.querySelector('.folder-name').textContent === 'Archive'));
await (await archiveRow.asElement().$('.twisty')).click();
await page.waitForFunction(() =>
  [...document.querySelectorAll('.folder-name')].some((e) => e.textContent === '2023'), { timeout: 3000 });
ok('expand/collapse works (Archive > 2023 visible)');

// 3. Click INBOX -> message list loads (first open triggers header sync)
await page.evaluate(() =>
  [...document.querySelectorAll('.folder-row')].find((r) => r.querySelector('.folder-name').textContent === 'INBOX').click());
await page.waitForSelector('table.messages tr.msg', { timeout: 15000 });
const subjects = await page.$$eval('tr.msg td:nth-child(3)', (els) => els.map((e) => e.textContent));
if (subjects.length !== 5) fail(`expected 5 inbox messages, got ${subjects.length}: ${subjects}`);
if (subjects[0] !== 'inbox-5 recent') fail(`expected newest first, got ${subjects[0]}`);
ok('folder click loads message list (5 messages, newest first)');

// 4. Click a row -> inline preview with body text
await page.click('tr.msg');
await page.waitForSelector('tr.msg-body', { timeout: 10000 });
await page.waitForFunction(() => !document.querySelector('tr.msg-body td')?.textContent.includes('Loading'), { timeout: 10000 });
const preview = await page.$eval('tr.msg-body td', (e) => e.textContent);
if (!preview.includes('Body of inbox-5 recent')) fail(`preview text wrong: ${preview}`);
ok('row click shows inline body preview');

// 5. Click again -> collapses
await page.click('tr.msg');
await page.waitForFunction(() => !document.querySelector('tr.msg-body'), { timeout: 3000 });
ok('second click collapses preview');

// 6. Checkbox selection -> batch bar appears with count
// (select the OLDEST message so deleting it keeps INBOX "recently active"
// for the quiet-filter assertion below)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('tr.msg')];
  rows[rows.length - 1].querySelector('input[type=checkbox]').click();
});
await page.waitForSelector('#batch-bar:not([hidden])', { timeout: 3000 });
const barText = await page.$eval('#batch-bar', (e) => e.textContent);
if (!barText.includes('1 selected')) fail(`batch bar text: ${barText}`);
ok('selection shows batch bar');

// 7. Delete flow with inline confirm (against the throwaway server!)
await page.evaluate(() =>
  [...document.querySelectorAll('#batch-bar button')].find((b) => b.textContent === 'Delete').click());
await page.waitForFunction(() => document.querySelector('#batch-bar')?.textContent.includes('Delete 1 message'), { timeout: 3000 });
ok('confirm bar asks once');
await page.evaluate(() =>
  [...document.querySelectorAll('#batch-bar button')].find((b) => b.textContent === 'Delete').click());
await page.waitForFunction(() => document.querySelectorAll('tr.msg').length === 4, { timeout: 15000 });
ok('batch delete removes the message from the list');

// 8. Per-message context menu (right-click a row) deletes that single message
// (again the oldest row, to keep INBOX recently active for the quiet filter)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('tr.msg')];
  rows[rows.length - 1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
});
await page.waitForSelector('#context-menu:not([hidden])', { timeout: 3000 });
const msgMenu = await page.$$eval('#context-menu .item', (els) => els.map((e) => e.textContent));
if (!msgMenu.includes('Move to…')) fail(`message menu missing Move to…: ${msgMenu}`);
if (!msgMenu.includes('Delete')) fail(`message menu missing Delete: ${msgMenu}`);
await page.evaluate(() =>
  [...document.querySelectorAll('#context-menu .item')].find((i) => i.textContent === 'Delete').click());
await page.waitForFunction(() => document.querySelector('#batch-bar')?.textContent.includes('Delete "inbox-'), { timeout: 3000 });
await page.evaluate(() =>
  [...document.querySelectorAll('#batch-bar button')].find((b) => b.textContent === 'Delete').click());
await page.waitForFunction(() => document.querySelectorAll('tr.msg').length === 3, { timeout: 15000 });
ok('message context menu deletes a single message');

// 9. Open full message: new tab with headers + body in a sandboxed iframe
const viewTargetPromise = browser.waitForTarget((t) => t.url().includes('/view'), { timeout: 10000 });
await page.evaluate(() =>
  document.querySelector('tr.msg').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 })));
await page.waitForSelector('#context-menu:not([hidden])', { timeout: 3000 });
await page.evaluate(() =>
  [...document.querySelectorAll('#context-menu .item')].find((i) => i.textContent === 'Open full message').click());
const viewPage = await (await viewTargetPromise).page();
await viewPage.waitForSelector('iframe[sandbox]', { timeout: 10000 });
const viewHeader = await viewPage.$eval('header', (e) => e.textContent);
if (!viewHeader.includes('inbox-5 recent')) fail(`view header missing subject: ${viewHeader}`);
let bodyText = '';
for (let i = 0; i < 40 && !bodyText.includes('Body of inbox-5 recent'); i++) {
  const frame = viewPage.frames().find((f) => f.url() === 'about:srcdoc');
  if (frame) bodyText = await frame.evaluate(() => document.body?.textContent ?? '').catch(() => '');
  if (!bodyText.includes('Body of inbox-5 recent')) await new Promise((r) => setTimeout(r, 250));
}
if (!bodyText.includes('Body of inbox-5 recent')) fail(`view body iframe text: ${bodyText}`);
await viewPage.close();
ok('Open full message renders headers + body in a new tab');

// 10. Context menu on folder (right-click)
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.folder-row')].find((r) => r.querySelector('.folder-name').textContent === 'Archive');
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
});
await page.waitForSelector('#context-menu:not([hidden])', { timeout: 3000 });
const menuItems = await page.$$eval('#context-menu .item', (els) => els.map((e) => e.textContent));
if (!menuItems.some((t) => t.includes('Add subfolder'))) fail(`menu items: ${menuItems}`);
if (!menuItems.some((t) => t.includes('Flatten'))) fail(`menu missing flatten: ${menuItems}`);
ok(`context menu shows: ${menuItems.join(' | ')}`);

// 11. Go to… picker jumps to a folder and expands the tree down to it
await page.keyboard.press('Escape'); // close the folder context menu
await page.click('#btn-goto');
await page.waitForSelector('#folder-picker input', { timeout: 3000 });
await page.type('#folder-picker input', 'q1');
await page.keyboard.press('Enter');
await page.waitForFunction(() =>
  document.querySelector('#folder-title')?.textContent === 'Archive / 2023 / Q1', { timeout: 15000 });
const selectedName = await page.evaluate(() =>
  document.querySelector('.folder-row.selected .folder-name')?.textContent);
if (selectedName !== 'Q1') fail(`expected Q1 selected in tree, got: ${selectedName}`);
await page.waitForFunction(() => document.querySelectorAll('tr.msg').length === 3, { timeout: 15000 });
ok('Go to… opens the folder and expands the tree to it');

// 12. Rename a folder via the context menu's inline input
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.folder-row')].find((r) => r.querySelector('.folder-name')?.textContent === 'Doomed');
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
});
await page.waitForSelector('#context-menu:not([hidden])', { timeout: 3000 });
await page.evaluate(() =>
  [...document.querySelectorAll('#context-menu .item')].find((i) => i.textContent === 'Rename').click());
await page.waitForSelector('.folder-row input.inline-input', { timeout: 3000 });
await page.evaluate(() => { document.querySelector('.folder-row input.inline-input').value = ''; });
await page.type('.folder-row input.inline-input', 'Doomed2');
await page.keyboard.press('Enter');
await page.waitForFunction(() =>
  [...document.querySelectorAll('.folder-name')].some((e) => e.textContent === 'Doomed2'), { timeout: 10000 });
ok('folder rename via context menu inline input');

// 13. Quiet-folder filter hides recently-active folders
await page.keyboard.press('Escape');
await page.click('#filter-quiet');
await page.waitForFunction(() =>
  ![...document.querySelectorAll('.folder-name')].some((e) => e.textContent === 'INBOX'), { timeout: 3000 });
const remaining = await page.$$eval('.folder-row .folder-name', (els) => els.map((e) => e.textContent));
if (!remaining.includes('OldStuff')) fail(`quiet filter should keep OldStuff: ${remaining}`);
ok(`quiet filter hides active folders, keeps: ${remaining.join(', ')}`);

await browser.close();
console.log('E2E PASS');
