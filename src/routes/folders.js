import { Router } from 'express';
import { db } from '../db.js';
import { getFolder, syncFolderMessages } from '../imap/sync.js';
import { createFolder, deleteFolder, flattenFolder } from '../imap/ops.js';
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

router.post('/:id/sync', async (req, res) => {
  res.json(await syncFolderMessages(Number(req.params.id)));
});

router.post('/:id/flatten', (req, res) => {
  const folder = getFolder(Number(req.params.id));
  if (!folder) return res.status(404).json({ error: 'No such folder' });
  const job = startJob(`Flatten ${folder.path}`, 0, (j) => flattenFolder(folder.id, j));
  res.status(202).json({ jobId: job.id });
});

router.post('/:id/done', (req, res) => {
  const folder = getFolder(Number(req.params.id));
  if (!folder) return res.status(404).json({ error: 'No such folder' });
  const done_at = req.body.done ? new Date().toISOString() : null;
  db.prepare('UPDATE folders SET done_at = ? WHERE id = ?').run(done_at, folder.id);
  res.json({ ...folder, done_at });
});

router.get('/:id/messages', (req, res) => {
  const folder = getFolder(Number(req.params.id));
  if (!folder) return res.status(404).json({ error: 'No such folder' });
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  const offset = Number(req.query.offset) || 0;
  const rows = db.prepare(
    'SELECT * FROM messages WHERE folder_id = ? ORDER BY date DESC, uid DESC LIMIT ? OFFSET ?'
  ).all(folder.id, limit, offset);
  res.json({ folder, messages: rows });
});
