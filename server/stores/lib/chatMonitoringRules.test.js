'use strict';

/**
 * Chat signals preconditions: one case per code, the DPIA rules of amendment
 * 14, the works-council scope of amendment 13 and the change classification
 * the route authorises on.
 *
 * Run: cd server && node --test stores/lib/chatMonitoringRules.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const R = require('./chatMonitoringRules');

const NOW = new Date('2026-10-07T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY);
const day = (d) => d.toISOString().slice(0, 10);

/** A configuration with every precondition met, employee and visitor surfaces on. */
function good(over = {}) {
    return {
        chat_monitoring_enabled: true,
        chat_monitoring_surfaces: ['direct', 'agent', 'agent_public'],
        chat_monitoring_signals: ['outcomes', 'kinds'],
        chat_monitoring_effective_from: '2026-10-14T12:00:00.000Z',
        chat_monitoring_retention_days: 90,
        chat_monitoring_legal_basis: 'art6_1_e',
        chat_monitoring_lia_at: null,
        chat_monitoring_works_council: 'consent',
        chat_monitoring_works_council_reason: null,
        chat_monitoring_works_council_at: '2026-09-01',
        chat_monitoring_works_council_scope: { surfaces: ['direct', 'agent'], signals: ['outcomes', 'kinds'], max_retention_days: 90 },
        chat_monitoring_dpia_ref: null,
        chat_monitoring_dpia_at: null,
        chat_monitoring_dpia_risk_level: null,
        chat_monitoring_dpo_advice_at: null,
        chat_monitoring_prior_consultation_at: null,
        chat_monitoring_notice_url: 'https://intranet.example.org/privacy/chat-signals',
        chat_monitoring_notice_published_at: '2026-10-01',
        dpo_name: null,
        dpo_email: null,
        privacy_notice_url: null,
        ...over,
    };
}
const DPIA = { approved_at: daysAgo(10), expires_at: null, risk_level: 'medium' };
const ctx = (over = {}) => ({ dpiaRow: DPIA, now: NOW, installHasOrganisations: true, orgKey: 'org1', ...over });
const codes = (settings, c = ctx()) => R.allCodes(R.evaluate(settings, c));

test('a configuration with every precondition met has no codes', () => {
    assert.deepEqual(R.evaluate(good(), ctx()), { global: [], bySurface: { direct: [], agent: [], agent_public: [] } });
});

test('global codes: surfaces, signals, legal basis, LIA, retention', () => {
    assert.deepEqual(R.evaluate(good({ chat_monitoring_surfaces: [] }), ctx()).global, ['surfaces_required']);
    assert.ok(codes(good({ chat_monitoring_surfaces: ['direct', 'notebook'] })).includes('surface_not_available'));
    assert.ok(codes(good({ chat_monitoring_surfaces: ['project_chat'] })).includes('surface_not_available'));
    assert.ok(codes(good({ chat_monitoring_signals: ['kinds'] })).includes('outcomes_required'));
    assert.ok(codes(good({ chat_monitoring_signals: ['outcomes', 'special_kinds'] })).includes('signal_not_available'));
    assert.ok(codes(good({ chat_monitoring_legal_basis: null })).includes('legal_basis'));
    assert.ok(codes(good({ chat_monitoring_legal_basis: 'consent' })).includes('legal_basis'));
    assert.ok(codes(good({ chat_monitoring_legal_basis: 'art6_1_f' })).includes('lia_documented'));
    assert.ok(!codes(good({ chat_monitoring_legal_basis: 'art6_1_f', chat_monitoring_lia_at: daysAgo(1) })).includes('lia_documented'));
    for (const r of [29, 91, 365]) assert.ok(codes(good({ chat_monitoring_retention_days: r })).includes('retention_days'), String(r));
    assert.ok(!codes(good({ chat_monitoring_retention_days: null })).includes('retention_days'), 'null reads 90');
});

test('DPIA: none, expired, and a null expires_at counts as approved_at + 365 days (amendment 14)', () => {
    assert.ok(codes(good(), ctx({ dpiaRow: null })).includes('dpia'));
    assert.ok(codes(good(), ctx({ dpiaRow: { approved_at: daysAgo(400), expires_at: null } })).includes('dpia'));
    assert.ok(!codes(good(), ctx({ dpiaRow: { approved_at: daysAgo(364), expires_at: null } })).includes('dpia'));
    assert.ok(codes(good(), ctx({ dpiaRow: { approved_at: daysAgo(20), expires_at: daysAgo(1) } })).includes('dpia'));
    const st = R.dpiaStatus({}, { approved_at: daysAgo(10), expires_at: null, risk_level: 'high' }, NOW);
    assert.equal(st.kind, 'internal');
    assert.equal(st.current, true);
    assert.equal(st.expiresAt.getTime(), daysAgo(10).getTime() + 365 * DAY);
    assert.equal(st.riskLevel, 'high');
});

test('DPIA: an external reference needs a date within the year, not in the future, and a risk level', () => {
    const ext = { chat_monitoring_dpia_ref: 'DPIA-2026-07', chat_monitoring_dpia_at: day(daysAgo(30)), chat_monitoring_dpia_risk_level: 'low' };
    assert.deepEqual(codes(good(ext), ctx({ dpiaRow: null })), []);
    assert.ok(codes(good({ ...ext, chat_monitoring_dpia_risk_level: null }), ctx({ dpiaRow: null })).includes('dpia_risk_level'));
    assert.ok(codes(good({ ...ext, chat_monitoring_dpia_at: day(daysAgo(366)) }), ctx({ dpiaRow: null })).includes('dpia'));
    assert.ok(codes(good({ ...ext, chat_monitoring_dpia_at: day(daysAgo(-3)) }), ctx({ dpiaRow: null })).includes('dpia'));
    // The internal record wins when both exist.
    assert.equal(R.dpiaStatus(good(ext), DPIA, NOW).kind, 'internal');
});

test('a high-risk DPIA needs the prior consultation, and a recorded DPO their advice', () => {
    const high = ctx({ dpiaRow: { ...DPIA, risk_level: 'high' } });
    assert.ok(codes(good(), high).includes('prior_consultation_at'));
    assert.ok(codes(good({ chat_monitoring_prior_consultation_at: day(daysAgo(-2)) }), high).includes('prior_consultation_at'), 'not in the future');
    assert.ok(!codes(good({ chat_monitoring_prior_consultation_at: day(daysAgo(2)) }), high).includes('prior_consultation_at'));

    assert.ok(codes(good({ dpo_email: 'dpo@example.org' })).includes('dpo_advice_at'));
    assert.ok(codes(good({ dpo_name: 'A. DPO', chat_monitoring_dpo_advice_at: day(daysAgo(-1)) })).includes('dpo_advice_at'));
    assert.ok(!codes(good({ dpo_name: 'A. DPO', chat_monitoring_dpo_advice_at: day(daysAgo(1)) })).includes('dpo_advice_at'));
});

test('works council: pending blocks employee surfaces only; not_applicable needs a reason; consent a date', () => {
    const pending = R.evaluate(good({ chat_monitoring_works_council: 'pending' }), ctx());
    assert.deepEqual(pending.global, []);
    assert.ok(pending.bySurface.direct.includes('works_council'));
    assert.ok(pending.bySurface.agent.includes('works_council'));
    assert.deepEqual(pending.bySurface.agent_public, [], 'website visitors are not paused by the works council');
    assert.ok(codes(good({ chat_monitoring_works_council: null })).includes('works_council'));

    assert.ok(codes(good({ chat_monitoring_works_council: 'not_applicable' })).includes('works_council_reason'));
    assert.deepEqual(codes(good({ chat_monitoring_works_council: 'not_applicable', chat_monitoring_works_council_reason: 'outside_nl', chat_monitoring_works_council_scope: {} })), [],
        'the scope is not checked for not_applicable');

    assert.ok(codes(good({ chat_monitoring_works_council_at: null })).includes('works_council_at'));
    assert.ok(codes(good({ chat_monitoring_works_council: 'court_replacement', chat_monitoring_works_council_at: day(daysAgo(-5)) })).includes('works_council_at'));
});

test('works council scope: the consent must cover the surfaces, signals and retention counted', () => {
    assert.ok(codes(good({ chat_monitoring_works_council_scope: { surfaces: ['direct'], signals: ['outcomes', 'kinds'], max_retention_days: 90 } })).includes('works_council_scope'));
    assert.ok(codes(good({ chat_monitoring_works_council_scope: { surfaces: ['direct', 'agent'], signals: ['outcomes'], max_retention_days: 90 } })).includes('works_council_scope'));
    assert.ok(codes(good({ chat_monitoring_works_council_scope: { surfaces: ['direct', 'agent'], signals: ['outcomes', 'kinds'], max_retention_days: 60 } })).includes('works_council_scope'));
    assert.ok(R.scopeCovers({ surfaces: ['direct'], signals: ['outcomes'], max_retention_days: 60 }, { surfaces: ['direct'], signals: ['outcomes'], retentionDays: 30 }));
    assert.ok(!R.scopeCovers({}, { surfaces: [], signals: [], retentionDays: 30 }), 'no max retention covers nothing');
});

test('a scope widened without a newer date is refused on save (amendment 13); a newer date passes', () => {
    const before = good();
    const widerScope = { surfaces: ['direct', 'agent'], signals: ['outcomes', 'kinds'], max_retention_days: 90 };
    const narrowBefore = good({ chat_monitoring_works_council_scope: { surfaces: ['direct'], signals: ['outcomes'], max_retention_days: 60 } });
    const change = R.classifyChange(narrowBefore, good({ chat_monitoring_works_council_scope: widerScope }));
    assert.deepEqual(R.putCodes({ change, before: narrowBefore, after: good({ chat_monitoring_works_council_scope: widerScope }), acknowledgements: { notice_published: true, ropa_reviewed: true } }), ['works_council_scope']);
    assert.deepEqual(R.putCodes({
        change, before: narrowBefore,
        after: good({ chat_monitoring_works_council_scope: widerScope, chat_monitoring_works_council_at: '2026-10-05' }),
        acknowledgements: { notice_published: true, ropa_reviewed: true },
    }), []);
    assert.deepEqual(R.putCodes({ change: R.classifyChange(before, before), before, after: before }), [], 'the same scope needs nothing');
});

test('the staff notice: an https URL of at most 500 characters, published on or before the start', () => {
    assert.ok(codes(good({ chat_monitoring_notice_url: null })).includes('notice_url'));
    assert.ok(codes(good({ chat_monitoring_notice_url: 'http://intranet.example.org/n' })).includes('notice_url'));
    assert.ok(codes(good({ chat_monitoring_notice_url: `https://example.org/${'a'.repeat(500)}` })).includes('notice_url'));
    assert.ok(codes(good({ chat_monitoring_notice_published_at: null })).includes('notice_published_at'));
    assert.ok(codes(good({ chat_monitoring_notice_published_at: day(daysAgo(-1)) })).includes('notice_published_at'), 'in the future');
    assert.ok(codes(good({ chat_monitoring_notice_published_at: '2026-10-01', chat_monitoring_effective_from: '2026-09-30T08:00:00.000Z' })).includes('notice_published_at'),
        'published after the start');
});

test('the visitor notice: the staff notice or the privacy notice, https only', () => {
    const visitorOnly = { chat_monitoring_surfaces: ['agent_public'], chat_monitoring_notice_url: null };
    assert.deepEqual(R.evaluate(good(visitorOnly), ctx()).bySurface, { agent_public: ['agent_public_notice'] });
    assert.deepEqual(R.evaluate(good({ ...visitorOnly, privacy_notice_url: 'http://example.org/privacy' }), ctx()).bySurface.agent_public, ['agent_public_notice']);
    assert.deepEqual(R.evaluate(good({ ...visitorOnly, privacy_notice_url: 'https://example.org/privacy' }), ctx()).bySurface.agent_public, []);
    assert.deepEqual(R.evaluate(good(visitorOnly), ctx({ privacyNoticeUrl: 'https://example.org/privacy' })).bySurface.agent_public, []);
});

test('the default bucket counts employees only on an installation without organisations (amendment 18)', () => {
    const withOrgs = R.evaluate(good(), ctx({ orgKey: 'default', installHasOrganisations: true }));
    assert.ok(withOrgs.bySurface.direct.includes('default_bucket_has_orgs'));
    assert.ok(!withOrgs.bySurface.agent_public.includes('default_bucket_has_orgs'));
    assert.deepEqual(R.evaluate(good(), ctx({ orgKey: 'default', installHasOrganisations: false })).bySurface.direct, []);
});

test('classifyChange: switching on, adding, a retention increase and a basis change widen; a removal narrows', () => {
    const off = good({ chat_monitoring_enabled: false });
    const on = good();
    assert.equal(R.classifyChange(off, on).widen, true);
    assert.equal(R.classifyChange(off, on).employeeWidened, true);

    const less = good({ chat_monitoring_retention_days: 60 });
    assert.deepEqual(R.classifyChange(less, on), { widen: true, narrow: false, maintain: false, off: false, employeeWidened: true, visitorOnly: false });
    assert.equal(R.classifyChange(on, less).narrow, true);
    assert.equal(R.classifyChange(on, less).widen, false);

    assert.equal(R.classifyChange(on, good({ chat_monitoring_legal_basis: 'art6_1_c' })).widen, true);
    assert.equal(R.classifyChange(on, good({ chat_monitoring_surfaces: ['direct'] })).narrow, true);
    assert.equal(R.classifyChange(on, good({ chat_monitoring_signals: ['outcomes'] })).narrow, true);

    const maintain = R.classifyChange(on, good({ chat_monitoring_notice_url: 'https://example.org/new', chat_monitoring_works_council_at: '2026-09-15' }));
    assert.deepEqual(maintain, { widen: false, narrow: false, maintain: true, off: false, employeeWidened: false, visitorOnly: false });

    const switchedOff = R.classifyChange(on, off);
    assert.equal(switchedOff.off, true);
    assert.equal(switchedOff.narrow, true);
    assert.equal(switchedOff.widen, false);
    assert.equal(R.changeWord(switchedOff), 'off');

    const narrowAndEdit = R.classifyChange(on, good({ chat_monitoring_surfaces: ['direct'], chat_monitoring_works_council: 'pending' }));
    assert.equal(narrowAndEdit.narrow, true);
    assert.equal(narrowAndEdit.maintain, true, 'a narrow that also edits an attestation is checked like a maintain');
    assert.equal(R.classifyChange(on, good({ chat_monitoring_surfaces: ['direct'] })).maintain, false, 'a pure narrow is not');

    const na = good({ chat_monitoring_works_council: 'not_applicable', chat_monitoring_works_council_reason: 'outside_nl', chat_monitoring_works_council_scope: {} });
    assert.equal(R.classifyChange(na, { ...na, chat_monitoring_works_council_scope: { surfaces: ['direct'], signals: ['outcomes'], max_retention_days: 90 } }).widen, false,
        'a scope means nothing without consent, so changing it widens nothing');
    assert.equal(R.classifyChange(on, good({ chat_monitoring_works_council_scope: { surfaces: ['direct', 'agent'], signals: ['outcomes', 'kinds'], max_retention_days: 60 } })).widen, true,
        'a changed consent scope is re-attested by an org admin');

    const visitor = R.classifyChange(good({ chat_monitoring_surfaces: ['direct'] }), good({ chat_monitoring_surfaces: ['direct', 'agent_public'] }));
    assert.equal(visitor.widen, true);
    assert.equal(visitor.visitorOnly, true);
});

test('planEffectiveFrom: +7 days by default, earlier only acknowledged, never past; visitors at once', () => {
    const before = good({ chat_monitoring_enabled: false, chat_monitoring_effective_from: null });
    const emp = R.classifyChange(before, good());
    const dflt = R.planEffectiveFrom({ change: emp, before, requested: undefined, now: NOW });
    assert.equal(dflt.value, new Date(NOW.getTime() + 7 * DAY).toISOString());
    assert.deepEqual(dflt.codes, []);

    const early = '2026-10-09T08:00:00.000Z';
    assert.deepEqual(R.planEffectiveFrom({ change: emp, before, requested: early, now: NOW }).codes, ['informed_before_start']);
    assert.deepEqual(R.planEffectiveFrom({ change: emp, before, requested: early, acknowledgements: { informed_before_start: true }, now: NOW }), { value: early, codes: [] });
    assert.deepEqual(R.planEffectiveFrom({ change: emp, before, requested: '2026-10-01T00:00:00.000Z', now: NOW }).codes, ['effective_from']);
    assert.deepEqual(R.planEffectiveFrom({ change: emp, before, requested: 'soon', now: NOW }).codes, ['effective_from']);
    assert.deepEqual(R.planEffectiveFrom({ change: emp, before, requested: '2026-10-14T00:00:00.000Z', now: NOW }).codes, [], 'the date seven days on needs nothing');

    const vis = R.classifyChange(good({ chat_monitoring_enabled: false, chat_monitoring_surfaces: ['agent_public'] }), good({ chat_monitoring_surfaces: ['agent_public'] }));
    assert.equal(R.planEffectiveFrom({ change: vis, before, requested: '2026-12-01T00:00:00.000Z', now: NOW }).value, NOW.toISOString());

    const on = good();
    const maint = R.classifyChange(on, good({ chat_monitoring_notice_url: 'https://example.org/x' }));
    assert.equal(R.planEffectiveFrom({ change: maint, before: on, now: NOW }).value, '2026-10-14T12:00:00.000Z');
    assert.equal(R.planEffectiveFrom({ change: R.classifyChange(on, good({ chat_monitoring_enabled: false })), before: on, now: NOW }).value, null);
});

test('planLiaAt: stamped when attested for 6(1)(f), kept while it stays, cleared otherwise', () => {
    const f = good({ chat_monitoring_legal_basis: 'art6_1_f', chat_monitoring_lia_at: '2026-09-01T00:00:00.000Z' });
    assert.equal(R.planLiaAt({ before: good(), basis: 'art6_1_f', acknowledgements: { lia_documented: true }, now: NOW }), NOW.toISOString());
    assert.equal(R.planLiaAt({ before: good(), basis: 'art6_1_f', acknowledgements: {}, now: NOW }), null, 'a change to f needs the attestation');
    assert.equal(R.planLiaAt({ before: f, basis: 'art6_1_f', acknowledgements: {}, now: NOW }), '2026-09-01T00:00:00.000Z');
    assert.equal(R.planLiaAt({ before: f, basis: 'art6_1_c', acknowledgements: { lia_documented: true }, now: NOW }), null);
});

test('a widen needs the notice and RoPA acknowledgements, for website visitors too (amendment 15)', () => {
    const before = good({ chat_monitoring_enabled: false, chat_monitoring_surfaces: ['agent_public'] });
    const after = good({ chat_monitoring_surfaces: ['agent_public'] });
    const change = R.classifyChange(before, after);
    assert.deepEqual(R.putCodes({ change, before, after, acknowledgements: {} }), ['notice_published', 'ropa_reviewed']);
    assert.deepEqual(R.putCodes({ change, before, after, acknowledgements: { notice_published: true, ropa_reviewed: true } }), []);
    const narrow = R.classifyChange(good(), good({ chat_monitoring_surfaces: ['direct'] }));
    assert.deepEqual(R.putCodes({ change: narrow, before: good(), after: good({ chat_monitoring_surfaces: ['direct'] }) }), []);
});

test('every code the rules emit is in the one list', () => {
    const seen = new Set(R.CODES);
    assert.equal(seen.size, R.CODES.length);
    for (const c of ['dpia', 'works_council_scope', 'agent_public_notice', 'informed_before_start']) assert.ok(seen.has(c));
});

test('dayString reads DATE values, timestamps and strings', () => {
    assert.equal(R.dayString('2026-10-01'), '2026-10-01');
    assert.equal(R.dayString('2026-10-01T23:30:00.000Z'), '2026-10-01');
    assert.equal(R.dayString(new Date(2026, 9, 1)), '2026-10-01', 'a DATE is local midnight');
    assert.equal(R.dayString('2026-02-31'), null, 'a date that does not exist');
    assert.equal(R.dayString(null), null);
    assert.equal(R.dayString('nope'), null);
});
