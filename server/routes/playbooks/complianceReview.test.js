// @typecheck
const { test } = require('node:test');
const assert = require('node:assert');
const { makeRunComplianceReview } = require('./complianceReview');

test('the review counts the app\'s public links from studio_app_public_pages', async () => {
    let facts = null;
    const d = {
        now: () => Date.parse('2026-10-01T10:00:00Z'),
        playbookStore: { savePhases: async () => ({ ok: true, version: 2 }) },
        studioAppStore: {
            getStudioApp: async () => ({ id: 'app1', userId: 'me', name: 'App', isPublished: true }),
            listPublicPages: async (appId) => (appId === 'app1' ? [{ id: 't1' }, { id: 't2' }] : []),
        },
        studioAppDataStore: { getDataModel: async () => null, listMembers: async () => [] },
        frameworkPolicy: { activeRegulations: async () => new Set() },
        complianceFrameworks: {},
        enrichComplianceFacts: async () => null,
        gatherFacts: (f) => { facts = f; return f; },
        runCompliancePhase: async () => ({ summary: 'ok', artifacts: { findings: [] } }),
    };
    const flow = {
        phaseTier: async () => 'standard',
        savePhaseOutcome: async () => ({ ok: true, playbook: {} }),
    };
    const run = makeRunComplianceReview({ d, flow });
    const pb = {
        id: 'pb1', userId: 'me', version: 1,
        phases: [
            { key: 'app', kind: 'app', status: 'done', artifacts: { appId: 'app1' } },
            { key: 'compliance', kind: 'compliance', status: 'ready' },
        ],
    };
    const res = { json() {}, status() { return this; } };
    await run({ body: {} }, res, pb, 'compliance');
    assert.ok(facts && facts.app, 'the review read the app');
    assert.strictEqual(facts.app.publicPages, 2);
});
