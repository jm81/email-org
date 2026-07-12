// Pure text logic for the "find redundant messages" scan: a message is
// redundant when a strictly newer message in the same thread quotes
// (nearly) all of it. No imports so unit tests run without DB or IMAP.

export const MIN_WORDS = 12;                 // shorter bodies are too ambiguous to mark
export const SHINGLE_SIZE = 8;               // words per overlapping chunk
export const COVERAGE_THRESHOLD = 0.9;       // fraction of A's shingles that must appear in B
export const MAX_SCAN_SIZE = 2 * 1024 * 1024; // skip likely attachment-heavy messages

// "Re: Fwd: RE[2]: x" -> "x"; groups a thread across reply/forward prefixes.
export function normalizeSubject(subject) {
  let s = String(subject ?? '').trim().toLowerCase();
  for (;;) {
    const t = s.replace(/^(re|fwd?|aw|sv)\s*(\[\d+\])?\s*:\s*/, '');
    if (t === s) break;
    s = t;
  }
  return s.replace(/\s+/g, ' ');
}

// First address in a comma-joined "Name <addr>, ..." list -> a key that
// sorts by domain, then local part, case-insensitively ("logical grouping"
// for the message-list From/To sorts). Null when no address is parseable;
// callers sort nulls last.
export function addrSortKey(addrs) {
  const token = String(addrs ?? '').split(/[\s,<>]+/).find((t) => t.includes('@'));
  const addr = (token ?? '').toLowerCase();
  const at = addr.lastIndexOf('@');
  if (at < 1 || at === addr.length - 1) return null;
  return addr.slice(at + 1) + '\x00' + addr.slice(0, at);
}

// Body text -> lowercase word tokens, immune to the mutations reply clients
// introduce: ">"/">>" quote markers, indentation, re-wrapping, punctuation
// and HTML-entity noise. URLs are dropped because plain-text and HTML-derived
// renderings of the same link rarely match.
export function normalizeBody(text) {
  const lines = [];
  for (let line of String(text ?? '').split(/\r?\n/)) {
    line = line.replace(/^[>\s]+/, '');
    if (/^-+\s*(original|forwarded) message\s*-+$/i.test(line)) continue;
    lines.push(line);
  }
  const joined = lines.join(' ').toLowerCase().replace(/(https?:\/\/|www\.)\S+/g, ' ');
  const tokens = joined.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.filter((t) => t.length <= 40);
}

export function shingles(tokens, k = SHINGLE_SIZE) {
  const set = new Set();
  if (!tokens.length) return set;
  if (tokens.length <= k) { set.add(tokens.join(' ')); return set; }
  for (let i = 0; i + k <= tokens.length; i++) set.add(tokens.slice(i, i + k).join(' '));
  return set;
}

// Fraction of A's shingles present in B's shingle set.
export function coverage(aShingles, bShingles) {
  if (!aShingles.size) return 0;
  let hits = 0;
  for (const s of aShingles) if (bShingles.has(s)) hits++;
  return hits / aShingles.size;
}

// msgs: one same-subject group of { id, uid, sortKey, tokens } where sortKey
// is an ISO date string (lexicographic compare is chronological). Returns
// [{ id, containedIn }] where containedIn is the newest strictly-newer
// message covering the body — so the final email in a chain always survives.
export function findRedundant(msgs) {
  const sorted = [...msgs].sort((a, b) =>
    a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.uid - b.uid);
  const sh = sorted.map((m) => shingles(m.tokens));
  const result = [];
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].tokens.length < MIN_WORDS) continue;
    for (let j = sorted.length - 1; j > i; j--) {
      if (coverage(sh[i], sh[j]) >= COVERAGE_THRESHOLD) {
        result.push({ id: sorted[i].id, containedIn: sorted[j].id });
        break;
      }
    }
  }
  return result;
}

// mailparser sets textAsHtml when only text exists; when only HTML exists,
// parsed.text is usually still derived. Last resort: strip tags crudely.
// (Shared by the body preview and the redundancy scan.)
export function htmlFallback(parsed) {
  return String(parsed.html).replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
