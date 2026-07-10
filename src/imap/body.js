import { simpleParser } from 'mailparser';
import { db } from '../db.js';
import * as pool from './pool.js';
import { getFolder } from './sync.js';

async function fetchSource(messageId) {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!row) throw new Error(`Message ${messageId} not in cache; resync needed`);
  const folder = getFolder(row.folder_id);

  const source = await pool.run(folder.account_id, (client) =>
    pool.withFreshMailbox(client, folder.path, async (mailbox) => {
      if (Number(mailbox.uidValidity) !== row.uidvalidity) {
        throw new Error(`Folder "${folder.path}" changed on server; resync needed`);
      }
      const msg = await client.fetchOne(String(row.uid), { source: true }, { uid: true });
      return msg?.source ?? null;
    })
  );
  if (!source) throw new Error('Message no longer on server');
  return { row, source };
}

export async function fetchBodyText(messageId) {
  const { row, source } = await fetchSource(messageId);
  const parsed = await simpleParser(source, { skipImageLinks: true });
  // Prefer real plain text; fall back to mailparser's HTML-derived text.
  const text = (parsed.text ?? '').trim() || (parsed.html ? htmlFallback(parsed) : '');
  return {
    subject: parsed.subject ?? row.subject,
    from: parsed.from?.text ?? row.from_addr,
    to: parsed.to?.text ?? row.to_addrs,
    date: parsed.date?.toISOString() ?? row.date,
    text: text || '(no text content)',
  };
}

// Full parse for the standalone message view: keeps the HTML part, inline
// images (attachment content buffers), and all headers.
export async function fetchFullMessage(messageId) {
  const { row, source } = await fetchSource(messageId);
  const parsed = await simpleParser(source);
  return { row, parsed };
}

function htmlFallback(parsed) {
  // mailparser sets textAsHtml when only text exists; when only HTML exists,
  // parsed.text is usually still derived. Last resort: strip tags crudely.
  return String(parsed.html).replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
