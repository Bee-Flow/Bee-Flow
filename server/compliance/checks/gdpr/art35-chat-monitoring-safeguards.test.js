'use strict';

/**
 * GDPR-Art35-chat-monitoring-safeguards: fails when a precondition lapsed
 * after the save (the route refuses it on the way in), warns ahead of an
 * expiry and on small groups, and never carries the per-person-view sentence.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art35-chat-monitoring-safeguards.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const check = require('./art35-chat-monitoring-safeguards');

const NOW = new Date('2026-10-21T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (n) => new Date(NOW.getTime() - n * DAY);

function settings(over = {}) {
    return {
        chat_monitoring_enabled: true,
        chat_monitoring_surfaces: ['direct', 'agent_public'],
        chat_monitoring_signals: ['outcomes'],
        chat_monitoring_effective_from: '2026-10-01T00:00:00.000Z',
        chat_monitoring_retention_days: 90,
        chat_monitoring_legal_basis: 'art6_1_c',
        chat_monitoring_works_council: 'consent',
        chat_monitoring_works_council_at: '2026-09-01',
        chat_monitoring_works_council_scope: { surfaces: ['direct'], signals: ['outcomes'], max_retention_days: 90 },
        chat_monitoring_notice_url: 'https://intranet.example.org/chat-signals',
        chat_monitoring_notice_published_at: '2026-09-20',
        chat_monitoring_enabled_at: '2026-09-24T10:00:00.000Z',
        ropa_reviewed_at: '2026-09-25T10:00:00.000Z',
        ...over,
    };
}

function deps(over = {}) {
    return {
        getSettings: async () => settings(),
        getDpia: async () => ({ approved_at: ago(100), expires_at: null, risk_level: 'medium' }),
        hasAnyOrganization: async () => true,
        contributorCount: async () => 30,
        probe: async () => ({ ok: true, status: 200 }),
        now: () => NOW,
        ...over,
    };
}
const withSettings = (over, more = {}) => deps({ getSettings: async () => settings(over), ...more });

test('off: not_applicable', async () => {
    const r = await check.evaluate('org1', null, withSettings({ chat_monitoring_enabled: false }));
    assert.equal(r.status, 'not_applicable');
});

test('everything in order: pass', async () => {
    const r = await check.evaluate('org1', null, deps());
    assert.equal(r.status, 'pass', r.details);
    assert.deepEqual(r.evidence.surfaces_active, ['direct', 'agent_public']);
    assert.deepEqual(r.evidence.surfaces_paused, []);
});

test('a paused surface fails with its codes', async () => {
    const r = await check.evaluate('org1', null, deps({ getDpia: async () => ({ approved_at: ago(400), expires_at: null }) }));
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.surfaces_paused, [{ id: 'direct', missing: ['dpia_expired'] }]);
    assert.ok(r.details.includes('dpia_expired'));
    assert.ok(r.details.includes('changed afterwards'));
    const none = await check.evaluate('org1', null, deps({ getDpia: async () => null }));
    assert.deepEqual(none.evidence.surfaces_paused, [{ id: 'direct', missing: ['dpia_missing'] }]);
});

test('works_council_scope_exceeded fails', async () => {
    const r = await check.evaluate('org1', null, withSettings({ chat_monitoring_signals: ['outcomes', 'kinds'] }));
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.surfaces_paused, [{ id: 'direct', missing: ['works_council_scope_exceeded'] }]);
    assert.equal(r.evidence.works_council_scope_ok, false);
});

test('a high-risk DPIA without the prior consultation fails; so does a missing DPO advice', async () => {
    const high = await check.evaluate('org1', null, deps({ getDpia: async () => ({ approved_at: ago(10), risk_level: 'high' }) }));
    assert.equal(high.status, 'fail');
    assert.deepEqual(high.evidence.surfaces_paused[0].missing, ['prior_consultation_missing']);
    assert.equal(high.evidence.prior_consultation, false);

    const dpo = await check.evaluate('org1', null, withSettings({ dpo_email: 'dpo@example.org' }));
    assert.equal(dpo.status, 'fail');
    assert.deepEqual(dpo.evidence.surfaces_paused[0].missing, ['dpo_advice_missing']);
    assert.equal(dpo.evidence.dpo_advice, false);
    assert.ok(!JSON.stringify(dpo.evidence).includes('dpo@example.org'));
});

test('a global code (legal basis gone) fails for all chat types', async () => {
    const r = await check.evaluate('org1', null, withSettings({ chat_monitoring_legal_basis: null }));
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.missing, ['legal_basis']);
});

test('a DPIA expiring in under 30 days warns, including a null expiry at day 340', async () => {
    const r = await check.evaluate('org1', null, deps({ getDpia: async () => ({ approved_at: ago(340), expires_at: null, risk_level: 'low' }) }));
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.dpia_expires_in_days, 25);
    assert.ok(r.details.includes('expires in 25 days'));
    const ext = await check.evaluate('org1', null, deps({
        getDpia: async () => null,
        getSettings: async () => settings({ chat_monitoring_dpia_ref: 'D-1', chat_monitoring_dpia_at: '2025-11-20', chat_monitoring_dpia_risk_level: 'low' }),
    }));
    assert.equal(ext.status, 'warn', 'an external DPIA older than 335 days');
    assert.equal(ext.evidence.dpia, 'external');
});

test('an unreachable notice warns; an intranet notice (private_host) is "not checked"', async () => {
    const down = await check.evaluate('org1', null, deps({ probe: async () => ({ ok: false, status: 404 }) }));
    assert.equal(down.status, 'warn');
    assert.equal(down.evidence.notice_reachable, false);
    const intranet = await check.evaluate('org1', null, deps({ probe: async () => ({ ok: false, error: 'private_host' }) }));
    assert.equal(intranet.status, 'pass');
    assert.equal(intranet.evidence.notice_reachable, null);
});

test('a processing register not reviewed since chat signals were switched on warns', async () => {
    const r = await check.evaluate('org1', null, withSettings({ ropa_reviewed_at: '2026-09-01T00:00:00.000Z' }));
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.ropa_reviewed_since_enabled, false);
    assert.equal((await check.evaluate('org1', null, withSettings({ ropa_reviewed_at: null }))).status, 'warn');
});

test('small groups warn: fewer than 5 people, or fewer than 10 with kinds of data', async () => {
    const four = await check.evaluate('org1', null, deps({ contributorCount: async () => 4 }));
    assert.equal(four.status, 'warn');
    assert.deepEqual(four.evidence.small_groups, ['direct']);
    assert.ok(four.details.includes('enterprise headcount'));
    const kinds = await check.evaluate('org1', null, deps({
        contributorCount: async () => 9,
        getSettings: async () => settings({ chat_monitoring_signals: ['outcomes', 'kinds'], chat_monitoring_works_council_scope: { surfaces: ['direct'], signals: ['outcomes', 'kinds'], max_retention_days: 90 } }),
    }));
    assert.deepEqual(kinds.evidence.small_groups, ['direct']);
});

test('the details never carry the per-person-view sentence (amendment 25), and evidence is enums, dates and booleans', async () => {
    for (const d of [deps(), deps({ contributorCount: async () => 2 }), deps({ getDpia: async () => null })]) {
        const r = await check.evaluate('org1', null, d);
        assert.doesNotMatch(r.details, /guardrails|top_users|per-person|per person/i);
        const json = JSON.stringify(r.evidence);
        assert.ok(!json.includes('intranet.example.org'), 'no URL text');
        assert.ok(!/"[a-z_]*_id"/.test(json), 'no ids');
    }
});
