import { ImapFlow } from 'imapflow';
import { getAccount } from '../accounts.js';

const clients = new Map();  // accountId -> ImapFlow
const queues = new Map();   // accountId -> tail promise

function buildClient(account) {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: !!account.secure,
    auth: { user: account.username, pass: account.password },
    tls: { rejectUnauthorized: !account.allow_untrusted_cert },
    logger: false,
  });
  client.on('close', () => {
    if (clients.get(account.id) === client) clients.delete(account.id);
  });
  client.on('error', () => {
    if (clients.get(account.id) === client) clients.delete(account.id);
  });
  return client;
}

async function getClient(accountId) {
  const existing = clients.get(accountId);
  if (existing?.usable) return existing;
  clients.delete(accountId);
  const account = getAccount(accountId);
  if (!account) throw new Error(`No such account: ${accountId}`);
  const client = buildClient(account);
  await client.connect();
  clients.set(accountId, client);
  return client;
}

// Serialize all IMAP work per account: one selected mailbox per connection,
// so interleaved operations would corrupt each other.
export function run(accountId, fn) {
  const prev = queues.get(accountId) ?? Promise.resolve();
  const next = prev.then(async () => fn(await getClient(accountId)));
  queues.set(accountId, next.catch(() => {}));
  return next;
}

// Cross-account ops: acquire both queues in accountId order to avoid deadlock.
export function runPair(accountIdA, accountIdB, fn) {
  if (accountIdA === accountIdB) return run(accountIdA, (c) => fn(c, c));
  const [lo, hi] = accountIdA < accountIdB ? [accountIdA, accountIdB] : [accountIdB, accountIdA];
  return run(lo, (loClient) =>
    run(hi, async (hiClient) => {
      const [a, b] = accountIdA === lo ? [loClient, hiClient] : [hiClient, loClient];
      return fn(a, b);
    })
  );
}

// Locks the mailbox and guarantees fresh state: getMailboxLock skips the
// SELECT when the mailbox is already selected on this connection, which would
// leave client.mailbox (UIDVALIDITY, exists, uidNext) stale — dangerously so
// if the folder was deleted/recreated out of band. mailboxOpen always issues
// a real SELECT. Also fails fast if the folder no longer exists.
export async function withFreshMailbox(client, path, fn) {
  const lock = await client.getMailboxLock(path);
  try {
    await client.mailboxOpen(path);
    return await fn(client.mailbox);
  } finally {
    lock.release();
  }
}

// One-off connection test that never touches the pool.
export async function testConnection(account) {
  const client = buildClient({ id: -1, ...account });
  try {
    await client.connect();
    const capabilities = [...client.capabilities.keys()];
    await client.logout();
    return { ok: true, capabilities };
  } catch (err) {
    try { client.close(); } catch { /* already closed */ }
    return { ok: false, error: err.responseText || err.message };
  }
}

export async function closeAll() {
  for (const client of clients.values()) {
    try { await client.logout(); } catch { client.close(); }
  }
  clients.clear();
}
