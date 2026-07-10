import { db } from './db.js';

const PUBLIC_COLS = 'id, name, host, port, secure, allow_untrusted_cert, username, created_at';

export function listAccounts() {
  return db.prepare(`SELECT ${PUBLIC_COLS} FROM accounts ORDER BY id`).all();
}

export function getAccount(id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

export function getAccountPublic(id) {
  return db.prepare(`SELECT ${PUBLIC_COLS} FROM accounts WHERE id = ?`).get(id);
}

export function createAccount({ name, host, port, secure, allowUntrustedCert, username, password }) {
  const info = db.prepare(
    `INSERT INTO accounts (name, host, port, secure, allow_untrusted_cert, username, password)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(name, host, port ?? 993, secure === false ? 0 : 1, allowUntrustedCert ? 1 : 0, username, password);
  return getAccountPublic(info.lastInsertRowid);
}

export function updateAccount(id, fields) {
  const existing = getAccount(id);
  if (!existing) return null;
  const merged = {
    name: fields.name ?? existing.name,
    host: fields.host ?? existing.host,
    port: fields.port ?? existing.port,
    secure: fields.secure === undefined ? existing.secure : (fields.secure ? 1 : 0),
    allow_untrusted_cert: fields.allowUntrustedCert === undefined
      ? existing.allow_untrusted_cert : (fields.allowUntrustedCert ? 1 : 0),
    username: fields.username ?? existing.username,
    password: fields.password || existing.password,
  };
  db.prepare(
    `UPDATE accounts SET name=@name, host=@host, port=@port, secure=@secure,
     allow_untrusted_cert=@allow_untrusted_cert, username=@username, password=@password
     WHERE id=@id`
  ).run({ ...merged, id: Number(id) });
  return getAccountPublic(id);
}

export function deleteAccount(id) {
  return db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
}
