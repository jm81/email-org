import { Router } from 'express';
import * as accounts from '../accounts.js';
import * as pool from '../imap/pool.js';
import { syncFolderList, getFolders } from '../imap/sync.js';

export const router = Router();

router.get('/', (req, res) => res.json(accounts.listAccounts()));

router.post('/', (req, res) => {
  const { name, host, username, password } = req.body;
  if (!name || !host || !username || !password) {
    return res.status(400).json({ error: 'name, host, username and password are required' });
  }
  res.status(201).json(accounts.createAccount(req.body));
});

router.put('/:id', (req, res) => {
  const updated = accounts.updateAccount(Number(req.params.id), req.body);
  if (!updated) return res.status(404).json({ error: 'No such account' });
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  if (!accounts.deleteAccount(Number(req.params.id))) return res.status(404).json({ error: 'No such account' });
  res.status(204).end();
});

// Test credentials without saving. Accepts either a full account body or
// {id, password?} to test a stored account (password optional on retest).
router.post('/test', async (req, res) => {
  let candidate = req.body;
  if (req.body.id) {
    const stored = accounts.getAccount(Number(req.body.id));
    if (!stored) return res.status(404).json({ error: 'No such account' });
    candidate = { ...stored, ...req.body, password: req.body.password || stored.password };
  }
  res.json(await pool.testConnection({
    host: candidate.host,
    port: candidate.port ?? 993,
    secure: candidate.secure !== false && candidate.secure !== 0,
    allow_untrusted_cert: candidate.allowUntrustedCert ?? candidate.allow_untrusted_cert ? 1 : 0,
    username: candidate.username,
    password: candidate.password,
  }));
});

router.post('/:id/sync', async (req, res) => {
  res.json(await syncFolderList(Number(req.params.id)));
});

router.get('/:id/folders', (req, res) => {
  res.json(getFolders(Number(req.params.id)));
});
