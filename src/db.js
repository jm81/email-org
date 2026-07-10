import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.EMAIL_ORG_DATA ?? join(here, '..', 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

// Additive migrations for databases created before a column existed.
const messageCols = new Set(db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name));
if (!messageCols.has('attachment_count')) {
  db.exec('ALTER TABLE messages ADD COLUMN attachment_count INTEGER');
}
