/*
 * macOS (Sonoma+) rejects setrlimit(RLIMIT_DATA, ...) with EINVAL for any
 * value, which makes every Dovecot 2.4 child process die at startup. This
 * shim, injected via DYLD_INSERT_LIBRARIES, turns failed setrlimit calls into
 * successes. Test infrastructure only — never used by the app itself.
 *
 * Build: cc -dynamiclib -o setrlimit-shim.dylib setrlimit-shim.c
 */
#include <sys/resource.h>

static int shim_setrlimit(int resource, const struct rlimit *rlp) {
  int rc = setrlimit(resource, rlp);
  return rc == 0 ? 0 : 0; /* pretend it worked */
}

__attribute__((used, section("__DATA,__interpose")))
static struct { void *shim; void *orig; } interpose_setrlimit = {
  (void *)shim_setrlimit, (void *)setrlimit,
};
