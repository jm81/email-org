import { db } from '../db.js';
import * as pool from './pool.js';
import { getFolder, syncFolderList, syncFolderMessages, upsertListedFolder } from './sync.js';

// Opens the mailbox and verifies its UIDVALIDITY still matches what our cache
// was built against. Every destructive op goes through this — a mismatch means
// our cached UIDs may point at different messages now.
async function withVerifiedMailbox(client, folder, expectedUidValidity, fn) {
  return pool.withFreshMailbox(client, folder.path, async (mailbox) => {
    const current = Number(mailbox.uidValidity);
    if (current !== expectedUidValidity) {
      const err = new Error(`Folder "${folder.path}" changed on server (UIDVALIDITY ${expectedUidValidity} -> ${current}); resync needed`);
      err.code = 'UIDVALIDITY_CHANGED';
      throw err;
    }
    return fn(mailbox);
  });
}

// Resolve message row ids -> rows grouped by folder, verifying every message's
// uidvalidity snapshot matches its folder's current cached uidvalidity.
function resolveMessages(messageIds) {
  const get = db.prepare(`
    SELECT m.id, m.uid, m.uidvalidity AS msg_uidvalidity, f.id AS folder_id, f.uidvalidity AS folder_uidvalidity,
           f.account_id, f.path
    FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?
  `);
  const byFolder = new Map();
  for (const id of messageIds) {
    const row = get.get(id);
    if (!row) throw new Error(`Message ${id} not in cache; resync needed`);
    if (row.msg_uidvalidity !== row.folder_uidvalidity) {
      throw new Error(`Cached message ${id} is stale (folder "${row.path}" was resynced); refresh and retry`);
    }
    let group = byFolder.get(row.folder_id);
    if (!group) byFolder.set(row.folder_id, group = { folder: getFolder(row.folder_id), uids: [] });
    group.uids.push(row.uid);
  }
  return [...byFolder.values()];
}

export async function createFolder(accountId, parentPath, name) {
  if (!name?.trim()) throw new Error('Folder name required');
  let path = name.trim();
  if (parentPath) {
    const parent = db.prepare('SELECT * FROM folders WHERE account_id = ? AND path = ?').get(accountId, parentPath);
    if (!parent) throw new Error(`Unknown parent folder: ${parentPath}`);
    if (parent.no_inferiors) throw new Error(`Folder "${parentPath}" cannot contain subfolders`);
    const delim = parent.delimiter || '/';
    if (name.includes(delim)) throw new Error(`Folder name may not contain "${delim}"`);
    path = parent.path + delim + name.trim();
  } else {
    // Some servers root personal folders under a namespace prefix (e.g.
    // "INBOX."). client.namespace (primary personal) is populated at connect.
    path = await pool.run(accountId, async (client) => {
      const prefix = client.namespace?.prefix ?? '';
      const delim = client.namespace?.delimiter ?? '/';
      if (name.includes(delim)) throw new Error(`Folder name may not contain "${delim}"`);
      return prefix + name.trim();
    });
  }
  // Cache just the new mailbox from a plain LIST (see renameFolder for why
  // not syncFolderList). LIST also supplies the authoritative delimiter,
  // flags, and any namespace-prefixed final path.
  const box = await pool.run(accountId, async (client) => {
    await client.mailboxCreate(path);
    const listing = await client.list();
    return listing.find((b) => b.path === path);
  });
  if (!box) throw new Error(`Create verification failed: "${path}" not on server after CREATE`);
  upsertListedFolder(accountId, box);
  // A freshly created mailbox is empty; don't leave the counts unknown.
  db.prepare('UPDATE folders SET msg_count = 0, unseen_count = 0 WHERE account_id = ? AND path = ?')
    .run(accountId, path);
  return db.prepare('SELECT * FROM folders WHERE account_id = ? AND path = ?').get(accountId, path);
}

// Renames the folder in place (same parent). IMAP RENAME carries the whole
// subtree with it, so cached paths are rewritten rather than resynced from
// scratch — folder ids stay stable, which keeps cached messages and done
// marks attached. UIDVALIDITY is usually preserved by servers across a
// rename; if one doesn't, the next sync's UIDVALIDITY check catches it.
export async function renameFolder(folderId, newName) {
  const folder = getFolder(folderId);
  if (!folder) throw new Error(`No such folder: ${folderId}`);
  if (folder.special_use) throw new Error(`Refusing to rename special folder ${folder.path} (${folder.special_use})`);
  if (folder.path.toUpperCase() === 'INBOX') throw new Error('Refusing to rename INBOX');
  const name = newName?.trim();
  if (!name) throw new Error('Folder name required');
  const delim = folder.delimiter || '/';
  if (name.includes(delim)) throw new Error(`Folder name may not contain "${delim}"`);
  if (name === folder.name) return folder;
  const newPath = folder.parent_path ? folder.parent_path + delim + name : name;
  if (db.prepare('SELECT 1 FROM folders WHERE account_id = ? AND path = ?').get(folder.account_id, newPath)) {
    throw new Error(`Folder "${newPath}" already exists`);
  }

  await pool.run(folder.account_id, async (client) => {
    await client.mailboxRename(folder.path, newPath);
    // Verify with a plain LIST — one round trip. (Not syncFolderList: its
    // per-folder STATUS fallback on servers without LIST-STATUS can take
    // minutes on large accounts, and the caller is a UI action awaiting us.)
    const listing = await client.list();
    if (!listing.some((box) => box.path === newPath)) {
      throw new Error(`Rename verification failed: "${newPath}" not on server after RENAME`);
    }
  });

  db.transaction(() => {
    const prefix = folder.path + delim;
    const rows = db.prepare('SELECT id, path, parent_path, name FROM folders WHERE account_id = ?').all(folder.account_id);
    const upd = db.prepare('UPDATE folders SET path = ?, parent_path = ?, name = ? WHERE id = ?');
    for (const r of rows) {
      if (r.id === folder.id) {
        upd.run(newPath, folder.parent_path, name, r.id);
      } else if (r.path.startsWith(prefix)) {
        upd.run(newPath + r.path.slice(folder.path.length),
          newPath + r.parent_path.slice(folder.path.length), r.name, r.id);
      }
    }
  })();

  return getFolder(folder.id);
}

export async function deleteFolder(folderId, { force = false } = {}) {
  const folder = getFolder(folderId);
  if (!folder) throw new Error(`No such folder: ${folderId}`);
  if (folder.special_use) throw new Error(`Refusing to delete special folder ${folder.path} (${folder.special_use})`);
  const children = db.prepare('SELECT COUNT(*) AS n FROM folders WHERE account_id = ? AND parent_path = ?')
    .get(folder.account_id, folder.path);
  if (children.n > 0) throw new Error(`Folder "${folder.path}" has subfolders; flatten or delete them first`);
  if (!force && folder.msg_count > 0) {
    throw new Error(`Folder "${folder.path}" contains ${folder.msg_count} messages`);
  }
  await pool.run(folder.account_id, (client) => client.mailboxDelete(folder.path));
  db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
}

export async function deleteMessages(messageIds, job) {
  const groups = resolveMessages(messageIds);
  job.total = messageIds.length;
  for (const { folder, uids } of groups) {
    await pool.run(folder.account_id, (client) =>
      withVerifiedMailbox(client, folder, folder.uidvalidity, async () => {
        // ImapFlow uses UID EXPUNGE (UIDPLUS) when available, so only these UIDs go.
        await client.messageDelete(uids.join(','), { uid: true });
      })
    );
    db.prepare(`DELETE FROM messages WHERE folder_id = ? AND uid IN (${uids.map(() => '?').join(',')})`)
      .run(folder.id, ...uids);
    job.done += uids.length;
    await syncFolderMessages(folder.id);
  }
}

export async function moveMessages(messageIds, targetFolderId, job) {
  const target = getFolder(targetFolderId);
  if (!target) throw new Error(`No such target folder: ${targetFolderId}`);
  if (!target.selectable) throw new Error(`Target folder "${target.path}" cannot hold messages`);
  const groups = resolveMessages(messageIds);
  job.total = messageIds.length;

  for (const { folder, uids } of groups) {
    if (folder.id === target.id) { job.done += uids.length; continue; }
    if (folder.account_id === target.account_id) {
      await pool.run(folder.account_id, (client) =>
        withVerifiedMailbox(client, folder, folder.uidvalidity, async () => {
          // MOVE when the server advertises it, otherwise COPY + delete fallback.
          await client.messageMove(uids.join(','), target.path, { uid: true });
        })
      );
      db.prepare(`DELETE FROM messages WHERE folder_id = ? AND uid IN (${uids.map(() => '?').join(',')})`)
        .run(folder.id, ...uids);
      job.done += uids.length;
    } else {
      await moveAcrossAccounts(folder, uids, target, job);
    }
    await syncFolderMessages(folder.id);
  }
  await syncFolderMessages(target.id);
}

// Per message: fetch raw -> APPEND to target -> only then delete from source.
// A mid-batch failure leaves the rest untouched; worst case is a duplicate, never a loss.
async function moveAcrossAccounts(folder, uids, target, job) {
  await pool.runPair(folder.account_id, target.account_id, async (srcClient, dstClient) => {
    for (const uid of uids) {
      const msg = await pool.withFreshMailbox(srcClient, folder.path, async (mailbox) => {
        if (Number(mailbox.uidValidity) !== folder.uidvalidity) {
          throw new Error(`Folder "${folder.path}" changed on server; resync needed`);
        }
        return srcClient.fetchOne(String(uid), { source: true, flags: true, internalDate: true }, { uid: true });
      });
      if (!msg?.source) {
        job.errors.push(`Message uid ${uid} in ${folder.path}: not found on server`);
        continue;
      }
      const flags = [...(msg.flags ?? [])].filter((f) => f !== '\\Recent');
      await dstClient.append(target.path, msg.source, flags, msg.internalDate);
      await pool.withFreshMailbox(srcClient, folder.path, () =>
        srcClient.messageDelete(String(uid), { uid: true }));
      db.prepare('DELETE FROM messages WHERE folder_id = ? AND uid = ?').run(folder.id, uid);
      job.done += 1;
    }
  });
}

// Move everything in the subtree up into `folder`, then delete the subfolders.
// Deepest-first so every delete is on a leaf; nothing is deleted before it is
// verified empty, so a partial failure is safe and flatten can be re-run.
export async function flattenFolder(folderId, job) {
  const folder = getFolder(folderId);
  if (!folder) throw new Error(`No such folder: ${folderId}`);
  if (!folder.selectable) throw new Error(`Folder "${folder.path}" cannot hold messages`);

  await syncFolderList(folder.account_id);
  const all = db.prepare('SELECT * FROM folders WHERE account_id = ?').all(folder.account_id);
  const delim = folder.delimiter || '/';
  const subtree = all.filter((f) => f.path.startsWith(folder.path + delim));
  if (!subtree.length) return;
  const special = subtree.find((f) => f.special_use);
  if (special) throw new Error(`Subtree contains special folder ${special.path} (${special.special_use}); refusing to flatten`);

  subtree.sort((a, b) => b.path.split(delim).length - a.path.split(delim).length);
  job.total = subtree.length;

  await pool.run(folder.account_id, async (client) => {
    for (const sub of subtree) {
      if (sub.selectable) {
        await pool.withFreshMailbox(client, sub.path, async (mailbox) => {
          if (mailbox.exists > 0) {
            await client.messageMove('1:*', folder.path);
          }
        });
        const status = await client.status(sub.path, { messages: true });
        if (status.messages > 0) {
          throw new Error(`"${sub.path}" still has ${status.messages} messages after move; stopping`);
        }
      }
      await client.mailboxDelete(sub.path);
      job.done += 1;
    }
  });

  await syncFolderList(folder.account_id);
  await syncFolderMessages(folderId);
}
