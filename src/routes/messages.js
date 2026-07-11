import { Router } from 'express';
import { fetchBodyText, fetchFullMessage, fetchRawSource } from '../imap/body.js';
import { renderMessageView } from '../message-view.js';
import { deleteMessages, moveMessages } from '../imap/ops.js';
import { startJob } from '../jobs.js';

export const router = Router();

// Standalone full-message page (opened in a new tab). The CSP allows
// images/styles/fonts but no scripts, fetch, or frames beyond the inline
// srcdoc body — the message markup is untrusted.
router.get('/:id/view', async (req, res) => {
  const { row, parsed } = await fetchFullMessage(Number(req.params.id));
  res.set('Content-Security-Policy',
    "default-src 'none'; img-src data: http: https:; style-src 'unsafe-inline' http: https:; font-src data: http: https:; frame-src data: about:");
  res.type('html').send(renderMessageView(parsed, row));
});

// Raw RFC822 source as plain text (opened in a new tab).
router.get('/:id/source', async (req, res) => {
  const source = await fetchRawSource(Number(req.params.id));
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'");
  res.type('text/plain; charset=utf-8').send(source);
});

// Downloads one attachment, addressed by its index in the parsed message
// (the view page links carry the same index). Always served as a download —
// never rendered — since attachment content is untrusted.
router.get('/:id/attachment/:index', async (req, res) => {
  const { parsed } = await fetchFullMessage(Number(req.params.id));
  const att = (parsed.attachments ?? [])[Number(req.params.index)];
  if (!att) return res.status(404).json({ error: 'No such attachment' });
  res.set('X-Content-Type-Options', 'nosniff');
  res.attachment(att.filename || `attachment-${req.params.index}`);
  if (att.contentType) res.type(att.contentType);
  res.send(att.content);
});

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
