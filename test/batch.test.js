// Pure test — stub client, no Dovecot, no DB, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchByUids, FETCH_BATCH } from '../src/imap/batch.js';

test('fetchByUids batches: every uid fetched once, commands stay short', async () => {
  // Sparse, 6-digit UIDs like a real 40k-message mailbox: ~7 chars each, so a
  // single joined FETCH would be ~140 KB, over Dovecot's 64 KB line limit.
  const uids = Array.from({ length: 20000 }, (_, i) => 100000 + i * 3);
  const commands = [];
  const client = {
    async *fetch(range, query, opts) {
      commands.push(range);
      assert.deepEqual(opts, { uid: true });
      for (const u of range.split(',')) yield { uid: Number(u) };
    },
  };

  const got = [];
  for await (const msg of fetchByUids(client, uids, { uid: true })) got.push(msg.uid);

  assert.deepEqual(got, uids, 'all uids, in order, none repeated');
  assert.equal(commands.length, Math.ceil(uids.length / FETCH_BATCH));
  assert.ok(Math.max(...commands.map((c) => c.length)) < 8000, 'each command well under server limits');
});

test('fetchByUids with no uids sends nothing', async () => {
  const client = { fetch() { throw new Error('should not be called'); } };
  for await (const _ of fetchByUids(client, [], {})) assert.fail('yielded');
});
