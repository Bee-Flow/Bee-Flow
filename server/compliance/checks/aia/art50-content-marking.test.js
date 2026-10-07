/**
 * AIA-Art50-content-marking — subjects from the automation graph, verdict from
 * the org switch, warn→fail around the 2 Dec 2026 transition end.
 * Run: node --test --test-force-exit server/compliance/checks/aia/art50-content-marking.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const state = {
    settings: { ai_content_marking_enabled: false },
    generating: [],
    listCalls: [],
};
const complianceStore = { getSettings: async (orgId) => { state.lastOrg = orgId; return state.settings; } };
const signals = { listGeneratingAutomations: async (orgId) => { state.listCalls.push(orgId); return state.generating; } };

const restore = installResolveStub({
    '../../../stores/complianceStore': complianceStore,
    '../../aiAct/signals': signals,
});
const check = require('./art50-content-marking');
after(() => restore());

const BEFORE = new Date('2026-09-14T12:00:00Z');   // 79 days before the deadline
const EVE = new Date('2026-12-01T12:00:00Z');
const AFTER = new Date('2026-12-02T00:00:00Z');
const LATER = new Date('2027-03-01T00:00:00Z');

test('shape: id, article 50(2), high, per-source, automated, settings deep link, key names', () => {
    assert.strictEqual(check.id, 'AIA-Art50-content-marking');
    assert.strictEqual(check.regulation, 'AIA');
    assert.strictEqual(check.article, '50(2)');
    assert.strictEqual(check.severity, 'high');
    assert.strictEqual(check.scope, 'per-source');
    assert.strictEqual(check.verification, 'automated');
    assert.strictEqual(check.remediationLink, 'admin/compliance/settings');
    assert.strictEqual(typeof check.listSubjects, 'function');
    assert.deepStrictEqual(
        [check.titleKey, check.descriptionKey, check.remediationKey],
        ['compliance.check_aia_art50_marking_title', 'compliance.check_aia_art50_marking_desc', 'compliance.check_aia_art50_marking_fix'],
    );
    assert.match(check.id, /^AIA-Art[\w()-]+-[\w()-]+$/);
});

test('the deadline comes from the catalogue milestone aia_marking_transition_end = 2026-12-02', () => {
    assert.strictEqual(check._test.deadline().toISOString(), '2026-12-02T00:00:00.000Z');
    assert.strictEqual(check._test.daysUntil(check._test.deadline(), BEFORE), 79);
    assert.strictEqual(check._test.daysUntil(check._test.deadline(), EVE), 1);
    assert.strictEqual(check._test.daysUntil(check._test.deadline(), AFTER), 0);
    assert.ok(check._test.daysUntil(check._test.deadline(), LATER) < 0);
});

test('listSubjects: one subject per automation with an AI-fed document, label = title, no owner data', async () => {
    state.generating = [
        { id: 'au-1', title: 'Offerte-brieven', is_active: true, is_draft: false, aiStepIds: ['ai_1'], generating: [{ id: 'doc', label: 'Brief', signal: 'reference', aiStepIds: ['ai_1'] }], user_id: 'u-owner' },
        { id: 'au-2', title: null, is_active: false, is_draft: true, aiStepIds: ['ai_x'], generating: [{ id: 'd', label: '', signal: 'downstream', aiStepIds: ['ai_x'] }] },
    ];
    const subjects = await check.listSubjects('org-1');
    assert.deepStrictEqual(state.listCalls, ['org-1']);
    assert.deepStrictEqual(subjects.map(s => [s.id, s.label, s.is_active, s.is_draft]), [['au-1', 'Offerte-brieven', true, false], ['au-2', 'au-2', false, true]]);
    for (const s of subjects) {
        assert.ok(!('user_id' in s));
        assert.deepStrictEqual(Object.keys(s).sort(), ['aiStepIds', 'generating', 'id', 'is_active', 'is_draft', 'label']);
    }
    state.generating = [];
    assert.deepStrictEqual(await check.listSubjects('org-1'), [], 'no generating automations → no subjects (runner records not_applicable)');
});

const SUBJECT = { id: 'au-1', label: 'Offerte-brieven', is_active: true, is_draft: false, aiStepIds: ['ai_1'], generating: [{ id: 'doc', label: 'Brief', signal: 'reference', aiStepIds: ['ai_1'] }] };

test('marking on → pass for every subject, evidence carries the graph facts', async () => {
    state.settings = { ai_content_marking_enabled: true };
    const r = await check.evaluate('org-1', SUBJECT, { now: LATER });
    assert.strictEqual(r.status, 'pass');
    assert.strictEqual(state.lastOrg, 'org-1');
    assert.strictEqual(r.evidence.marking_enabled, true);
    assert.strictEqual(r.evidence.automation_id, 'au-1');
    assert.deepStrictEqual(r.evidence.generating_steps, [{ id: 'doc', signal: 'reference', ai_step_ids: ['ai_1'] }]);
    assert.deepStrictEqual(r.evidence.ai_step_ids, ['ai_1']);
    assert.strictEqual(r.evidence.required_from, '2026-12-02');
    assert.match(r.details, /Art\. 50\(2\)/);
    assert.ok(!JSON.stringify(r.evidence).includes('Offerte'), 'evidence carries ids, not the title');
});

test('marking off before 2 Dec 2026 → warn: Art. 50(2) applies, the transition ends 2 Dec 2026 (in N days)', async () => {
    state.settings = { ai_content_marking_enabled: false };
    const r = await check.evaluate('org-1', SUBJECT, { now: BEFORE });
    assert.strictEqual(r.status, 'warn');
    assert.match(r.details, /has applied since 2 Aug 2026/);
    assert.match(r.details, /ends on 2 Dec 2026 \(in 79 days\)/);
    assert.strictEqual(r.evidence.days_until_required, 79);
    const eve = await check.evaluate('org-1', SUBJECT, { now: EVE });
    assert.strictEqual(eve.status, 'warn');
    assert.match(eve.details, /\(in 1 day\)/);
});

test('marking off from 2 Dec 2026 → fail', async () => {
    state.settings = { ai_content_marking_enabled: false };
    for (const now of [AFTER, LATER]) {
        const r = await check.evaluate('org-1', SUBJECT, { now });
        assert.strictEqual(r.status, 'fail', now.toISOString());
        assert.match(r.details, /required since 2 Dec 2026/);
        assert.ok(r.evidence.days_until_required <= 0);
    }
    // A settings row without the column reads as off.
    state.settings = {};
    assert.strictEqual((await check.evaluate('org-1', SUBJECT, { now: LATER })).status, 'fail');
});
