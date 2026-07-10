import { Router } from 'express';
import { fetchBodyText } from '../imap/body.js';
import { deleteMessages, moveMessages } from '../imap/ops.js';
import { startJob } from '../jobs.js';

export const router = Router();

router.get('/:id/body', async (req, res) => {
  const body = await fetchBodyText(Number(req.params.id));
  if (req.query.mode === 'preview') {
    const lines = body.text.split('\n').filter((l) => l.trim() !== '');
    body.text = lines.slice(0, 6).join('\n');
    body.truncated = lines.length > 6;
  }
  res.json(body);
});

router.post('/delete', (req, res) => {
  const { messageIds } = req.body;
  if (!Array.isArray(messageIds) || !messageIds.length) {
    return res.status(400).json({ error: 'messageIds required' });
  }
  const job = startJob(`Delete ${messageIds.length} messages`, messageIds.length,
    (j) => deleteMessages(messageIds.map(Number), j));
  res.status(202).json({ jobId: job.id });
});

router.post('/move', (req, res) => {
  const { messageIds, targetFolderId } = req.body;
  if (!Array.isArray(messageIds) || !messageIds.length || !targetFolderId) {
    return res.status(400).json({ error: 'messageIds and targetFolderId required' });
  }
  const job = startJob(`Move ${messageIds.length} messages`, messageIds.length,
    (j) => moveMessages(messageIds.map(Number), Number(targetFolderId), j));
  res.status(202).json({ jobId: job.id });
});
