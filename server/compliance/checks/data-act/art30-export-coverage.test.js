/**
 * Data Act Art. 30 export coverage: relevance gate, nothing held → n/a, counts
 * unavailable → warn "not provisioned yet", a held kind without a (mounted)
 * route → fail naming it, per-item-only above the threshold → warn, all
 * covered → pass. Evidence is the matrix and carries no personal data.
 *
 * Run: cd server && node --test --test-force-exit compliance/checks/data-act/art30-export-coverage.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const state = { settings: {}, matrix: [] };
const fakeComplianceStore = { async getSettings() { return state.settings; } };
const fakeRegistry = {
    async coverageMatrix(orgId) {
        assert.equal(orgId, 'org-1', 'the matrix is built for the org under evaluation');
        return state.matrix;
    },
};
const restore = installResolveStub({
    '../../../stores/complianceStore': fakeComplianceStore,
    '../../dataPortability/exportRegistry': fakeRegistry,
});
const check = require('./art30-export-coverage');
test.after(() => restore());

const row = (kind, held, over = {}) => ({
    kind, label_key: `compliance.pf_kind_${kind}`, held, held_scope: 'org',
    route: { method: 'GET', path: `/api/${kind}/:id/export` }, extra_routes: [], render_only: null,
    formats: ['json'], scope: 'per-item', mounted: true, gap_key: null, ...over,
});
const gap = (kind, held) => row(kind, held, { route: null, formats: [], mounted: false, scope: 'bulk', gap_key: `compliance.pf_gap_${kind}` });

test.beforeEach(() => { state.settings = { framework_relevance: {} }; state.matrix = []; });

test('module shape', () => {
    assert.equal(check.id, 'DATA_ACT-Art30-export-coverage');
    assert.equal(check.regulation, 'DATA_ACT');
    assert.equal(check.article, '30');
    assert.equal(check.severity, 'high');
    assert.equal(check.scope, 'global');
    assert.equal(check.verification, 'automated');
    assert.deepEqual(check.frameworks, [{ regulation: 'DORA', ref: 'Art. 28(8)' }, { regulation: 'GDPR', ref: 'Art. 20' }]);
    assert.equal(check.remediationLink, 'admin/compliance/portability');
    assert.equal(check.titleKey, 'compliance.check_data_act_export_coverage_title');
    assert.equal(check.descriptionKey, 'compliance.check_data_act_export_coverage_desc');
    assert.equal(check.remediationKey, 'compliance.check_data_act_export_coverage_fix');
});

test('relevance gate: framework_relevance.data_act = not_relevant → not_applicable (also when stored as a JSON string)', async () => {
    state.settings = { framework_relevance: { data_act: 'not_relevant' } };
    let r = await check.evaluate('org-1');
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
    state.settings = { framework_relevance: JSON.stringify({ data_act: 'not_relevant' }) };
    r = await check.evaluate('org-1');
    assert.equal(r.status, 'not_applicable');
});

test('nothing held → not_applicable; counts entirely unavailable → warn "not provisioned yet"', async () => {
    state.matrix = [row('automations', 0), gap('agents', 0)];
    let r = await check.evaluate('org-1');
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.kinds_held, 0);
    state.matrix = [row('automations', null), gap('agents', null)];
    r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not provisioned yet/);
    assert.deepEqual(r.evidence.kinds_unknown, ['automations', 'agents']);
});

test('a held kind without any export route → fail, named as a product gap', async () => {
    state.matrix = [row('automations', 3), gap('agents', 2), gap('conversations', 0), gap('knowledge_bases', 1)];
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.uncovered, ['agents', 'knowledge_bases']);
    assert.deepEqual(r.evidence.product_gaps, ['agents', 'knowledge_bases']);
    assert.deepEqual(r.evidence.unmounted_routes, []);
    assert.match(r.details, /2 of 3 held data kind\(s\) cannot be exported/);
    assert.match(r.details, /no export endpoint exists for agents, knowledge_bases \(product gap\)/);
    // Art. 30(1) is IaaS functional equivalence; porting all exportable data is Art. 23(c) / 25(2)(a),(e).
    assert.match(r.details, /Art\. 23\(c\) and Art\. 25\(2\)\(a\),\(e\) require all exportable data/);
    assert.doesNotMatch(r.details, /Art\. 30 requires/);
    assert.ok(!/conversations/.test(r.details), 'a gap kind with nothing held is not a failure');
});

test('a declared route that is NOT mounted → fail, reported separately from product gaps', async () => {
    state.matrix = [row('automations', 3), row('datatables', 2, { mounted: false })];
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.unmounted_routes, ['datatables']);
    assert.deepEqual(r.evidence.product_gaps, []);
    assert.match(r.details, /declared export route is not mounted for datatables/);
});

test('all covered but a per-item route serves more than 50 items → warn', async () => {
    state.matrix = [row('automations', 51), row('datatables', 200, { scope: 'bulk' }), gap('agents', 0)];
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.per_item_heavy, ['automations (51)']);
    assert.match(r.details, /automations \(51\) can only be exported one item at a time/);
});

test('every held kind covered by a mounted route → pass; unknown kinds are mentioned, never treated as 0', async () => {
    state.matrix = [row('automations', 50), row('datatables', 7, { scope: 'bulk' }), gap('agents', 0), row('notebooks', null)];
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'pass');
    assert.match(r.details, /All 2 held data kind\(s\) have a mounted export route/, 'agents at 0 is not held');
    assert.match(r.details, /1 kind\(s\) could not be counted .*notebooks/);
    assert.equal(r.evidence.matrix.length, 4);
    const auto = r.evidence.matrix.find(m => m.kind === 'automations');
    assert.deepEqual(auto, { kind: 'automations', held: 50, route: 'GET /api/automations/:id/export', formats: ['json'], mounted: true, scope: 'per-item', render_only: null, product_gap: false });
});

test('a kind with NO export route whose count failed can never be a pass — it is named as uncountable', async () => {
    // The reviewer's reproduction: automations counted and covered, agents a
    // declared product gap whose count query failed (exportRegistry sets
    // held = null per kind on a failed count). `null` is not 0 — the check
    // must not report full coverage because it could not look.
    state.matrix = [row('automations', 5), gap('agents', null)];
    const r = await check.evaluate('org-1');
    assert.notEqual(r.status, 'pass', '"not looked" is not "nothing to export"');
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.kinds_unknown_uncoverable, ['agents']);
    assert.match(r.details, /agents/, 'the verdict names the kind that could not be counted');
    assert.match(r.details, /could not be counted/);
    assert.match(r.details, /export coverage \(Art\. 23\(c\), 25\(2\)\(e\)\) is not established/);
    assert.deepEqual(r.evidence.uncovered, [], 'nothing is claimed as a proven gap either');
});

test('an unmounted route with a failed count warns too, and an uncovered HELD kind still outranks it with a fail', async () => {
    state.matrix = [row('automations', 5), row('datatables', null, { mounted: false })];
    let r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.kinds_unknown_uncoverable, ['datatables']);

    state.matrix = [row('automations', 5), gap('agents', null), gap('conversations', 3)];
    r = await check.evaluate('org-1');
    assert.equal(r.status, 'fail', 'a kind that is known to be held and uncovered is the worse finding');
    assert.deepEqual(r.evidence.uncovered, ['conversations']);
    assert.deepEqual(r.evidence.kinds_unknown_uncoverable, ['agents'], 'the uncountable kind is still recorded');
});

test('nothing counted as held but an uncountable kind without a route → warn, not "holds no exportable data"', async () => {
    state.matrix = [row('automations', 0), gap('agents', null)];
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /agents/);
    assert.doesNotMatch(r.details, /holds no exportable data/);
});

test('evidence carries counts and route patterns only — no e-mail addresses, no item ids', async () => {
    state.matrix = [row('automations', 3), gap('agents', 2), row('ai_webpages', 4, { route: null, formats: [], mounted: false, render_only: { method: 'POST', path: '/api/webpages/:id/export/pdf', formats: ['pdf'] } })];
    const r = await check.evaluate('org-1');
    const blob = JSON.stringify(r);
    assert.ok(!/@/.test(blob));
    assert.equal(r.evidence.matrix.find(m => m.kind === 'ai_webpages').render_only, 'POST /api/webpages/:id/export/pdf');
});
