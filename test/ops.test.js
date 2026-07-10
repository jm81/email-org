// Integration tests: real HTTP API + real (throwaway) Dovecot.
// Run with: npm test   (starts its own dovecot + app server on port 8399)
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapFlow } from 'imapflow';
import Database from 'better-sqlite3';
import { seed, IMAP, ALICE } from './seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:8399';
let server;

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${data?.error || res.status}`);
  return data;
}

async function waitJob(jobId) {
  for (let i = 0; i < 120; i++) {
    const job = await api('GET', `/api/jobs/${jobId}`);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('job timed out');
}

let alice, bob;
const folderByPath = async (accountId, path) =>
  (await api('GET', `/api/accounts/${accountId}/folders`)).find((f) => f.path === path);

describe('email-org integration', () => {
  before(async () => {
    execFileSync(join(here, 'start-dovecot.sh'), { stdio: 'inherit' });
    await seed();

    server = spawn('node', [join(here, '..', 'server.js')], {
      env: { ...process.env, PORT: '8399', EMAIL_ORG_DATA: join(here, 'tmp', 'data') },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    for (let i = 0; i < 40; i++) {
      try { await fetch(BASE + '/api/accounts'); break; }
      catch { await new Promise((r) => setTimeout(r, 250)); }
    }

    alice = await api('POST', '/api/accounts', {
      name: 'Alice', host: IMAP.host, port: IMAP.port, secure: false, username: 'alice', password: 'alicepw',
    });
    bob = await api('POST', '/api/accounts', {
      name: 'Bob', host: IMAP.host, port: IMAP.port, secure: false, username: 'bob', password: 'bobpw',
    });
  });

  after(() => {
    server?.kill();
    execFileSync(join(here, 'stop-dovecot.sh'), { stdio: 'inherit' });
  });

  test('connection test endpoint', async () => {
    const ok = await api('POST', '/api/accounts/test', {
      host: IMAP.host, port: IMAP.port, secure: false, username: 'alice', password: 'alicepw',
    });
    assert.equal(ok.ok, true);
    assert.ok(ok.capabilities.includes('MOVE'));

    const bad = await api('POST', '/api/accounts/test', {
      host: IMAP.host, port: IMAP.port, secure: false, username: 'alice', password: 'wrong',
    });
    assert.equal(bad.ok, false);
  });

  test('folder list sync builds the tree', async () => {
    const folders = await api('POST', `/api/accounts/${alice.id}/sync`);
    const paths = folders.map((f) => f.path);
    for (const p of ['INBOX', 'Archive', 'Archive.2023', 'Archive.2023.Q1', 'Archive.Empty', 'OldStuff', 'Doomed']) {
      assert.ok(paths.includes(p), `missing ${p}`);
    }
    const q1 = folders.find((f) => f.path === 'Archive.2023.Q1');
    assert.equal(q1.parent_path, 'Archive.2023');
    assert.equal(q1.name, 'Q1');
    assert.equal(q1.delimiter, '.');
    assert.equal(q1.msg_count, 3);
    await api('POST', `/api/accounts/${bob.id}/sync`);
  });

  test('header sync caches messages with dates and flags', async () => {
    const inbox = await folderByPath(alice.id, 'INBOX');
    const synced = await api('POST', `/api/folders/${inbox.id}/sync`);
    assert.equal(synced.msg_count, 5);
    assert.ok(synced.uidvalidity > 0);
    assert.equal(synced.first_msg_date.slice(0, 10), '2022-05-01');
    assert.equal(synced.last_msg_date.slice(0, 10), '2026-06-20');

    const { messages } = await api('GET', `/api/folders/${inbox.id}/messages`);
    assert.equal(messages.length, 5);
    assert.equal(messages[0].subject, 'inbox-5 recent'); // newest first
    const seen = messages.find((m) => m.subject === 'inbox-1 old news');
    assert.ok(JSON.parse(seen.flags).includes('\\Seen'));
  });

  test('body fetch: preview, full, multipart and html-only', async () => {
    const bodies = await folderByPath(alice.id, 'Bodies');
    await api('POST', `/api/folders/${bodies.id}/sync`);
    const { messages } = await api('GET', `/api/folders/${bodies.id}/messages`);

    const multi = messages.find((m) => m.subject === 'multipart mail');
    const preview = await api('GET', `/api/messages/${multi.id}/body?mode=preview`);
    assert.ok(preview.text.includes('Plain part line one.'));
    assert.equal(preview.truncated, true);
    const full = await api('GET', `/api/messages/${multi.id}/body?mode=full`);
    assert.ok(full.text.includes('Line seven.'));

    const htmlOnly = messages.find((m) => m.subject === 'html only mail');
    const htmlBody = await api('GET', `/api/messages/${htmlOnly.id}/body?mode=full`);
    assert.ok(htmlBody.text.includes('Only HTML content here'), `got: ${htmlBody.text}`);
  });

  test('full message view: standalone page, html body in sandboxed srcdoc', async () => {
    const bodies = await folderByPath(alice.id, 'Bodies');
    await api('POST', `/api/folders/${bodies.id}/sync`);
    const { messages } = await api('GET', `/api/folders/${bodies.id}/messages`);

    const htmlOnly = messages.find((m) => m.subject === 'html only mail');
    const res = await fetch(`${BASE}/api/messages/${htmlOnly.id}/view`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.ok(res.headers.get('content-security-policy').includes("default-src 'none'"));
    const page = await res.text();
    assert.ok(page.includes('html only mail'), 'subject in header block');
    assert.ok(page.includes('htmlonly@test'), 'from address in header block');
    assert.ok(page.includes('sandbox='), 'body iframe is sandboxed');
    // The html part is attribute-escaped into the iframe srcdoc.
    assert.ok(page.includes('Only &lt;b&gt;HTML&lt;/b&gt; content here'), `srcdoc missing body html`);

    // multipart/alternative: the html part wins over the text part
    const multi = messages.find((m) => m.subject === 'multipart mail');
    const multiPage = await (await fetch(`${BASE}/api/messages/${multi.id}/view`)).text();
    assert.ok(multiPage.includes('&lt;p&gt;HTML part&lt;/p&gt;'), 'html part preferred');
  });

  test('attachment download via the view page links', async () => {
    const bodies = await folderByPath(alice.id, 'Bodies');
    await api('POST', `/api/folders/${bodies.id}/sync`);
    const { messages } = await api('GET', `/api/folders/${bodies.id}/messages`);
    const attached = messages.find((m) => m.subject === 'mail with attachments');

    const page = await (await fetch(`${BASE}/api/messages/${attached.id}/view`)).text();
    const hrefs = [...page.matchAll(/href="(\/api\/messages\/\d+\/attachment\/\d+)"/g)].map((m) => m[1]);
    assert.equal(hrefs.length, 2, `expected 2 attachment links, page has: ${hrefs}`);
    assert.ok(page.includes('report.pdf') && page.includes('data.csv'));

    const res = await fetch(BASE + hrefs[0]);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="report.pdf"/);
    assert.equal(await res.text(), 'contents of report.pdf');

    const missing = await fetch(`${BASE}/api/messages/${attached.id}/attachment/9`);
    assert.equal(missing.status, 404);
  });

  test('header sync counts attachments', async () => {
    const bodies = await folderByPath(alice.id, 'Bodies');
    await api('POST', `/api/folders/${bodies.id}/sync`);
    const { messages } = await api('GET', `/api/folders/${bodies.id}/messages`);

    const attached = messages.find((m) => m.subject === 'mail with attachments');
    assert.equal(attached.attachment_count, 2);
    // multipart/alternative bodies are content, not attachments
    const multi = messages.find((m) => m.subject === 'multipart mail');
    assert.equal(multi.attachment_count, 0);
  });

  test('resync backfills attachment counts on rows cached without them', async () => {
    const bodies = await folderByPath(alice.id, 'Bodies');
    await api('POST', `/api/folders/${bodies.id}/sync`);

    // Simulate rows cached before the attachment_count column existed.
    const testDb = new Database(join(here, 'tmp', 'data', 'app.db'));
    testDb.prepare('UPDATE messages SET attachment_count = NULL WHERE folder_id = ?').run(bodies.id);
    testDb.close();

    await api('POST', `/api/folders/${bodies.id}/sync`);
    const { messages } = await api('GET', `/api/folders/${bodies.id}/messages`);
    assert.equal(messages.find((m) => m.subject === 'mail with attachments').attachment_count, 2);
    assert.equal(messages.find((m) => m.subject === 'multipart mail').attachment_count, 0);
  });

  test('create and delete a subfolder', async () => {
    const created = await api('POST', '/api/folders', { accountId: alice.id, parentPath: 'Archive', name: 'Fresh' });
    assert.equal(created.path, 'Archive.Fresh');
    assert.equal(created.parent_path, 'Archive');

    await assert.rejects(
      api('POST', '/api/folders', { accountId: alice.id, parentPath: 'Archive', name: 'bad.name' }),
      /may not contain/);

    await api('DELETE', `/api/folders/${created.id}`);
    assert.equal(await folderByPath(alice.id, 'Archive.Fresh'), undefined);
  });

  test('batch delete expunges only the selected messages', async () => {
    const inbox = await folderByPath(alice.id, 'INBOX');
    const { messages } = await api('GET', `/api/folders/${inbox.id}/messages`);
    const victims = messages.filter((m) => ['inbox-2 receipts', 'inbox-4 newsletter'].includes(m.subject));
    const { jobId } = await api('POST', '/api/messages/delete', { messageIds: victims.map((m) => m.id) });
    const job = await waitJob(jobId);
    assert.equal(job.status, 'done');
    assert.deepEqual(job.errors, []);

    const after = await api('GET', `/api/folders/${inbox.id}/messages`);
    const subjects = after.messages.map((m) => m.subject).sort();
    assert.deepEqual(subjects, ['inbox-1 old news', 'inbox-3 hello', 'inbox-5 recent']);
  });

  test('same-account move', async () => {
    const inbox = await folderByPath(alice.id, 'INBOX');
    const old = await folderByPath(alice.id, 'OldStuff');
    const { messages } = await api('GET', `/api/folders/${inbox.id}/messages`);
    const mover = messages.find((m) => m.subject === 'inbox-1 old news');
    const { jobId } = await api('POST', '/api/messages/move', { messageIds: [mover.id], targetFolderId: old.id });
    const job = await waitJob(jobId);
    assert.equal(job.status, 'done');

    const oldMsgs = await api('GET', `/api/folders/${old.id}/messages`);
    assert.ok(oldMsgs.messages.some((m) => m.subject === 'inbox-1 old news'));
    const inboxAfter = await api('GET', `/api/folders/${inbox.id}/messages`);
    assert.equal(inboxAfter.messages.length, 2);
  });

  test('cross-account move preserves flags and date', async () => {
    const inbox = await folderByPath(alice.id, 'INBOX');
    const bobInbox = await folderByPath(bob.id, 'INBOX');
    await api('POST', `/api/folders/${bobInbox.id}/sync`);
    const { messages } = await api('GET', `/api/folders/${inbox.id}/messages`);
    const mover = messages.find((m) => m.subject === 'inbox-3 hello');
    assert.ok(JSON.parse(mover.flags).includes('\\Seen'));

    const { jobId } = await api('POST', '/api/messages/move', { messageIds: [mover.id], targetFolderId: bobInbox.id });
    const job = await waitJob(jobId);
    assert.equal(job.status, 'done');
    assert.deepEqual(job.errors, []);

    const bobMsgs = await api('GET', `/api/folders/${bobInbox.id}/messages`);
    const arrived = bobMsgs.messages.find((m) => m.subject === 'inbox-3 hello');
    assert.ok(arrived, 'message arrived in bob INBOX');
    assert.ok(JSON.parse(arrived.flags).includes('\\Seen'), 'kept \\Seen');
    assert.equal(arrived.internaldate.slice(0, 10), '2024-06-01', 'kept internal date');

    const aliceMsgs = await api('GET', `/api/folders/${inbox.id}/messages`);
    assert.ok(!aliceMsgs.messages.some((m) => m.subject === 'inbox-3 hello'), 'gone from alice');
  });

  test('flatten moves everything up and deletes subfolders', async () => {
    const archive = await folderByPath(alice.id, 'Archive');
    await api('POST', `/api/folders/${archive.id}/sync`);
    const { jobId } = await api('POST', `/api/folders/${archive.id}/flatten`);
    const job = await waitJob(jobId);
    assert.equal(job.status, 'done');
    assert.deepEqual(job.errors, []);

    const folders = await api('GET', `/api/accounts/${alice.id}/folders`);
    const subpaths = folders.filter((f) => f.path.startsWith('Archive.')).map((f) => f.path);
    assert.deepEqual(subpaths, [], 'all subfolders removed');
    const flat = folders.find((f) => f.path === 'Archive');
    assert.equal(flat.msg_count, 7, '1 own + 2 + 3 + 1 moved up');
  });

  test('UIDVALIDITY change blocks destructive ops until resync', async () => {
    const doomed = await folderByPath(alice.id, 'Doomed');
    await api('POST', `/api/folders/${doomed.id}/sync`);
    const { messages } = await api('GET', `/api/folders/${doomed.id}/messages`);
    assert.equal(messages.length, 2);

    // Out-of-band: recreate the folder so its UIDVALIDITY changes.
    await new Promise((r) => setTimeout(r, 1100)); // maildir uidvalidity is time-based
    const c = new ImapFlow({ ...IMAP, auth: ALICE, logger: false });
    await c.connect();
    await c.mailboxDelete('Doomed');
    await c.mailboxCreate('Doomed');
    await c.append('Doomed', 'From: x@y\r\nSubject: innocent bystander\r\n\r\ndo not delete me\r\n');
    await c.logout();

    const { jobId } = await api('POST', '/api/messages/delete', { messageIds: messages.map((m) => m.id) });
    const job = await waitJob(jobId);
    assert.equal(job.status, 'error');
    assert.match(job.errors.join(' '), /resync/i);

    // The bystander must still exist on the server.
    const c2 = new ImapFlow({ ...IMAP, auth: ALICE, logger: false });
    await c2.connect();
    const status = await c2.status('Doomed', { messages: true });
    await c2.logout();
    assert.equal(status.messages, 1);
  });

  test('done marking stores and clears a timestamp', async () => {
    const old = await folderByPath(alice.id, 'OldStuff');
    const marked = await api('POST', `/api/folders/${old.id}/done`, { done: true });
    assert.ok(marked.done_at);
    const refetched = await folderByPath(alice.id, 'OldStuff');
    assert.ok(refetched.done_at);
    const cleared = await api('POST', `/api/folders/${old.id}/done`, { done: false });
    assert.equal(cleared.done_at, null);
  });

  test('deleting a folder with messages requires force', async () => {
    const old = await folderByPath(alice.id, 'OldStuff');
    await api('POST', `/api/folders/${old.id}/sync`);
    await assert.rejects(api('DELETE', `/api/folders/${old.id}`), /contains/);
    await api('DELETE', `/api/folders/${old.id}?force=1`);
    assert.equal(await folderByPath(alice.id, 'OldStuff'), undefined);
  });
});
