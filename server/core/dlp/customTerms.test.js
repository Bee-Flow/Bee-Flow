/**
 * Custom sensitive terms: every configured term is scanned, under its own
 * label, with its own case rule.
 *
 * The bug this file exists for: `_compile` built `termIndex` with `continue`
 * skips, then built the union in a SECOND pass indexed by position
 * (`termIndex.map((entry, i) => ... terms[i] ...)`). After any skip the two
 * were off by one, so a match on term A's pattern was reported under term B's
 * label and term id, and the last configured term was never scanned at all.
 *
 * Reproduced before the fix, with a term missing a label followed by two valid
 * ones:
 *
 *     GEHEIM   -> reported as "Projectnaam" (a term deliberately SKIPPED)
 *     Aurora   -> reported as "Klantcode"   (wrong label AND wrong termId)
 *     KC-1234  -> not scanned at all        (silent miss)
 *
 * Both directions matter in a redaction control: something the admin never
 * configured got redacted under someone else's name, and something they did
 * configure was ignored.
 *
 * Run: node --test server/core/dlp/customTerms.test.js
 */

const assert = require('assert');
const { test, beforeEach } = require('node:test');

const { scanCustomTerms, invalidate, _compile, MAX_SCAN_CHARS } = require('./customTerms');

let org = 0;
/** Fresh org id per call — the compile cache is keyed on it. */
const nextOrg = () => `org-${++org}`;

beforeEach(() => { /* ids are unique per test, nothing to reset */ });

test('a skipped term does not shift every later term onto the wrong label', () => {
    const terms = [
        { id: 't-noLabel', pattern: 'GEHEIM', type: 'literal' },                    // no label → skipped
        { id: 't-alpha', label: 'Projectnaam', pattern: 'Aurora', type: 'literal' },
        { id: 't-beta', label: 'Klantcode', pattern: 'KC-\\d{4}', type: 'regex' },
    ];
    const text = 'Dossier GEHEIM over Aurora met code KC-1234 erin';
    const { findings } = scanCustomTerms(text, nextOrg(), terms);

    const byMatch = Object.fromEntries(findings.map(f => [f.match, f]));

    // The skipped term must not be scanned under a borrowed identity.
    assert.ok(!('GEHEIM' in byMatch),
        'a term with no label was skipped from the index but still scanned');

    assert.ok(byMatch['Aurora'], 'Aurora should be found');
    assert.strictEqual(byMatch['Aurora'].label, 'Projectnaam');
    assert.strictEqual(byMatch['Aurora'].termId, 't-alpha');

    // The regression that produced a silent miss.
    assert.ok(byMatch['KC-1234'], 'the last configured term was never scanned');
    assert.strictEqual(byMatch['KC-1234'].label, 'Klantcode');
    assert.strictEqual(byMatch['KC-1234'].termId, 't-beta');
});

test('an invalid regex is skipped without disturbing its neighbours', () => {
    const terms = [
        { id: 'ok-1', label: 'Eerste', pattern: 'Alpha', type: 'literal' },
        { id: 'bad', label: 'Kapot', pattern: '([unclosed', type: 'regex' },
        { id: 'ok-2', label: 'Derde', pattern: 'Gamma', type: 'literal' },
    ];
    const { findings } = scanCustomTerms('Alpha en Gamma samen', nextOrg(), terms);
    assert.deepStrictEqual(
        findings.map(f => [f.match, f.label, f.termId]),
        [['Alpha', 'Eerste', 'ok-1'], ['Gamma', 'Derde', 'ok-2']],
    );
});

test('case-sensitive terms match exactly, case-insensitive terms do not', () => {
    const terms = [
        { id: 'cs', label: 'Exact', pattern: 'Aurora', type: 'literal', caseSensitive: true },
        { id: 'ci', label: 'Losjes', pattern: 'Borealis', type: 'literal' },
    ];
    const { findings } = scanCustomTerms('aurora AURORA Aurora borealis BOREALIS', nextOrg(), terms);

    const exact = findings.filter(f => f.termId === 'cs');
    assert.strictEqual(exact.length, 1, 'case-sensitive term matched the wrong casings');
    assert.strictEqual(exact[0].match, 'Aurora');

    const loose = findings.filter(f => f.termId === 'ci');
    assert.deepStrictEqual(loose.map(f => f.match), ['borealis', 'BOREALIS']);
});

test('a case-sensitive pattern carrying its own anchors still matches', () => {
    // The old post-filter re-tested each match against `^(?:pattern)$`, so a
    // pattern with its own anchors or lookarounds failed the re-test and its
    // legitimate match was dropped. Bucketing by flags removes the re-test.
    const terms = [
        { id: 'anchored', label: 'Regelstart', pattern: '^TOPGEHEIM', type: 'regex', caseSensitive: true },
        { id: 'lookahead', label: 'Vooruitkijk', pattern: 'KC-(?=\\d{4})\\d{4}', type: 'regex', caseSensitive: true },
    ];
    const { findings } = scanCustomTerms('TOPGEHEIM dossier KC-1234 hier', nextOrg(), terms);
    const matches = findings.map(f => f.match).sort();
    assert.deepStrictEqual(matches, ['KC-1234', 'TOPGEHEIM']);
});

test('mixed case-sensitivity does not make terms shadow each other', () => {
    const terms = [
        { id: 'a', label: 'A', pattern: 'alpha', type: 'literal' },                       // insensitive
        { id: 'b', label: 'B', pattern: 'Beta', type: 'literal', caseSensitive: true },   // sensitive
        { id: 'c', label: 'C', pattern: 'gamma', type: 'literal' },                       // insensitive
    ];
    const { findings } = scanCustomTerms('ALPHA Beta beta GAMMA', nextOrg(), terms);
    const ids = findings.map(f => f.termId);
    assert.ok(ids.includes('a'), 'insensitive term before a sensitive one was lost');
    assert.ok(ids.includes('c'), 'insensitive term after a sensitive one was lost');
    assert.strictEqual(findings.filter(f => f.termId === 'b').length, 1,
        'case-sensitive term matched the lower-case occurrence');
});

test('literal terms are escaped, not interpreted as patterns', () => {
    const terms = [{ id: 'lit', label: 'Letterlijk', pattern: 'a.b*c', type: 'literal' }];
    const { findings } = scanCustomTerms('axbxxc hoort niet, a.b*c wel', nextOrg(), terms);
    assert.deepStrictEqual(findings.map(f => f.match), ['a.b*c']);
});

test('offsets slice back to the reported match', () => {
    const terms = [{ id: 'x', label: 'X', pattern: 'Aurora', type: 'literal' }];
    const text = 'ver weg staat Aurora ergens en Aurora nog eens';
    const { findings } = scanCustomTerms(text, nextOrg(), terms);
    assert.strictEqual(findings.length, 2);
    for (const f of findings) {
        assert.strictEqual(text.slice(f.start, f.end), f.match);
    }
});

test('a zero-width pattern terminates instead of looping forever', () => {
    const terms = [{ id: 'z', label: 'Leeg', pattern: 'x*', type: 'regex' }];
    const { findings } = scanCustomTerms('abc', nextOrg(), terms);
    assert.ok(Array.isArray(findings));   // reaching this line is the assertion
});

test('oversize input is scanned as a bounded prefix and says so', () => {
    const terms = [{ id: 'x', label: 'X', pattern: 'NAALD', type: 'literal' }];
    const text = 'a'.repeat(MAX_SCAN_CHARS + 5000) + ' NAALD';
    const result = scanCustomTerms(text, nextOrg(), terms);

    assert.strictEqual(result.partial, true, 'oversize input must be reported as partial');
    assert.strictEqual(result.processedChars, MAX_SCAN_CHARS);
    assert.strictEqual(result.totalChars, text.length);
    // The needle is past the cap, so it is genuinely NOT found — the point is
    // that the caller is told, rather than being handed a confident empty list.
    assert.strictEqual(result.findings.length, 0);
});

test('invalidate() drops the cached compile so an edit takes effect', () => {
    const orgId = nextOrg();
    const before = scanCustomTerms('Aurora', orgId, [{ id: 'a', label: 'Oud', pattern: 'Aurora', type: 'literal' }]);
    assert.strictEqual(before.findings[0].label, 'Oud');

    // Without invalidate the cached compile keeps the old label.
    const stale = scanCustomTerms('Aurora', orgId, [{ id: 'a', label: 'Nieuw', pattern: 'Aurora', type: 'literal' }]);
    assert.strictEqual(stale.findings[0].label, 'Oud');

    invalidate(orgId);
    const after = scanCustomTerms('Aurora', orgId, [{ id: 'a', label: 'Nieuw', pattern: 'Aurora', type: 'literal' }]);
    assert.strictEqual(after.findings[0].label, 'Nieuw');
});

test('_compile pairs every entry with the source it was validated from', () => {
    // The structural property that makes the desync impossible: for every
    // entry in every union, the group in the compiled source must wrap that
    // entry's own pattern.
    const { unions } = _compile([
        { id: 'skip', pattern: 'X', type: 'literal' },                  // no label
        { id: 'a', label: 'A', pattern: 'Aurora', type: 'literal' },
        { id: 'b', label: 'B', pattern: 'Borealis', type: 'literal', caseSensitive: true },
        { id: 'c', label: 'C', pattern: 'KC-\\d{4}', type: 'regex' },
    ]);
    for (const union of unions) {
        for (const entry of union.entries) {
            assert.ok(union.compiled.source.includes(`(?<${entry.groupName}>${entry.source})`),
                `entry ${entry.id} is not paired with its own source in the union`);
        }
    }
    const allIds = unions.flatMap(u => u.entries.map(e => e.id));
    assert.deepStrictEqual(allIds.sort(), ['a', 'b', 'c']);
});

test('empty and malformed input is handled without throwing', () => {
    for (const args of [
        ['', nextOrg(), [{ id: 'a', label: 'A', pattern: 'x', type: 'literal' }]],
        ['tekst', null, [{ id: 'a', label: 'A', pattern: 'x', type: 'literal' }]],
        ['tekst', nextOrg(), []],
        ['tekst', nextOrg(), null],
    ]) {
        const r = scanCustomTerms(...args);
        assert.deepStrictEqual(r.findings, []);
        assert.strictEqual(r.partial, false);
    }
});
