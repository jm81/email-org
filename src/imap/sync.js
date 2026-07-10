import { db } from '../db.js';
import * as pool from './pool.js';

const upsertFolder = db.prepare(`
  INSERT INTO folders (account_id, path, name, parent_path, delimiter, selectable, no_inferiors, special_use,
                       uidvalidity, uidnext, msg_count, unseen_count)
  VALUES (@account_id, @path, @name, @parent_path, @delimiter, @selectable, @no_inferiors, @special_use,
          @uidvalidity, @uidnext, @msg_count, @unseen_count)
  ON CONFLICT (account_id, path) DO UPDATE SET
    name=excluded.name, parent_path=excluded.parent_path, delimiter=excluded.delimiter,
    selectable=excluded.selectable, no_inferiors=excluded.no_inferiors, special_use=excluded.special_use,
    uidnext=COALESCE(excluded.uidnext, uidnext),
    msg_count=COALESCE(excluded.msg_count, msg_count),
    unseen_count=COALESCE(excluded.unseen_count, unseen_count),
    uidvalidity=COALESCE(excluded.uidvalidity, uidvalidity)
`);

export async function syncFolderList(accountId) {
  const listing = await pool.run(accountId, (client) =>
    client.list({ statusQuery: { messages: true, unseen: true, uidNext: true, uidValidity: true } })
  );

  db.transaction(() => {
    const seen = new Set();
    for (const box of listing) {
      seen.add(box.path);
      const delimiter = box.delimiter || '/';
      const idx = box.path.lastIndexOf(delimiter);
      upsertFolder.run({
        account_id: accountId,
        path: box.path,
        name: box.name ?? (idx >= 0 ? box.path.slice(idx + delimiter.length) : box.path),
        parent_path: idx > 0 ? box.path.slice(0, idx) : null,
        delimiter: box.delimiter ?? null,
        selectable: box.flags?.has('\\Noselect') ? 0 : 1,
        no_inferiors: box.flags?.has('\\Noinferiors') ? 1 : 0,
        special_use: box.specialUse ?? null,
        uidvalidity: box.status?.uidValidity != null ? Number(box.status.uidValidity) : null,
        uidnext: box.status?.uidNext ?? null,
        msg_count: box.status?.messages ?? null,
        unseen_count: box.status?.unseen ?? null,
      });
    }
    // Remove folders no longer on the server (cascades cached messages).
    const cached = db.prepare('SELECT id, path FROM folders WHERE account_id = ?').all(accountId);
    const del = db.prepare('DELETE FROM folders WHERE id = ?');
    for (const f of cached) if (!seen.has(f.path)) del.run(f.id);
  })();

  return getFolders(accountId);
}

export function getFolders(accountId) {
  return db.prepare('SELECT * FROM folders WHERE account_id = ? ORDER BY path').all(accountId);
}

export function getFolder(folderId) {
  return db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId);
}

const insertMessage = db.prepare(`
  INSERT INTO messages (folder_id, uid, uidvalidity, subject, from_addr, to_addrs, date, internaldate, size, flags, attachment_count)
  VALUES (@folder_id, @uid, @uidvalidity, @subject, @from_addr, @to_addrs, @date, @internaldate, @size, @flags, @attachment_count)
  ON CONFLICT (folder_id, uid) DO UPDATE SET flags=excluded.flags
`);

// A part counts as an attachment if the sender marked it one, or if it's a
// named non-inline leaf (many senders omit Content-Disposition entirely).
// Counted nodes aren't descended into, so an attached .eml counts as one.
function countAttachments(node) {
  if (!node) return 0;
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
  if (node.disposition === 'attachment' ||
      (filename != null && node.disposition !== 'inline' && !node.type?.startsWith('multipart/'))) {
    return 1;
  }
  return (node.childNodes ?? []).reduce((n, child) => n + countAttachments(child), 0);
}

function fmtAddr(list) {
  if (!list?.length) return null;
  return list.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(', ');
}

function rowFromFetch(folderId, uidvalidity, msg) {
  const env = msg.envelope ?? {};
  return {
    folder_id: folderId,
    uid: msg.uid,
    uidvalidity,
    subject: env.subject ?? null,
    from_addr: fmtAddr(env.from),
    to_addrs: fmtAddr(env.to),
    date: env.date ? new Date(env.date).toISOString() : (msg.internalDate ? new Date(msg.internalDate).toISOString() : null),
    internaldate: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
    size: msg.size ?? null,
    flags: JSON.stringify([...(msg.flags ?? [])]),
    attachment_count: msg.bodyStructure ? countAttachments(msg.bodyStructure) : null,
  };
}

export async function syncFolderMessages(folderId) {
  const folder = getFolder(folderId);
  if (!folder) throw new Error(`No such folder: ${folderId}`);
  if (!folder.selectable) throw new Error(`Folder is not selectable: ${folder.path}`);

  const result = await pool.run(folder.account_id, (client) =>
    pool.withFreshMailbox(client, folder.path, async (mailbox) => {
      const uidValidity = Number(mailbox.uidValidity);
      const fullResync = folder.uidvalidity == null || uidValidity !== folder.uidvalidity;

      // Bare UID list: detects server-side deletions, and on full resync is the fetch set.
      const liveUids = [];
      if (mailbox.exists > 0) {
        for await (const msg of client.fetch('1:*', { uid: true })) liveUids.push(msg.uid);
      }

      const cachedUids = fullResync
        ? new Set()
        : new Set(db.prepare('SELECT uid FROM messages WHERE folder_id = ?').all(folderId).map((r) => r.uid));
      const missingUids = liveUids.filter((u) => !cachedUids.has(u));

      const rows = [];
      if (missingUids.length) {
        for await (const msg of client.fetch(missingUids.join(','), {
          uid: true, envelope: true, internalDate: true, flags: true, size: true, bodyStructure: true,
        }, { uid: true })) {
          rows.push(rowFromFetch(folderId, uidValidity, msg));
        }
      }

      // Backfill: rows cached before attachment_count existed are never
      // refetched by the incremental path above, so grab just their
      // bodystructure here. One-time cost per folder; no-op once populated.
      const live = new Set(liveUids);
      const backfillUids = fullResync ? [] : db.prepare(
        'SELECT uid FROM messages WHERE folder_id = ? AND attachment_count IS NULL'
      ).all(folderId).map((r) => r.uid).filter((u) => live.has(u) && cachedUids.has(u));
      const backfill = [];
      if (backfillUids.length) {
        for await (const msg of client.fetch(backfillUids.join(','), { uid: true, bodyStructure: true }, { uid: true })) {
          if (msg.bodyStructure) backfill.push({ uid: msg.uid, count: countAttachments(msg.bodyStructure) });
        }
      }
      return { uidValidity, uidNext: mailbox.uidNext, fullResync, liveUids, rows, backfill };
    })
  );

  db.transaction(() => {
    if (result.fullResync) {
      db.prepare('DELETE FROM messages WHERE folder_id = ?').run(folderId);
    } else {
      const live = new Set(result.liveUids);
      const cached = db.prepare('SELECT id, uid FROM messages WHERE folder_id = ?').all(folderId);
      const del = db.prepare('DELETE FROM messages WHERE id = ?');
      for (const m of cached) if (!live.has(m.uid)) del.run(m.id);
    }
    for (const row of result.rows) insertMessage.run(row);

    const setCount = db.prepare('UPDATE messages SET attachment_count = ? WHERE folder_id = ? AND uid = ?');
    for (const b of result.backfill) setCount.run(b.count, folderId, b.uid);

    const stats = db.prepare(
      'SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM messages WHERE folder_id = ?'
    ).get(folderId);
    db.prepare(`
      UPDATE folders SET uidvalidity=?, uidnext=?, msg_count=?, first_msg_date=?, last_msg_date=?,
        last_synced_at=datetime('now') WHERE id=?
    `).run(result.uidValidity, result.uidNext, stats.n, stats.first, stats.last, folderId);
  })();

  return getFolder(folderId);
}
