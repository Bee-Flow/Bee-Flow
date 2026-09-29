/**
 * Score model — the weights math shared by /overview and the runner snapshot.
 * Run: node --test server/compliance/score.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Inert fake db so requiring registry/checks (via score.js) never touches Postgres.
const mockDb = {
    exec: async () => {},
    run: async () => ({ rowCount: 0, rows: [] }),
    getOne: async () => null,
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
};
const dbResolved = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: mockDb };

const registry = require('./registry');
const frameworks = require('./frameworks');
const { computeScore, forRegulation, scoresByFramework, scoreNumbers, customFrameworkScore, SEVERITY_WEIGHT, REGULATIONS, SNAPSHOT_COLUMN } = require('./score');

// Rows deliberately use ids the registry does NOT know, so severity comes from
// the row itself — the same path DB rows take.
const row = (severity, status, regulation = 'GDPR') =>
    ({ check_id: `X-${Math.random()}`, severity, status, regulation });

test('empty input scores 0 with zeroed counters', () => {
    assert.deepStrictEqual(computeScore([]), { score: 0, total: 0, pass: 0, warn: 0, fail: 0, na: 0 });
});

test('all pass = 100, all fail = 0', () => {
    assert.strictEqual(computeScore([row('high', 'pass'), row('low', 'pass')]).score, 100);
    assert.strictEqual(computeScore([row('high', 'fail'), row('low', 'fail')]).score, 0);
});

test('warn earns half its weight', () => {
    // one critical warn: earned 1.5 of max 3 → 50
    assert.strictEqual(computeScore([row('critical', 'warn')]).score, 50);
});

test('not_applicable is excluded from the denominator', () => {
    const r = computeScore([row('critical', 'not_applicable'), row('low', 'pass')]);
    assert.strictEqual(r.score, 100);
    assert.strictEqual(r.na, 1);
});

// M1. A framework nobody has to comply with used to score a perfect 100: every
// check of a framework marked `relevance: not_relevant` returns
// 'not_applicable' by design, so `max` stayed 0 and the `: 100` branch fired.
// Nothing was measured, so there is no score — `null`, the contract's unknown.
test('every row not_applicable → score is null, not 100 — nothing was measured', () => {
    const r = computeScore([row('critical', 'not_applicable', 'MACHINERY'), row('low', 'not_applicable', 'MACHINERY')]);
    assert.strictEqual(r.score, null, 'a framework marked not relevant is not 100 % compliant');
    assert.strictEqual(r.na, 2);
    assert.strictEqual(r.total, 2, 'the rows are still counted, so the card can say "2 checks · 2 n/a"');
    assert.deepStrictEqual([r.pass, r.warn, r.fail], [0, 0, 0]);
    // The custom-framework runner's spelling of the same status, same answer.
    assert.strictEqual(computeScore([{ check_id: 'CUSTOM-X-1', severity: 'high', status: 'na' }]).score, null);
});

test('one counting row is enough for a number — the null is about an empty denominator, not about n/a rows existing', () => {
    assert.strictEqual(computeScore([row('critical', 'not_applicable'), row('low', 'fail')]).score, 0);
    assert.strictEqual(computeScore([row('critical', 'not_applicable'), row('low', 'warn')]).score, 50);
});

test('an EMPTY list keeps its documented score 0 — display callers guard on rows.length instead', () => {
    // Pinned so the two "nothing to measure" shapes stay deliberate and
    // distinguishable: no rows at all is the never-scanned aggregate (guarded
    // by `rows.length ?` in every framework-card path), all-n/a is `null`.
    assert.deepStrictEqual(computeScore([]), { score: 0, total: 0, pass: 0, warn: 0, fail: 0, na: 0 });
});

test('severity weights bias the score', () => {
    // critical fail (w3) + low pass (w0.5): earned 0.5 / max 3.5 → 14
    const r = computeScore([row('critical', 'fail'), row('low', 'pass')]);
    assert.strictEqual(r.score, Math.round((0.5 / 3.5) * 100));
});

test('weight table is the documented one', () => {
    assert.deepStrictEqual(SEVERITY_WEIGHT, { critical: 3, high: 2, medium: 1, low: 0.5 });
});

test('forRegulation splits on the row regulation for rows the registry does not know', () => {
    const rows = [row('high', 'pass', 'GDPR'), row('high', 'fail', 'AIA')];
    assert.strictEqual(forRegulation(rows, 'GDPR').length, 1);
    assert.strictEqual(forRegulation(rows, 'AIA').length, 1);
});

// A registered check that counts for two frameworks: home GDPR, tagged ISO.
const shared = {
    id: 'GDPR-Art33-score-test', regulation: 'GDPR', article: '33', severity: 'high', scope: 'global', verification: 'automated',
    frameworks: [{ regulation: 'ISO27001', ref: 'A.5.24' }],
    evaluate: async () => ({ status: 'pass' }),
};
registry.register(shared);

test('forRegulation follows the registry frameworks[] — a shared check counts once per framework', () => {
    const rows = [
        { check_id: shared.id, status: 'pass', regulation: 'GDPR' },
        row('high', 'fail', 'ISO27001'),
    ];
    assert.deepStrictEqual(forRegulation(rows, 'GDPR').map(r => r.check_id), [shared.id]);
    assert.strictEqual(forRegulation(rows, 'ISO27001').length, 2, 'the tagged GDPR row joins the ISO rows');
    assert.strictEqual(forRegulation(rows, 'ISO27001').filter(r => r.check_id === shared.id).length, 1, 'once, not twice');
    assert.strictEqual(forRegulation(rows, 'AIA').length, 0);
});

test('REGULATIONS is the catalogue order and SNAPSHOT_COLUMN names only the legacy three', () => {
    assert.deepStrictEqual(REGULATIONS, frameworks.regulationCodes());
    assert.deepStrictEqual(REGULATIONS.slice(0, 3), ['GDPR', 'AIA', 'ISO27001']);
    assert.deepStrictEqual(SNAPSHOT_COLUMN, { GDPR: 'gdpr_score', AIA: 'aia_score', ISO27001: 'iso_score' });
});

test('scoresByFramework: one entry per built-in framework, null where nothing counts, shared rows in both', () => {
    const rows = [
        { check_id: shared.id, status: 'pass', regulation: 'GDPR' },  // high, counts for GDPR + ISO
        row('high', 'fail', 'ISO27001'),                              // unknown id → row regulation
        row('medium', 'warn', 'NIS2'),
    ];
    const by = scoresByFramework(rows);
    assert.deepStrictEqual(Object.keys(by), frameworks.listBuiltin().map(f => f.id));
    assert.strictEqual(by.gdpr.score, 100);
    assert.strictEqual(by.gdpr.total, 1);
    assert.strictEqual(by.iso27001.score, 50, 'one high pass + one high fail');
    assert.strictEqual(by.iso27001.total, 2);
    assert.strictEqual(by.nis2.score, 50);
    assert.strictEqual(by.aia, null, 'no rows → null, never 100');
    assert.strictEqual(by.cra, null);
});

test('scoresByFramework with an active set scores only those frameworks', () => {
    const rows = [
        { check_id: shared.id, status: 'pass', regulation: 'GDPR' },
        row('medium', 'warn', 'NIS2'),
    ];
    const by = scoresByFramework(rows, new Set(['GDPR', 'AIA']));
    assert.deepStrictEqual(Object.keys(by).sort(), ['aia', 'gdpr']);
    assert.strictEqual(by.gdpr.score, 100);
    assert.strictEqual(by.aia, null);
    assert.ok(!('iso27001' in by), 'a disabled framework is not scored from shared rows');
    assert.ok(!('nis2' in by));
});

// M1, at the level the framework card reads: the exact reproduction from the
// review. MACHINERY's checks all answer not_applicable when the org marked the
// framework not relevant; `{"machinery":100}` put a perfect card on screen.
test('a framework whose every row is not_applicable scores null, not 100 — card, snapshot and scoreNumbers agree', () => {
    const rows = [
        row('high', 'not_applicable', 'MACHINERY'),
        row('critical', 'not_applicable', 'MACHINERY'),
    ];
    const by = scoresByFramework(rows, new Set(['MACHINERY']));
    assert.deepStrictEqual(Object.keys(by), ['machinery']);
    assert.strictEqual(by.machinery.score, null, 'not 100 — nothing was measured');
    assert.strictEqual(by.machinery.na, 2, 'the n/a tally survives so the card can still say what it found');
    assert.deepStrictEqual(scoreNumbers(by), { machinery: null }, 'the snapshot JSONB stores null, not 100');
});

test('scoreNumbers flattens to { id: n | null } for the snapshot JSONB', () => {
    assert.deepStrictEqual(scoreNumbers({ gdpr: { score: 79, total: 4 }, aia: null }), { gdpr: 79, aia: null });
    assert.deepStrictEqual(scoreNumbers(null), {});
    // A counter object whose score is null flattens to null, never to 0 —
    // `s ? s.score : null` must keep reading the field, not the object.
    assert.deepStrictEqual(scoreNumbers({ machinery: { score: null, total: 3, na: 3 } }), { machinery: null });
});

test('customFrameworkScore maps attested→pass, todo→fail, not_applicable→na', () => {
    const rows = [
        { check_id: 'CUSTOM-ACME-Q1', status: 'attested', severity: 'high' },
        { check_id: 'CUSTOM-ACME-Q2', status: 'todo', severity: 'high' },
        { check_id: 'CUSTOM-ACME-Q3', status: 'not_applicable', severity: 'critical' },
    ];
    const s = customFrameworkScore(rows);
    assert.deepStrictEqual(s, { score: 50, total: 3, pass: 1, warn: 0, fail: 1, na: 1 });
    // Rows already in the check vocabulary pass through.
    assert.strictEqual(customFrameworkScore([{ check_id: 'CUSTOM-X-1', status: 'warn', severity: 'low' }]).score, 50);
    assert.deepStrictEqual(customFrameworkScore([]), { score: 0, total: 0, pass: 0, warn: 0, fail: 0, na: 0 });
    assert.deepStrictEqual(customFrameworkScore(null).total, 0);
});
