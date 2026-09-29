// IMAP servers cap command length (Dovecot: 64 KB), so a UID list for a big
// folder can't go out as one FETCH. Batch it; each batch is a separate command.
// Kept free of db/pool imports so tests can load it without touching data/app.db.
export const FETCH_BATCH = 500;

export async function* fetchByUids(client, uids, query) {
  for (let i = 0; i < uids.length; i += FETCH_BATCH) {
    yield* client.fetch(uids.slice(i, i + FETCH_BATCH).join(','), query, { uid: true });
  }
}
