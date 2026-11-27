// @typecheck strict
/**
 * The rules of GET /api/studio/attention that run module projects' own code: app validation
 * (projects/completeness.js buildCompleteness over the App Studio validator), the empty
 * knowledge base in use (completeness.js's own finding) and the deep links of
 * completeness.js deepLinkFor. The module half of attentionChecks.test.js, owned by module
 * projects (scripts/module-map.json).
 *
 * Run: node --test --test-reporter=tap routes/studio/attentionChecks.projects.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    evaluateAppValidation,
    evaluateKbEmptyInUse,
    evaluateAutomationFailing,
    KB_READ_ROLES,
    MIN_FAILURE_STREAK,
} = require('./attentionChecks');
// The deep link is projects/completeness.js's helper in every case; only
// buildCompleteness (source 1) attaches it itself, so the other rules are
// checked through the helper the route runs them through.
const { deepLinkFor } = require('../../projects/completeness');

// An app definition with no screens: the App Studio validator's own
// `screens.missing` error, not a sentence invented here.
const APP_NO_SCREENS = { schemaVersion: 2, meta: { name: 'Order portal' }, screens: [] };
const APP_OK = {
    schemaVersion: 2,
    meta: { name: 'Fine' },
    screens: [{ id: 'scr1', name: 'Home', sections: [] }],
};

// ── 1. Apps ─────────────────────────────────────────────────────────────────

test('app validation reports the VALIDATOR\'s own record, with its deep link', () => {
    const { findings, gaps } = evaluateAppValidation({
        apps: [{ id: 'app1', name: 'Order portal', definition: APP_NO_SCREENS }],
        gaps: [],
    });
    assert.deepStrictEqual(gaps, []);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].code, 'screens.missing', 'the code comes from appStudio/validate.js');
    assert.strictEqual(findings[0].severity, 'error');
    assert.strictEqual(findings[0].kind, 'app');
    assert.strictEqual(findings[0].targetRef.id, 'app1');
    assert.strictEqual(findings[0].deepLink, '/app/studio/apps/app1');
});

test('an app with nothing wrong produces no rows and no gap — the good news', () => {
    const { findings, gaps } = evaluateAppValidation({
        apps: [{ id: 'app2', name: 'Fine', definition: APP_OK }],
        gaps: [],
    });
    assert.deepStrictEqual(findings, []);
    assert.deepStrictEqual(gaps, [], 'a clean app is CHECKED, not unchecked');
});

test('an app that could not be validated is a GAP, never a clean bill', () => {
    // structuredClone refuses a function, so canonicalize throws — the same
    // path a corrupt definition takes.
    const { findings, gaps } = evaluateAppValidation({
        apps: [{ id: 'app3', name: 'Broken', definition: { onClick() {} } }],
        gaps: [],
    });
    assert.deepStrictEqual(findings, []);
    assert.deepStrictEqual(gaps, ['apps:validator'], 'buildCompleteness named the gap and it travelled');
});

test('a gap the LOADER hit (a budget, an unreadable definition) travels through', () => {
    const { gaps } = evaluateAppValidation({
        apps: [{ id: 'app2', name: 'Fine', definition: APP_OK }],
        gaps: ['apps:budget', 'apps:definition'],
    });
    assert.deepStrictEqual(gaps, ['apps:budget', 'apps:definition']);
});

// ── 3. Empty knowledge bases in use ─────────────────────────────────────────

const kbEntry = (over = {}) => ({
    kb: { id: 'kb1', name: 'Handbook', document_count: 0 },
    usageRows: [{ kind: 'agent', id: 'ag1', role: 'chat' }],
    usagePartial: [],
    ...over,
});

test('an empty base something READS produces completeness.js\'s own finding', () => {
    const { findings, gaps } = evaluateKbEmptyInUse({ candidates: [kbEntry()], gaps: [] });
    assert.deepStrictEqual(gaps, []);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].code, 'knowledge_base.empty_in_use', 'the rule is imported, not rewritten');
    assert.strictEqual(findings[0].severity, 'warning');
    assert.strictEqual(deepLinkFor(findings[0]), '/app/studio/knowledge/kb1');
});

test('an empty base that is only FILED or WRITTEN INTO is not a problem', () => {
    const filed = kbEntry({ usageRows: [{ kind: 'project', role: 'contains' }] });
    const written = kbEntry({ usageRows: [{ kind: 'support', role: 'ingest_target' }] });
    assert.deepStrictEqual(evaluateKbEmptyInUse({ candidates: [filed, written] }).findings, []);
    assert.deepStrictEqual(evaluateKbEmptyInUse({ candidates: [filed, written] }).gaps, []);
    assert.ok(!KB_READ_ROLES.includes('contains') && !KB_READ_ROLES.includes('ingest_target'));
});

test('a base with documents is never reported, whatever reads it', () => {
    const full = kbEntry({ kb: { id: 'kb1', name: 'Handbook', document_count: 12 } });
    assert.deepStrictEqual(evaluateKbEmptyInUse({ candidates: [full] }), { findings: [], gaps: [] });
});

test('an unknown DOCUMENT COUNT is a gap — a base nobody counted is not empty', () => {
    const unknown = kbEntry({ kb: { id: 'kb1', name: 'Handbook' } });
    const { findings, gaps } = evaluateKbEmptyInUse({ candidates: [unknown] });
    assert.deepStrictEqual(findings, []);
    assert.deepStrictEqual(gaps, ['knowledge:documentCount']);
});

test('a PARTIAL usage scan that found no reader is a gap, not "nothing uses it"', () => {
    const { findings, gaps } = evaluateKbEmptyInUse({
        candidates: [kbEntry({ usageRows: [], usagePartial: ['app'] })],
    });
    assert.deepStrictEqual(findings, []);
    assert.deepStrictEqual(gaps, ['knowledge:usage']);
});

test('a partial scan that DID find a reader needs no gap — more usage cannot unsay it', () => {
    const { findings, gaps } = evaluateKbEmptyInUse({
        candidates: [kbEntry({ usagePartial: ['app'] })],
    });
    assert.strictEqual(findings.length, 1);
    assert.deepStrictEqual(gaps, []);
});

test('a complete scan that found nothing is silent — no row, no gap', () => {
    const { findings, gaps } = evaluateKbEmptyInUse({
        candidates: [kbEntry({ usageRows: [], usagePartial: [] })],
    });
    assert.deepStrictEqual(findings, []);
    assert.deepStrictEqual(gaps, []);
});

// ── 4. Failing automations: the deep link of a finding ──────────────────────

const runRow = (/** @type {string} */ id, /** @type {string} */ status, title = 'Invoice reminder') => ({ automationId: id, title, status });

test('three failures in a row is a finding; two is not', () => {
    const { findings, gaps } = evaluateAutomationFailing({
        runs: [
            runRow('a1', 'error'), runRow('a1', 'error'), runRow('a1', 'error'),
            runRow('a2', 'error', 'Weekly digest'), runRow('a2', 'error', 'Weekly digest'),
        ],
    });
    assert.deepStrictEqual(gaps, []);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].code, 'automation.consecutive_failures');
    assert.strictEqual(findings[0].severity, 'error');
    assert.strictEqual(findings[0].targetRef.id, 'a1');
    assert.strictEqual(deepLinkFor(findings[0]), '/app/studio/automations/a1');
    assert.match(findings[0].message, /failed its last 3 runs in a row/);
    assert.strictEqual(MIN_FAILURE_STREAK, 3);
});
