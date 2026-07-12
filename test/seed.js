// Seeds the throwaway Dovecot (test/start-dovecot.sh) with a nested folder
// tree and fixture messages for the integration tests.
import { ImapFlow } from 'imapflow';

export const IMAP = { host: '127.0.0.1', port: 1143, secure: false };
export const ALICE = { user: 'alice', pass: 'alicepw' };
export const BOB = { user: 'bob', pass: 'bobpw' };

function rfc822({ from, to = 'alice@test', subject, date, body, contentType = 'text/plain' }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date(date).toUTCString()}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@test>`,
    `Content-Type: ${contentType}; charset=utf-8`,
    '',
    body,
    '',
  ].join('\r\n');
}

function multipart({ from, subject, date, text, html }) {
  const b = 'BOUNDARY42';
  return [
    `From: ${from}`,
    'To: alice@test',
    `Subject: ${subject}`,
    `Date: ${new Date(date).toUTCString()}`,
    `Content-Type: multipart/alternative; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    `--${b}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    `--${b}--`,
    '',
  ].join('\r\n');
}

function withAttachments({ from, subject, date, text, filenames }) {
  const b = 'BOUNDARY43';
  const parts = filenames.map((name) => [
    `--${b}`,
    'Content-Type: application/octet-stream',
    `Content-Disposition: attachment; filename="${name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(`contents of ${name}`).toString('base64'),
  ].join('\r\n'));
  return [
    `From: ${from}`,
    'To: alice@test',
    `Subject: ${subject}`,
    `Date: ${new Date(date).toUTCString()}`,
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    ...parts,
    `--${b}--`,
    '',
  ].join('\r\n');
}

async function withClient(auth, fn) {
  const client = new ImapFlow({ ...IMAP, auth, logger: false });
  await client.connect();
  try { return await fn(client); }
  finally { await client.logout(); }
}

export async function seed() {
  await withClient(ALICE, async (c) => {
    // INBOX: 5 messages with controlled dates/flags for move/delete tests.
    const inboxMsgs = [
      { subject: 'inbox-1 old news', date: '2022-05-01T10:00:00Z', flags: ['\\Seen'] },
      { subject: 'inbox-2 receipts', date: '2023-01-15T10:00:00Z', flags: [] },
      { subject: 'inbox-3 hello', date: '2024-06-01T10:00:00Z', flags: ['\\Seen'] },
      { subject: 'inbox-4 newsletter', date: '2025-02-10T10:00:00Z', flags: [] },
      { subject: 'inbox-5 recent', date: '2026-06-20T10:00:00Z', flags: [] },
    ];
    for (const m of inboxMsgs) {
      await c.append('INBOX',
        rfc822({ from: 'sender@test', subject: m.subject, date: m.date, body: `Body of ${m.subject}.\nSecond line.` }),
        m.flags, new Date(m.date));
    }

    // Trash for the quick-move context-menu shortcuts (Maildir++: child of
    // INBOX). Its message is recent so the quiet filter hides the whole
    // INBOX subtree once the e2e run has opened (and thus header-synced) it.
    await c.mailboxCreate('INBOX.Trash');
    await c.append('INBOX.Trash',
      rfc822({ from: 'trash@test', subject: 'trashed recent', date: '2026-06-25T10:00:00Z', body: 'recently trashed' }),
      [], new Date('2026-06-25T10:00:00Z'));

    // Nested archive tree for flatten tests (Maildir++ delimiter ".").
    const tree = {
      'Archive': 1,
      'Archive.2023': 2,
      'Archive.2023.Q1': 3,
      'Archive.2023.Q2': 1,
      'Archive.Empty': 0,
    };
    for (const [path, count] of Object.entries(tree)) {
      await c.mailboxCreate(path);
      for (let i = 1; i <= count; i++) {
        await c.append(path,
          rfc822({ from: 'archive@test', subject: `${path} msg ${i}`, date: '2023-03-0' + ((i % 8) + 1) + 'T09:00:00Z', body: `archived mail ${i} in ${path}` }),
          [], new Date('2023-03-01T09:00:00Z'));
      }
    }

    // Quiet folder (old mail only) for the N-months filter data.
    await c.mailboxCreate('OldStuff');
    await c.append('OldStuff',
      rfc822({ from: 'old@test', subject: 'ancient', date: '2020-01-01T00:00:00Z', body: 'very old' }),
      [], new Date('2020-01-01T00:00:00Z'));

    // Body-parsing fixtures.
    await c.mailboxCreate('Bodies');
    await c.append('Bodies', multipart({
      from: 'multi@test', subject: 'multipart mail', date: '2024-01-01T00:00:00Z',
      text: 'Plain part line one.\nPlain part line two.\nLine three.\nLine four.\nLine five.\nLine six.\nLine seven.',
      html: '<p>HTML part</p>',
    }), [], new Date('2024-01-01T00:00:00Z'));
    await c.append('Bodies', withAttachments({
      from: 'attach@test', subject: 'mail with attachments', date: '2024-01-03T00:00:00Z',
      text: 'See attached.', filenames: ['report.pdf', 'data.csv'],
    }), [], new Date('2024-01-03T00:00:00Z'));
    await c.append('Bodies', rfc822({
      from: 'htmlonly@test', subject: 'html only mail', date: '2024-01-02T00:00:00Z',
      body: '<html><body><p>Only <b>HTML</b> content here</p></body></html>',
      contentType: 'text/html',
    }), [], new Date('2024-01-02T00:00:00Z'));

    // Reply chains for the redundancy scan: quoted-with-mutations threads,
    // a same-body different-subject decoy, a too-short thread, an HTML reply.
    await c.mailboxCreate('Chains');
    const chainBody = 'Hi team, here is the first draft of the project budget summary.\nPlease send comments by Friday afternoon so we can lock the numbers.';
    const chains = [
      { subject: 'Project X', date: '2025-05-12T10:00:00Z', body: chainBody },
      { subject: 'Re: Project X', date: '2025-05-13T10:00:00Z', body: [
        'Looks good overall, one question about the travel line item below.',
        '',
        'On Mon, 12 May 2025, alice@test wrote:',
        '> Hi team, here is the first draft of the',        // re-wrapped quote
        '> project budget summary. Please send comments',
        '> by Friday afternoon so we can lock the numbers.',
      ].join('\n') },
      { subject: 'Re: Re: Project X', date: '2025-05-14T10:00:00Z', body: [
        'Approved, thanks everyone. Closing this thread now.',
        '',
        'On Tue, 13 May 2025, bob@test wrote:',
        '> Looks good overall, one question about the travel line item below.',
        '>',
        '> On Mon, 12 May 2025, alice@test wrote:',
        '>> Hi team, here is the first draft of the',
        '>> project budget summary. Please send comments',
        '>> by Friday afternoon so we can lock the numbers.',
      ].join('\n') },
      // Same text under another subject: must NOT be flagged (subject grouping).
      { subject: 'Unrelated notes', date: '2025-05-15T10:00:00Z', body: chainBody },
      // Too short to trust: never flagged even though fully quoted.
      { subject: 'Quick question', date: '2025-05-16T10:00:00Z', body: 'Thanks!' },
      { subject: 'Re: Quick question', date: '2025-05-17T10:00:00Z', body: 'You are welcome!\n> Thanks!' },
      { subject: 'Numbers', date: '2025-05-18T10:00:00Z', body: 'The totals for April are forty two thousand and the forecast for May is fifty one thousand overall.' },
      { subject: 'Re: Numbers', date: '2025-05-19T10:00:00Z', contentType: 'text/html', body:
        '<html><body><p>Great, thanks for pulling these together.</p><blockquote>The totals for April are forty two thousand and the forecast for May is fifty one thousand overall.</blockquote></body></html>' },
    ];
    for (const m of chains) {
      await c.append('Chains',
        rfc822({ from: 'chain@test', subject: m.subject, date: m.date, body: m.body, contentType: m.contentType }),
        [], new Date(m.date));
    }

    // A message whose Date: header doesn't parse — header sync must fall
    // back to INTERNALDATE instead of throwing "Invalid time value".
    await c.mailboxCreate('BadDate');
    await c.append('BadDate', [
      'From: baddate@test',
      'To: alice@test',
      'Subject: bad date header',
      'Date: not a real date',
      'Message-ID: <baddate@test>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'body of the bad-date message',
      '',
    ].join('\r\n'), [], new Date('2024-04-01T00:00:00Z'));

    // Sacrificial folder for the UIDVALIDITY safety test.
    await c.mailboxCreate('Doomed');
    for (let i = 1; i <= 2; i++) {
      await c.append('Doomed',
        rfc822({ from: 'doom@test', subject: `doomed ${i}`, date: '2024-05-01T00:00:00Z', body: 'doomed' }),
        [], new Date('2024-05-01T00:00:00Z'));
    }
  });

  await withClient(BOB, async (c) => {
    await c.append('INBOX',
      rfc822({ from: 'bobmail@test', to: 'bob@test', subject: 'bob-1', date: '2025-01-01T00:00:00Z', body: 'bob mail' }),
      [], new Date('2025-01-01T00:00:00Z'));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed().then(() => console.log('seeded')).catch((e) => { console.error(e); process.exit(1); });
}
