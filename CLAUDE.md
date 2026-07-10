# email-org — Agent Guidelines

Read `README.md` for what the app is and how it's laid out. The rules below
are the non-negotiables that aren't obvious from the code.

## Live data warning

- `data/app.db` contains **real IMAP credentials and cached mail from real
  accounts** (passwords in plaintext by design). Never commit it, never print
  its contents, never point tests at it.
- Anything destructive (delete, move, flatten) must be developed and verified
  against the throwaway Dovecot (`test/start-dovecot.sh`), never against a
  real account. The integration and e2e suites already do this — use them.

## Testing

- `npm test` — integration suite; starts its own disposable Dovecot
  (requires `brew install dovecot`) and app server on port 8399.
- `npm run e2e` — drives the real UI with headless system Chrome.
- Run both before committing changes to `src/imap/` — that's where all the
  correctness-critical logic lives (UIDVALIDITY checks, flatten ordering,
  cross-account move safety). If you change those invariants, add a test.
- The Dovecot setup has two deliberate macOS workarounds (setrlimit shim,
  cleartext-only). Don't "fix" them; see README for why.

## Constraints

- Frontend is vanilla JS ES modules with **no build step** — don't introduce
  bundlers, frameworks, or npm frontend dependencies.
- Server binds 127.0.0.1 only. Keep it that way.
- Express 5: async route errors propagate to the error handler in
  `server.js` — don't add per-route try/catch for that.
- Per-account IMAP work must go through `pool.run()` (serialized; one
  connection per account). Never read `client.mailbox` state without a fresh
  SELECT — use `pool.withFreshMailbox()` (see the comment there for why).
