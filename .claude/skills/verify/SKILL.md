---
name: verify
description: How to spin up an isolated email-org instance (throwaway Dovecot + seeded server) and drive the real UI with headless Chrome to verify a change.
---

# Verifying email-org changes at the UI surface

Never verify against the real server/`data/app.db`. Build an isolated stack:

```bash
test/start-dovecot.sh          # throwaway Dovecot on 127.0.0.1:1143 (cleartext)
# WARNING: this WIPES test/tmp/ — copy any scripts into test/tmp/ AFTER it runs
node test/seed.js              # or import { seed } from test/seed.js in a script
PORT=8401 EMAIL_ORG_DATA=test/tmp/verify-data node server.js &
# create the account over the API (see test/run-e2e.sh for the curl calls)
...
test/stop-dovecot.sh
```

- Put driver scripts in `test/tmp/` (gitignored, and node_modules/`../seed.js`
  imports resolve there) — but only after `start-dovecot.sh`, which wipes it.
  Keep the master copy elsewhere.
- Drive the UI with `puppeteer-core` + system Chrome at
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  `headless: 'new'` — copy the selector idioms from `test/e2e.js`
  (`.folder-row`, `tr.msg`, `#batch-bar`, `#folder-meta`).
- Seed bulk messages by IMAP APPEND as alice (`test/seed.js` exports
  `IMAP`/`ALICE` and shows the rfc822 shape); ~1000 appends take seconds.
- First click on a folder triggers a header sync — wait on row count with a
  generous timeout, not on navigation.
- Use a port ≠ 8399 so a concurrently running `npm test`/`npm run e2e`
  doesn't collide.
