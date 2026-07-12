// Pure algorithm tests — no Dovecot, no DB, no server.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSubject, normalizeBody, shingles, coverage, findRedundant,
  addrSortKey, MIN_WORDS, COVERAGE_THRESHOLD,
} from '../src/redundancy.js';

describe('normalizeSubject', () => {
  test('strips stacked reply/forward prefixes', () => {
    assert.equal(normalizeSubject('Re: Re: Fwd: Budget plan'), 'budget plan');
    assert.equal(normalizeSubject('RE[2]: Budget plan'), 'budget plan');
    assert.equal(normalizeSubject('FW: fwd: aw: Sv: hello'), 'hello');
  });
  test('collapses whitespace, keeps non-prefixed subjects', () => {
    assert.equal(normalizeSubject('  Budget   plan '), 'budget plan');
    assert.equal(normalizeSubject('Regarding: the plan'), 'regarding: the plan');
    assert.equal(normalizeSubject(null), '');
  });
});

describe('addrSortKey', () => {
  test('domain sorts before local part, case-insensitively', () => {
    assert.equal(addrSortKey('Jane Doe <Jane@Dom.com>'), 'dom.com\x00jane');
    assert.ok(addrSortKey('zed@aaa.com') < addrSortKey('ann@bbb.com'), 'domain outranks local');
    assert.ok(addrSortKey('ann@dom.com') < addrSortKey('zed@dom.com'), 'local breaks domain ties');
  });
  test('first address wins in multi-recipient lists, bracketed or bare', () => {
    assert.equal(addrSortKey('Jane <jane@dom.com>, bob@x.co'), addrSortKey('jane@dom.com'));
    assert.equal(addrSortKey('bob@x.co, Jane <jane@dom.com>'), addrSortKey('bob@x.co'));
    assert.equal(addrSortKey('Doe, Jane <jane@dom.com>'), addrSortKey('jane@dom.com'));
  });
  test('unparseable input keys to null', () => {
    assert.equal(addrSortKey(null), null);
    assert.equal(addrSortKey(''), null);
    assert.equal(addrSortKey('no address here'), null);
    assert.equal(addrSortKey('@dom.com'), null);
    assert.equal(addrSortKey('user@'), null);
  });
});

describe('normalizeBody', () => {
  test('strips quote markers at any depth', () => {
    assert.deepEqual(normalizeBody('> alpha beta\n>> gamma\n>  > delta'),
      ['alpha', 'beta', 'gamma', 'delta']);
  });
  test('re-wrapped text normalizes identically', () => {
    const a = normalizeBody('the quick brown fox jumps\nover the lazy dog');
    const b = normalizeBody('the quick brown\nfox jumps over the lazy dog');
    assert.deepEqual(a, b);
  });
  test('punctuation and case differences vanish', () => {
    assert.deepEqual(normalizeBody('Hello, World! (Again)'), normalizeBody('hello world again'));
  });
  test('drops separator lines and URL-ish tokens', () => {
    assert.deepEqual(normalizeBody('----- Original Message -----\nkeep this'), ['keep', 'this']);
    assert.deepEqual(normalizeBody('see https://example.com/x?y=1 and www.example.com now'),
      ['see', 'and', 'now']);
  });
});

describe('coverage', () => {
  const words = (s) => s.split(' ');
  test('identical text covers fully', () => {
    const t = words('one two three four five six seven eight nine ten eleven twelve');
    assert.equal(coverage(shingles(t), shingles(t)), 1);
  });
  test('quoted body inside a longer reply covers fully', () => {
    const inner = words('one two three four five six seven eight nine ten eleven twelve');
    const outer = words('thanks for this looks good ' + inner.join(' ') + ' talk soon');
    assert.equal(coverage(shingles(inner), shingles(outer)), 1);
  });
  test('disjoint text covers nothing', () => {
    const a = shingles(words('alpha beta gamma delta epsilon zeta eta theta iota kappa'));
    const b = shingles(words('uno dos tres cuatro cinco seis siete ocho nueve diez'));
    assert.equal(coverage(a, b), 0);
  });
  test('trimmed tail dents coverage but a long match still passes the threshold', () => {
    const full = words('w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 w19 w20 '
      + 'w21 w22 w23 w24 w25 w26 w27 w28 w29 w30 w31 w32 w33 w34 w35 w36 w37 w38 w39 w40');
    const trimmed = full.slice(0, 38); // container dropped the last two words
    const c = coverage(shingles(full), shingles(trimmed));
    assert.ok(c >= COVERAGE_THRESHOLD, `coverage ${c}`);
    assert.ok(c < 1);
  });
});

describe('findRedundant', () => {
  const msg = (id, sortKey, text, uid = id) =>
    ({ id, uid, sortKey, tokens: normalizeBody(text) });
  const long = 'here is the first draft of the budget summary for the spring project please review it';

  test('chain A ⊂ B ⊂ C marks A and B, keeps C', () => {
    const a = msg(1, '2024-01-01', long);
    const b = msg(2, '2024-01-02', 'looks good to me overall\n' + long.split(' ').map((w) => '> ' + w).join('\n'));
    const c = msg(3, '2024-01-03', 'final answer approved thanks everyone\n'
      + normalizeBody(b.tokens.join(' ')).map((w) => '> ' + w).join(' '));
    const found = findRedundant([c, a, b]); // order-independent
    assert.deepEqual(found.map((r) => r.id).sort(), [1, 2]);
    for (const r of found) {
      assert.equal(r.containedIn, 3, 'attributed to the newest container');
    }
  });

  test('short bodies are never marked', () => {
    const a = msg(1, '2024-01-01', 'Thanks!');
    const b = msg(2, '2024-01-02', 'You are welcome!\n> Thanks!');
    assert.ok(normalizeBody('Thanks!').length < MIN_WORDS);
    assert.deepEqual(findRedundant([a, b]), []);
  });

  test('non-contained sibling is not marked', () => {
    const a = msg(1, '2024-01-01', long);
    const b = msg(2, '2024-01-02', 'completely different message about the summer offsite plans and the catering options we discussed');
    assert.deepEqual(findRedundant([a, b]), []);
  });

  test('equal dates: only the lower uid can be marked, higher uid survives', () => {
    const a = msg(1, '2024-01-01', long, 10);
    const b = msg(2, '2024-01-01', long, 20);
    const found = findRedundant([b, a]);
    assert.deepEqual(found, [{ id: 1, containedIn: 2 }]);
  });
});
