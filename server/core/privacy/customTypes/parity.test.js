'use strict';
/**
 * Parity: an org's old "Always hide these" terms, migrated to types and run
 * through detectPii, hide at least everything the old scanner
 * (core/dlp/customTerms.js, kept as the reference for one release) hid,
 * attributed to the SAME term, and nothing for a term it skipped.
 *
 * The fixtures are the old scanner's own test cases (customTerms.test.js).
 * "At least": the old scanner ran one union regex per case rule, so of two
 * terms matching at one position only the first was reported; the merge now
 * keeps the union of both. Never less.
 *
 * Run: cd server && node --test core/privacy/customTypes/parity.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

require('../../http/routeHarness').recordDb();

const { scanCustomTerms } = require('../../dlp/customTerms');
const { detectPii } = require('../piiDetection');
const { migrateLegacyTerms } = require('./migrate');
const { legacyTypeId } = require('./ids');
const { _resetLegacyRunner } = require('./legacyRunner');

test.after(() => _resetLegacyRunner());

let n = 0;
const nextOrg = () => `parity-org-${++n}`;

/** Every old finding is covered by a new entity of the same term's type. */
async function assertParity(text, terms) {
    const orgId = nextOrg();
    const types = migrateLegacyTerms(orgId, terms);
    const ids = types.filter(t => t.status !== 'invalid').map(t => t.id);
    const old = scanCustomTerms(text, orgId, terms);
    const fresh = ids.length ? await detectPii(text, ids, 0.7, { customTypes: types }) : { entities: [] };
    for (const f of old.findings) {
        if (f.end === f.start) continue; // a zero-width match was never a span
        const wanted = legacyTypeId(orgId, terms.find(t => (t.id || null) === f.termId) || { id: f.termId });
        const cover = fresh.entities.find(e => e.offset <= f.start && e.offset + e.length >= f.end
            && (e.category === wanted || (e.alsoCategories || []).includes(wanted)));
        assert.ok(cover, `old finding "${f.match}" (${f.termId}) is not covered by its type`);
    }
    return { old, fresh, types };
}

test('a skipped term stays skipped, and nobody borrows its name', async () => {
    const terms = [
        { id: 't-noLabel', pattern: 'GEHEIM', type: 'literal' },
        { id: 't-alpha', label: 'Projectnaam', pattern: 'Aurora', type: 'literal' },
        { id: 't-beta', label: 'Klantcode', pattern: 'KC-\\d{4}', type: 'regex' },
    ];
    const text = 'Dossier GEHEIM over Aurora met code KC-1234 erin';
    const { fresh, types } = await assertParity(text, terms);
    assert.equal(types.length, 2);
    assert.ok(!fresh.entities.some(e => e.text === 'GEHEIM'));
    assert.deepEqual(fresh.entities.map(e => [e.text, e.label]), [['Aurora', 'Projectnaam'], ['KC-1234', 'Klantcode']]);
});

test('an invalid regex is kept red, not enforced, and its neighbours still run', async () => {
    const terms = [
        { id: 'ok-1', label: 'Eerste', pattern: 'Alpha', type: 'literal' },
        { id: 'bad', label: 'Kapot', pattern: '([unclosed', type: 'regex' },
        { id: 'ok-2', label: 'Derde', pattern: 'Gamma', type: 'literal' },
    ];
    const { fresh, types } = await assertParity('Alpha en Gamma samen', terms);
    assert.equal(types.find(t => t.legacyTermId === 'bad').status, 'invalid');
    assert.deepEqual(fresh.entities.map(e => e.text), ['Alpha', 'Gamma']);
});

test('case rules are kept per term', async () => {
    const terms = [
        { id: 'cs', label: 'Exact', pattern: 'Aurora', type: 'literal', caseSensitive: true },
        { id: 'ci', label: 'Losjes', pattern: 'Borealis', type: 'literal' },
    ];
    const { fresh } = await assertParity('aurora AURORA Aurora borealis BOREALIS', terms);
    assert.deepEqual(fresh.entities.map(e => e.text), ['Aurora', 'borealis', 'BOREALIS']);
});

test('anchors and lookarounds keep their meaning (RE2 where it can, the V8 worker where it cannot)', async () => {
    const terms = [
        { id: 'anchored', label: 'Regelstart', pattern: '^TOPGEHEIM', type: 'regex', caseSensitive: true },
        { id: 'lookahead', label: 'Vooruitkijk', pattern: 'KC-(?=\\d{4})\\d{4}', type: 'regex', caseSensitive: true },
    ];
    const { fresh, types } = await assertParity('TOPGEHEIM dossier KC-1234 hier', terms);
    assert.deepEqual(types.map(t => t.pattern.engine), ['re2', 'v8-legacy']);
    assert.deepEqual(fresh.entities.map(e => e.text), ['TOPGEHEIM', 'KC-1234']);
});

test('mixed case rules do not shadow each other; literals are literal; offsets slice back', async () => {
    await assertParity('ALPHA Beta beta GAMMA', [
        { id: 'a', label: 'A', pattern: 'alpha', type: 'literal' },
        { id: 'b', label: 'B', pattern: 'Beta', type: 'literal', caseSensitive: true },
        { id: 'c', label: 'C', pattern: 'gamma', type: 'literal' },
    ]);
    const { fresh } = await assertParity('axbxxc hoort niet, a.b*c wel', [{ id: 'lit', label: 'Letterlijk', pattern: 'a.b*c', type: 'literal' }]);
    assert.deepEqual(fresh.entities.map(e => e.text), ['a.b*c']);
    const text = 'ver weg staat Aurora ergens en Aurora nog eens';
    const r = await assertParity(text, [{ id: 'x', label: 'X', pattern: 'Aurora', type: 'literal' }]);
    for (const e of r.fresh.entities) assert.equal(text.slice(e.offset, e.offset + e.length), e.text);
    assert.equal(r.fresh.entities.length, 2);
});

test('a literal matched inside a word before is matched inside a word now (no whole-word rule for migrated terms)', async () => {
    const { fresh } = await assertParity('Auroraproject en aurora', [{ id: 'x', label: 'X', pattern: 'Aurora', type: 'literal' }]);
    assert.deepEqual(fresh.entities.map(e => e.text), ['Aurora', 'aurora']);
});

test('overlapping terms: the old scanner kept the first, the merge keeps the union', async () => {
    const terms = [
        { id: 'short', label: 'Kort', pattern: 'Aur', type: 'literal' },
        { id: 'long', label: 'Lang', pattern: 'Aurora', type: 'literal' },
    ];
    const { old, fresh } = await assertParity('Project Aurora', terms);
    assert.deepEqual(old.findings.map(f => f.match), ['Aur'], 'the reference only reported the first alternative');
    assert.deepEqual(fresh.entities.map(e => e.text), ['Aurora'], 'the whole word is hidden now');
});

test('a zero-width pattern produces no span and does not loop', async () => {
    const { fresh } = await assertParity('abc', [{ id: 'z', label: 'Leeg', pattern: 'x*', type: 'regex' }]);
    assert.deepEqual(fresh.entities, []);
});
