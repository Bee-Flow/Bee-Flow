/**
 * MACHINERY-Art3-industrial-detection — detector → not_applicable | warn.
 * Run: cd server && node --test --test-force-exit compliance/checks/machinery/art3-industrial-detection.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
const fx = { settings: {}, detect: null, calls: [] };
const EMPTY = { scanned: { custom_integrations: 3, automations: 12, connections: 2, activity_hosts: 7, mcp_servers: 1 }, matches: [], skipped: [], heuristics_version: '1.0.0' };

const restore = installResolveStub({
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, ...fx.settings }) },
    '../../detectors/industrialIntegrations': { detect: async (orgId) => { fx.calls.push(orgId); return fx.detect; } },
});
const check = require('./art3-industrial-detection');
test.after(() => restore());

test.beforeEach(() => { fx.settings = {}; fx.detect = EMPTY; fx.calls = []; });

test('contract shape', () => {
    assert.equal(check.id, 'MACHINERY-Art3-industrial-detection');
    assert.equal(check.regulation, 'MACHINERY');
    assert.equal(check.scope, 'global');
    assert.equal(check.verification, 'automated');
    assert.equal(check.remediationLink, 'admin/compliance/machinery');
});

test('relevance override not_relevant → not_applicable without scanning', async () => {
    fx.settings = { framework_relevance: JSON.stringify({ machinery: 'not_relevant' }) };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
    assert.equal(fx.calls.length, 0);
});

test('no matches → not_applicable with the scanned counts and derived relevance', async () => {
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence.scanned, EMPTY.scanned);
    assert.equal(r.evidence.match_count, 0);
    assert.equal(r.evidence.derived_relevance, 'not_detected');
    assert.equal(r.evidence.heuristics_version, '1.0.0');
    assert.match(r.details, /No industrial integrations detected across 25 scanned/);
    assert.deepEqual(fx.calls, [ORG]);
});

test('skipped sources are named so 0 matches is not mistaken for a full scan', async () => {
    fx.detect = { ...EMPTY, skipped: [{ source: 'mcp_servers', reason: 'not provisioned' }] };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.match(r.details, /not provisioned on this deployment \(mcp_servers\)/);
});

test('matches → warn (never fail) with slimmed matches and confidence split', async () => {
    fx.detect = {
        ...EMPTY,
        matches: [
            { source: 'automation', id: 'a1', label: 'Line 3 PLC poll', confidence: 'high', signals: [{ kind: 'scheme', value: 'opc.tcp://plc.local:4840', label: 'OPC UA' }], active: true },
            { source: 'connection', id: 'c1', label: 'mqtt · broker', confidence: 'low', signals: [{ kind: 'keyword', value: 'mqtt' }] },
        ],
    };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.match_count, 2);
    assert.equal(r.evidence.high_confidence, 1);
    assert.equal(r.evidence.low_confidence, 1);
    assert.equal(r.evidence.derived_relevance, 'relevant');
    assert.equal(r.evidence.matches[0].signals[0].kind, 'scheme');
    assert.equal(r.evidence.matches[0].active, true);
    assert.match(r.details, /Line 3 PLC poll \(high\)/);
});

test('relevance override "relevant" is recorded and still scans', async () => {
    fx.settings = { framework_relevance: { machinery: 'relevant' } };
    const r = await check.evaluate(ORG);
    assert.equal(r.evidence.relevance_override, 'relevant');
    assert.equal(fx.calls.length, 1);
});

test('evidence carries no personal data', async () => {
    fx.settings = { dpo_email: 'dpo@example.org' };
    fx.detect = { ...EMPTY, matches: [{ source: 'automation', id: 'a1', label: 'PLC', confidence: 'high', signals: [{ kind: 'scheme', value: 'modbus://10.0.0.5:502' }] }] };
    const r = await check.evaluate(ORG);
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(JSON.stringify(r.evidence)));
});
