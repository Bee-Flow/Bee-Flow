// @typecheck
'use strict';

/**
 * GDPR-Art35-per-user-shield-view: always on, independent of chat signals,
 * never a pass in this release, covers the Privacy Shield, consumption and
 * Adoption per-person views, and an evidence allow-list without people.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art35-per-user-shield-view.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const check = require('./art35-per-user-shield-view');

const deps = (over = {}) => ({ hasCapability: async () => true, guardrailRetentionDays: () => 400, ...over });

test('without advanced_usage_monitoring the views do not exist: not_applicable', async () => {
    const seen = [];
    const r = await check.evaluate('org1', null, deps({ hasCapability: async (cap, opts) => { seen.push([cap, opts.orgId]); return false; } }));
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { reachable: false });
    await check.evaluate('default', null, deps({ hasCapability: async (cap, opts) => { seen.push([cap, opts.orgId]); return false; } }));
    assert.deepEqual(seen, [['advanced_usage_monitoring', 'org1'], ['advanced_usage_monitoring', null]]);
    assert.equal((await check.evaluate('org1', null, deps({ hasCapability: async () => { throw new Error('x'); } }))).status, 'not_applicable');
});

test('with it: warn, whatever chat signals do (it reads no chat signals data)', async () => {
    const r = await check.evaluate('org1', null, deps());
    assert.equal(r.status, 'warn');
    assert.ok(!('chat_signals' in r.evidence));
});

test('the details name every endpoint, the retention and the 2 December 2027 date', async () => {
    const r = await check.evaluate('org1', null, deps());
    for (const s of ['/api/usage/guardrails/overview', 'top_users', '/api/usage/guardrails/recent', '/api/usage/guardrails/by-user', '400 days', '2 December 2027', 'DPIA', 'works-council']) {
        assert.ok(r.details.includes(s), s);
    }
    for (const s of ['/api/usage/users', '/api/usage/by-user', '/api/usage/recent', '/api/usage/adoption/people', '/api/usage/adoption/studio/items', 'topPeople']) {
        assert.ok(r.details.includes(s), s);
    }
    const unlimited = await check.evaluate('org1', null, deps({ guardrailRetentionDays: () => 0 }));
    assert.ok(unlimited.details.includes('no limit'));
});

test('the evidence is the allow-list', async () => {
    const r = await check.evaluate('org1', null, deps());
    assert.deepEqual(r.evidence, {
        reachable: true,
        endpoints: [
            'guardrails.overview.top_users', 'guardrails.recent', 'guardrails.by_user',
            'usage.users', 'usage.by_user', 'usage.recent',
            'adoption.people', 'adoption.studio.items.top_people',
        ],
        guardrail_retention_days: 400,
        adoption_pseudonymous_default: true,
        adoption_reveal_audited: true,
        adoption_reveal_audit_action: 'usage_adoption_people_revealed',
        opt_in_gate: false,
        ai_act_assessment_due: '2027-12-02',
    });
    for (const key of Object.keys(r.evidence)) {
        assert.ok(!/pseudonym|reveal/.test(key) || key.startsWith('adoption_'), `${key} is scoped to the Adoption endpoints`);
    }
    const leaves = Object.values(r.evidence).flat();
    for (const v of leaves) assert.ok(['string', 'number', 'boolean'].includes(typeof v), `evidence leaf ${String(v)} is a scalar`);
});

test('the Adoption report: pseudonymous by default and an audited reveal, still a warn without the opt-in gate', async () => {
    const r = await check.evaluate('org1', null, deps());
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.opt_in_gate, false);
    assert.equal(check.REVEAL_AUDIT_ACTION, 'usage_adoption_people_revealed');
    for (const s of ['Adoption report', 'pseudonymous by default', 'access audit log', 'usage_adoption_people_revealed', 'always pseudonymous']) {
        assert.ok(r.details.includes(s), s);
    }
    assert.ok(Object.isFrozen(check.ENDPOINTS));
});

test('module fields', () => {
    assert.equal(check.id, 'GDPR-Art35-per-user-shield-view');
    assert.equal(check.scope, 'global');
    assert.equal(check.verification, 'hybrid');
    assert.equal(check.severity, 'high');
    assert.equal(check.titleKey, 'chat_monitoring.checks.gdpr_art35_per_user_view.title');
});
