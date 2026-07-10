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
  INSERT INTO messages (folder_id, uid, uidvalidity, subject, from_addr, to_addrs, date, internaldate, size, flags)
  VALUES (@folder_id, @uid, @uidvalidity, @subject, @from_addr, @to_addrs, @date, @internaldate, @size, @flags)
  ON CONFLICT (folder_id, uid) DO UPDATE SET flags=excluded.flags
`);

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
          uid: true, envelope: true, internalDate: true, flags: true, size: true,
        }, { uid: true })) {
          rows.push(rowFromFetch(folderId, uidValidity, msg));
        }
      }
      return { uidValidity, uidNext: mailbox.uidNext, fullResync, liveUids, rows };
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
