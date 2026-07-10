import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { router as accountsRouter } from './src/routes/accounts.js';
import { router as foldersRouter } from './src/routes/folders.js';
import { router as messagesRouter } from './src/routes/messages.js';
import { router as jobsRouter } from './src/routes/jobs.js';
import { closeAll } from './src/imap/pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(join(here, 'public')));

app.use('/api/accounts', accountsRouter);
app.use('/api/folders', foldersRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/jobs', jobsRouter);

// Express 5 propagates async route errors here.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.code === 'UIDVALIDITY_CHANGED' ? 409 : 500)
    .json({ error: err.responseText || err.message });
});

const port = Number(process.env.PORT) || 8323;
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`email-org running at http://127.0.0.1:${port}`);
});

process.on('SIGINT', async () => {
  server.close();
  await closeAll();
  process.exit(0);
});
