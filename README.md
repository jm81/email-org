# email-org

A local, single-user web app for bulk-organizing IMAP email folders — the
old-school folder-hierarchy workflow that modern clients (looking at you,
Spark) make painful. See `notes-for-claude.md` for the original spec.

**Local use only.** It binds to 127.0.0.1 and stores account passwords in
plaintext in a local SQLite db (`data/app.db`). Never expose it to a network.

## Run

```sh
npm install
npm start          # foreground, Ctrl-C to quit — http://127.0.0.1:8323
```

To leave it running without tying up a terminal:

```sh
npm run dev            # start detached (waits until it answers, then prints the URL)
npm run dev:restart    # pick up server-side changes
npm run dev:status     # running? which pid?
npm run dev:log        # tail -f the log
npm run dev:stop
```

There is no watch/auto-reload: a restart is always something you ask for, so
saving a file can't kill an IMAP sync or flatten that's in flight. Changes
under `public/` need no restart at all (no build step) — just reload the
browser. Anything else — `server.js`, `src/` — needs `npm run dev:restart`.

Output goes to `.run/server.log` (the previous run is kept as
`.run/server.log.prev`), and the pid to `.run/server.pid`; `.run/` is
gitignored. Both forms use port 8323 and the real `data/app.db`, so run one or
the other, not both — `npm run dev` refuses to start if something else already
holds the port. Override with `PORT=… npm run dev`.

Add an account (top right). For self-hosted servers with a self-signed
certificate, check "Allow untrusted certificate". Use "Test" before saving.

## What it does

- **Folder tree** for all accounts: expand/collapse, message counts, and a
  hint showing the month of each folder's most recent mail
- **Right-click a folder** (or its `⋮`): add subfolder (inline, no dialog),
  rename (inline), sync, mark done, find redundant messages, flatten, delete
- **Go to…** (top bar): jump straight to any folder via the type-ahead picker
- **Flatten**: moves every message in a folder's whole subtree up into that
  folder, then deletes the subfolders (deepest-first; a subfolder is only
  deleted after it is verified empty, so it's safe to re-run after a failure)
- **Message list**: click a row for a ~4-line text preview, double-click for
  the full text, click again to collapse; checkboxes + shift-click for ranges;
  unread messages are bold and attachment counts are shown per row
- **Right-click a message row**: open full message, show source, move, delete
- **Full message view**: opens in a new tab with headers and attachment
  downloads; the HTML body renders in a sandboxed iframe (no scripts, inline
  `cid:` images resolved)
- **Redundant-message scan** ("Find redundant messages" on a folder): flags
  messages whose text is ~fully quoted inside a newer message in the same
  thread (subject-grouped, shingle overlap on normalized body text). The scan
  is read-only — flagged rows just get a badge; deleting them goes through the
  normal reviewed select → Delete flow
- **Batch move/delete** with a single inline confirm (Enter confirms, Esc
  cancels). "Move to…" opens a type-ahead folder picker spanning all
  accounts — picking a folder in another account does a cross-account move
  (fetch → append → verified delete, so a failure can duplicate but never lose)
- **Done tracking**: "Mark done" stamps a local timestamp on the folder;
  filter by done state / done-before-date in the top bar
- **Quiet-folder filter**: show only folders with no mail in the last N months
- **Sync model**: message headers are cached in SQLite; a folder syncs when
  first opened, via ↻, or after any operation touching it. Bodies are always
  fetched live. Destructive operations verify the folder's UIDVALIDITY on the
  server first and refuse to run on a stale cache.

## Tests

```sh
npm test           # integration tests: real API against a throwaway Dovecot
npm run e2e        # drives the actual UI with headless Chrome
```

Both start their own disposable Dovecot (`brew install dovecot`) on
127.0.0.1:1143 with all state under `test/tmp/`. Two quirks of running Dovecot
2.4 unprivileged on modern macOS are handled by `test/start-dovecot.sh`: a
`DYLD_INSERT_LIBRARIES` shim that no-ops `setrlimit` (macOS rejects
RLIMIT_DATA changes, which kills every Dovecot child), and cleartext-only IMAP
(Dovecot's TLS login proxy drops post-login writes on macOS). TLS against real
servers is unaffected — that limitation is purely in the local test server.

## Layout

```
server.js            express app (port 8323, override with PORT)
bin/dev              start/stop/restart the server detached (state in .run/)
src/db.js            sqlite open + schema (data dir override: EMAIL_ORG_DATA)
src/imap/pool.js     one connection per account, all ops serialized per account
src/imap/sync.js     folder-list + per-folder header sync (UIDVALIDITY-aware)
src/imap/ops.js      create/rename/delete folder, flatten, batch delete, moves
src/imap/body.js     on-demand body fetch + text extraction (mailparser)
src/imap/redundancy.js  per-folder scan for messages quoted in a newer reply
src/redundancy.js    pure text logic for that scan (unit-tested, no DB/IMAP)
src/message-view.js  standalone "Open full message" page (sandboxed HTML body)
src/routes/          /api/accounts, /api/folders, /api/messages, /api/jobs
public/              vanilla-JS frontend, no build step
test/                integration + e2e suites and the throwaway Dovecot
```
