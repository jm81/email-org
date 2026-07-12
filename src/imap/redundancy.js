// Folder scan: find messages whose body is (~fully) quoted inside a newer
// message with the same normalized subject. Bodies are not cached, so each
// candidate costs a live fetch — subject grouping keeps that to messages
// that could actually have a same-thread container. Read-only: results go
// in job.result; deletion stays with the existing reviewed delete flow.
import { simpleParser } from 'mailparser';
import { db } from '../db.js';
import * as pool from './pool.js';
import { getFolder, syncFolderMessages } from './sync.js';
import { normalizeSubject, normalizeBody, findRedundant, htmlFallback, MAX_SCAN_SIZE } from '../redundancy.js';

export async function scanFolderRedundancy(folderId, job) {
  let folder = getFolder(folderId);
  if (!folder) throw new Error(`No such folder: ${folderId}`);
  if (!folder.selectable) throw new Error(`Folder "${folder.path}" cannot hold messages`);
  await syncFolderMessages(folderId);
  folder = getFolder(folderId); // sync may have bumped uidvalidity

  const rows = db.prepare(
    'SELECT id, uid, subject, date, internaldate, size FROM messages WHERE folder_id = ?'
  ).all(folderId);

  const groups = new Map();
  for (const row of rows) {
    const key = normalizeSubject(row.subject);
    let group = groups.get(key);
    if (!group) groups.set(key, group = []);
    group.push(row);
  }

  const skipped = [];
  const candidateGroups = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const usable = group.filter((row) => {
      row.sortKey = row.date ?? row.internaldate;
      if (!row.sortKey) { skipped.push({ id: row.id, reason: 'no-date' }); return false; }
      if (row.size != null && row.size > MAX_SCAN_SIZE) { skipped.push({ id: row.id, reason: 'too-large' }); return false; }
      return true;
    });
    if (usable.length >= 2) candidateGroups.push(usable);
  }

  const candidates = candidateGroups.flat();
  job.total = candidates.length;
  let fetched = 0;

  if (candidates.length) {
    await pool.run(folder.account_id, (client) =>
      pool.withFreshMailbox(client, folder.path, async (mailbox) => {
        if (Number(mailbox.uidValidity) !== folder.uidvalidity) {
          const err = new Error(`Folder "${folder.path}" changed on server; resync needed`);
          err.code = 'UIDVALIDITY_CHANGED';
          throw err;
        }
        for (const row of candidates) {
          try {
            const msg = await client.fetchOne(String(row.uid), { source: true }, { uid: true });
            if (!msg?.source) {
              skipped.push({ id: row.id, reason: 'fetch-failed' });
            } else {
              const parsed = await simpleParser(msg.source, { skipImageLinks: true });
              const text = (parsed.text ?? '').trim() || (parsed.html ? htmlFallback(parsed) : '');
              row.tokens = normalizeBody(text);
              fetched += 1;
            }
          } catch (err) {
            skipped.push({ id: row.id, reason: 'fetch-failed' });
            job.errors.push(`Message uid ${row.uid} in ${folder.path}: ${err.message}`);
          }
          job.done += 1;
        }
      })
    );
  }

  const redundant = [];
  for (const group of candidateGroups) {
    redundant.push(...findRedundant(group.filter((row) => row.tokens)));
  }

  job.result = { folderId, scanned: rows.length, fetched, redundant, skipped };
}
