#!/bin/bash
# Starts a throwaway, non-root Dovecot (brew install dovecot) on localhost for
# integration tests. IMAP on 127.0.0.1:1143 (cleartext), 1993 (TLS, self-signed).
# Users: alice/alicepw, bob/bobpw. All state lives in test/tmp — safe to rm -rf.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$HERE/tmp"
DOVECOT="${DOVECOT_BIN:-/opt/homebrew/opt/dovecot/sbin/dovecot}"
ME="$(id -un)"

"$HERE/stop-dovecot.sh" 2>/dev/null || true
rm -rf "$DIR"
mkdir -p "$DIR/run" "$DIR/mail"

cat > "$DIR/users" <<EOF
alice:{plain}alicepw:$(id -u):$(id -g)::$DIR/mail/alice
bob:{plain}bobpw:$(id -u):$(id -g)::$DIR/mail/bob
EOF

cat > "$DIR/dovecot.conf" <<EOF
dovecot_config_version = 2.4.0
dovecot_storage_version = 2.4.0

base_dir = $DIR/run
state_dir = $DIR/state
log_path = $DIR/dovecot.log


default_internal_user = $ME
default_internal_group = $(id -gn)
default_login_user = $ME

protocols = imap
listen = 127.0.0.1

# TLS is off: Dovecot 2.4 on macOS drops TLS connections at the first
# post-login client write (login-process proxy bug), so tests run cleartext.
ssl = no

auth_mechanisms = plain
auth_allow_cleartext = yes

mail_home = $DIR/mail/%{user}
mail_driver = maildir
mail_path = ~/Maildir

first_valid_uid = $(id -u)
first_valid_gid = $(id -g)

passdb passwd-file {
  passwd_file_path = $DIR/users
  default_password_scheme = plain
}
userdb passwd-file {
  passwd_file_path = $DIR/users
}

service imap-login {
  chroot =
  restart_request_count = unlimited
  client_limit = 100
  inet_listener imap {
    port = 1143
  }
}
EOF

# macOS Sonoma+ rejects all setrlimit(RLIMIT_DATA) calls, which kills every
# dovecot child at startup; the shim makes those calls report success.
if [ ! -f "$HERE/setrlimit-shim.dylib" ]; then
  cc -dynamiclib -o "$HERE/setrlimit-shim.dylib" "$HERE/setrlimit-shim.c"
fi
DYLD_INSERT_LIBRARIES="$HERE/setrlimit-shim.dylib" "$DOVECOT" -c "$DIR/dovecot.conf"
for i in $(seq 1 20); do
  if nc -z 127.0.0.1 1143 2>/dev/null; then
    echo "dovecot ready on 127.0.0.1:1143 (imap, cleartext)"
    exit 0
  fi
  sleep 0.25
done
echo "dovecot failed to start; log:" >&2
cat "$DIR/dovecot.log" >&2 || true
exit 1
