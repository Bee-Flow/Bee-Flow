/**
 * Data Act Art. 30(3) formats: relevance gate, nothing held / nothing covered
 * → n/a, a covered kind with only pdf/html → warn naming it, all
 * machine-readable → pass (render-only kinds mentioned, not failed), evidence
 * without personal data.
 *
 * Run: cd server && node --test --test-force-exit compliance/checks/data-act/art30-machine-readable-formats.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const state = { settings: {}, matrix: [] };
const MACHINE_READABLE_FORMATS = ['json', 'ndjson', 'csv', 'xlsx', 'xml', 'zip', 'md', 'docx'];
const fakeComplianceStore = { async getSettings() { return state.settings; } };
const fakeRegistry = {
    MACHINE_READABLE_FORMATS,
    async coverageMatrix() { return state.matrix; },
};
const restore = installResolveStub({
    '../../../stores/complianceStore': fakeComplianceStore,
    '../../dataPortability/exportRegistry': fakeRegistry,
});
const check = require('./art30-machine-readable-formats');
test.after(() => restore());

const row = (kind, held, formats, over = {}) => ({
    kind, held, route: { method: 'GET', path: `/api/${kind}/:id/export` }, render_only: null,
    formats, scope: 'per-item', mounted: true, ...over,
});

test.beforeEach(() => { state.settings = { framework_relevance: {} }; state.matrix = []; });

test('module shape', () => {
    assert.equal(check.id, 'DATA_ACT-Art30-machine-readable-formats');
    assert.equal(check.regulation, 'DATA_ACT');
    assert.equal(check.severity, 'medium');
    assert.equal(check.verification, 'automated');
    assert.deepEqual(check.frameworks, [{ regulation: 'GDPR', ref: 'Art. 20' }]);
    assert.equal(check.remediationLink, 'admin/compliance/portability');
    assert.equal(check.titleKey, 'compliance.check_data_act_formats_title');
});

test('relevance gate', async () => {
    state.settings = { framework_relevance: { data_act: 'not_relevant' } };
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
});

test('nothing held → not_applicable; held but nothing covered → not_applicable pointing at the coverage check', async () => {
    state.matrix = [row('automations', 0, ['json'])];
    let r = await check.evaluate('org-1');
    assert.equal(r.status, 'not_applicable');
    assert.match(r.details, /no exportable data yet/);
    state.matrix = [row('agents', 4, [], { route: null, mounted: false }), row('datatables', 2, ['csv'], { mounted: false })];
    r = await check.evaluate('org-1');
    assert.equal(r.status, 'not_applicable');
    assert.match(r.details, /see the export-coverage check/);
    assert.equal(r.evidence.covered_kinds, 0);
});

test('a covered kind whose only formats render (pdf/html) → warn, named with its formats', async () => {
    state.matrix = [
        row('automations', 3, ['json']),
        row('notebooks', 2, ['pdf']),
        row('reports', 1, ['html', 'pdf']),
        row('empty', 1, []),
    ];
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.flagged, ['notebooks', 'reports', 'empty']);
    assert.match(r.details, /3 of 4 export route\(s\) only produce a rendered format/);
    assert.match(r.details, /notebooks \(pdf\), reports \(html\/pdf\), empty \(no format declared\)/);
});

test('every covered kind offers a machine-readable format → pass; render-only kinds are mentioned, not failed', async () => {
    state.matrix = [
        row('automations', 3, ['json']),
        row('notebooks', 2, ['docx', 'pdf']),
        row('cms_sites', 1, ['zip', 'json'], { scope: 'bulk' }),
        row('ai_webpages', 5, [], { route: null, mounted: false, render_only: { method: 'POST', path: '/api/webpages/:id/export/pdf', formats: ['pdf'] } }),
        row('agents', 0, [], { route: null, mounted: false }),
    ];
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.covered_kinds, 3);
    assert.deepEqual(r.evidence.flagged, []);
    assert.deepEqual(r.evidence.render_only, [{ kind: 'ai_webpages', held: 5, formats: ['pdf'] }]);
    assert.deepEqual(r.evidence.kinds.find(k => k.kind === 'notebooks').machine_readable, ['docx']);
    assert.match(r.details, /All 3 export route\(s\)/);
    assert.match(r.details, /ai_webpages currently only render \(pdf\)/);
    assert.deepEqual(r.evidence.machine_readable_formats, MACHINE_READABLE_FORMATS);
});

test('evidence has no personal data', async () => {
    state.matrix = [row('automations', 3, ['json']), row('notebooks', 2, ['pdf'])];
    const r = await check.evaluate('org-1');
    assert.ok(!/@/.test(JSON.stringify(r)));
});
