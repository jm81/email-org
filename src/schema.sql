CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 993,
  secure INTEGER NOT NULL DEFAULT 1,
  allow_untrusted_cert INTEGER NOT NULL DEFAULT 0,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_path TEXT,
  delimiter TEXT,
  selectable INTEGER NOT NULL DEFAULT 1,
  no_inferiors INTEGER NOT NULL DEFAULT 0,
  special_use TEXT,
  uidvalidity INTEGER,
  uidnext INTEGER,
  msg_count INTEGER,
  unseen_count INTEGER,
  first_msg_date TEXT,
  last_msg_date TEXT,
  done_at TEXT,
  last_synced_at TEXT,
  UNIQUE (account_id, path)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid INTEGER NOT NULL,
  uidvalidity INTEGER NOT NULL,
  subject TEXT,
  from_addr TEXT,
  to_addrs TEXT,
  date TEXT,
  internaldate TEXT,
  size INTEGER,
  flags TEXT,
  UNIQUE (folder_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_messages_folder_date ON messages (folder_id, date DESC);
