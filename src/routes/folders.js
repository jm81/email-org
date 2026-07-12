import { Router } from 'express';
import { db } from '../db.js';
import { getFolder, syncFolderMessages } from '../imap/sync.js';
import { createFolder, deleteFolder, flattenFolder, renameFolder } from '../imap/ops.js';
import { scanFolderRedundancy } from '../imap/redundancy.js';
import { addrSortKey, normalizeSubject } from '../redundancy.js';
import { startJob } from '../jobs.js';

export const router = Router();

router.post('/', async (req, res) => {
  const { accountId, parentPath, name } = req.body;
  if (!accountId || !name) return res.status(400).json({ error: 'accountId and name are required' });
  res.status(201).json(await createFolder(Number(accountId), parentPath ?? null, name));
});

router.delete('/:id', async (req, res) => {
  await deleteFolder(Number(req.params.id), { force: req.query.force === '1' });
  res.status(204).end();
});

router.post('/:id/rename', async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'name is required' });
  res.json(await renameFolder(Number(req.params.id), req.body.name));
});

router.post('/:id/sync', async (req, res) => {
  res.json(await syncFolderMessages(Number(req.params.id)));
});

router.post('/:id/flatten', (req, res) => {
  const folder = getFolder(Number(req.params.id));
  if (!folder) return res.status(404).json({ error: 'No such folder' });
  const job = startJob(`Flatten ${folder.path}`, 0, (j) => flattenFolder(folder.id, j));
  res.status(202).json({ jobId: job.id });
});

router.post('/:id/scan-redundant', (req, res) => {
  const folder = getFolder(Number(req.params.id));
  if (!folder) return res.status(404).json({ error: 'No such folder' });
  const job = startJob(`Scan ${folder.path} for redundant messages`, 0, (j) => scanFolderRedundancy(folder.id, j));
  res.status(202).json({ jobId: job.id });
});

router.post('/:id/done', (req, res) => {
  const folder = getFolder(Number(req.params.id));
  if (!folder) return res.status(404).json({ error: 'No such folder' });
  const done_at = req.body.done ? new Date().toISOString() : null;
  db.prepare('UPDATE folders SET done_at = ? WHERE id = ?').run(done_at, folder.id);
  res.json({ ...folder, done_at });
});

// Normalized sort keys for ?sort=; computed in JS because SQL can't express
// them. Null keys always sort last. Date (the default) stays in SQL.
const SORT_KEYS = {
  subject: (r) => normalizeSubject(r.subject) || null,
  from: (r) => addrSortKey(r.from_addr),
  to: (r) => addrSortKey(r.to_addrs),
};

router.get('/:id/messages', (req, res) => {
  const folder = getFolder(Number(req.params.id));
  if (!folder) return res.status(404).json({ error: 'No such folder' });
  const limit = Math.floor(Number(req.query.limit)) > 0 ? Math.floor(Number(req.query.limit)) : 500;
  const offset = Math.max(Math.floor(Number(req.query.offset)) || 0, 0);
  const total = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE folder_id = ?').get(folder.id).n;
  const keyFn = SORT_KEYS[req.query.sort];
  if (!keyFn) {
    const ord = req.query.sort === 'date' && req.query.dir === 'asc' ? 'ASC' : 'DESC';
    const rows = db.prepare(
      `SELECT * FROM messages WHERE folder_id = ? ORDER BY date ${ord}, uid ${ord} LIMIT ? OFFSET ?`
    ).all(folder.id, limit, offset);
    return res.json({ folder, messages: rows, total });
  }
  const dir = req.query.dir === 'desc' ? -1 : 1;
  // Fetch newest-first so the stable sort keeps ties date-desc in both
  // directions, then sort the whole folder before applying limit/offset —
  // groupings must see rows beyond the first page.
  const rows = db.prepare('SELECT * FROM messages WHERE folder_id = ? ORDER BY date DESC, uid DESC').all(folder.id);
  const keyed = rows.map((row) => ({ key: keyFn(row), row }));
  keyed.sort((a, b) => {
    if (a.key === b.key) return 0;
    if (a.key === null) return 1;
    if (b.key === null) return -1;
    return a.key < b.key ? -dir : dir;
  });
  res.json({ folder, messages: keyed.slice(offset, offset + limit).map((k) => k.row), total });
});
