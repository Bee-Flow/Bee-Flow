'use strict';

/**
 * The chat signals resolver: off by default, off without the module or the
 * licence, scheduled before the start, a lapsed precondition pauses its
 * surface (and only that one), any read error is off, and the memo is
 * single-flight and invalidated by the saving route.
 *
 * Run: cd server && node --test core/entitlements/chatMonitoringFlag.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const flag = require('./chatMonitoringFlag');

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const DAY = 86_400_000;

function settings(over = {}) {
    return {
        chat_monitoring_enabled: true,
        chat_monitoring_surfaces: ['direct', 'agent', 'agent_public'],
        chat_monitoring_signals: ['kinds', 'outcomes'],
        chat_monitoring_effective_from: '2026-10-14T09:00:00.000Z',
        chat_monitoring_retention_days: 60,
        chat_monitoring_legal_basis: 'art6_1_c',
        chat_monitoring_works_council: 'not_applicable',
        chat_monitoring_works_council_reason: 'no_works_council',
        chat_monitoring_notice_url: 'https://intranet.example.org/chat-signals',
        chat_monitoring_notice_published_at: '2026-10-01',
        privacy_notice_url: 'https://example.org/privacy',
        ...over,
    };
}

function deps(over = {}) {
    const calls = { settings: 0 };
    const d = {
        isModuleActive: async () => true,
        hasCapability: async () => true,
        getSettings: async () => { calls.settings++; return settings(); },
        getDpia: async () => ({ approved_at: new Date(NOW - 30 * DAY), expires_at: null, risk_level: 'medium' }),
        hasAnyOrganization: async () => true,
        now: () => NOW,
        ...over,
    };
    return { d, calls };
}

test('off by default: no row, or not switched on', async () => {
    const { d } = deps({ getSettings: async () => ({ chat_monitoring_enabled: false }) });
    assert.equal(await flag.makeResolver(d).resolveChatMonitoring('org1'), flag.OFF);
    assert.deepEqual({ ...flag.OFF }, {
        state: 'off', version: null, from: null, surfaces: [], paused: [], signals: [],
        noticeUrl: null, visitorNoticeUrl: null, retentionDays: 90,
    });
});

test('on: every surface, outcomes first, the version and the notice links', async () => {
    const { d } = deps();
    const mon = await flag.makeResolver(d).resolveChatMonitoring('org1');
    assert.deepEqual({ ...mon, surfaces: [...mon.surfaces], signals: [...mon.signals], paused: [...mon.paused] }, {
        state: 'on',
        version: '2026-10-14T09:00:00.000Z',
        from: '2026-10-14',
        surfaces: ['direct', 'agent', 'agent_public'],
        paused: [],
        signals: ['outcomes', 'kinds'],
        noticeUrl: 'https://intranet.example.org/chat-signals',
        visitorNoticeUrl: 'https://intranet.example.org/chat-signals',
        retentionDays: 60,
    });
});

test('an inactive module or a lapsed licence reads off, with the org passed for the capability', async () => {
    assert.equal(await flag.makeResolver(deps({ isModuleActive: async () => false }).d).resolveChatMonitoring('org1'), flag.OFF);
    const seen = [];
    const lapsed = deps({ hasCapability: async (cap, opts) => { seen.push([cap, opts.orgId]); return false; } });
    assert.equal(await flag.makeResolver(lapsed.d).resolveChatMonitoring('org1'), flag.OFF);
    assert.equal(lapsed.calls.settings, 0, 'the settings are not even read');
    await flag.makeResolver(lapsed.d).resolveChatMonitoring('default');
    assert.deepEqual(seen, [['compliance_hub_gdpr', 'org1'], ['compliance_hub_gdpr', null]]);
});

test('before the start: scheduled, with the date and the version', async () => {
    const { d } = deps({ getSettings: async () => settings({ chat_monitoring_effective_from: '2026-10-27T00:00:00.000Z', chat_monitoring_notice_published_at: '2026-10-19' }) });
    const mon = await flag.makeResolver(d).resolveChatMonitoring('org1');
    assert.equal(mon.state, 'scheduled');
    assert.equal(mon.from, '2026-10-27');
    assert.equal(mon.version, '2026-10-27T00:00:00.000Z');
    assert.deepEqual([...mon.surfaces], ['direct', 'agent', 'agent_public'], 'announced while scheduled');
});

test('an expired DPIA pauses employee surfaces, not website visitors', async () => {
    const { d } = deps({ getDpia: async () => ({ approved_at: new Date(NOW - 400 * DAY), expires_at: null }) });
    const mon = await flag.makeResolver(d).resolveChatMonitoring('org1');
    assert.equal(mon.state, 'on');
    assert.deepEqual([...mon.surfaces], ['agent_public']);
    assert.deepEqual(mon.paused.map(p => [p.surface, [...p.missing]]), [['direct', ['dpia']], ['agent', ['dpia']]]);
});

test('works council pending pauses the employee surfaces; with only those selected the state is off', async () => {
    const { d } = deps({ getSettings: async () => settings({ chat_monitoring_works_council: 'pending', chat_monitoring_surfaces: ['direct'] }) });
    const mon = await flag.makeResolver(d).resolveChatMonitoring('org1');
    assert.equal(mon.state, 'off');
    assert.deepEqual([...mon.surfaces], []);
    assert.deepEqual(mon.paused.map(p => [p.surface, [...p.missing]]), [['direct', ['works_council']]]);
});

test('the default bucket pauses employee surfaces on an installation with organisations', async () => {
    const withOrgs = await flag.makeResolver(deps().d).resolveChatMonitoring('default');
    assert.deepEqual([...withOrgs.surfaces], ['agent_public']);
    assert.ok(withOrgs.paused.every(p => p.missing.includes('default_bucket_has_orgs')));
    const single = await flag.makeResolver(deps({ hasAnyOrganization: async () => false }).d).resolveChatMonitoring('default');
    assert.deepEqual([...single.surfaces], ['direct', 'agent', 'agent_public']);
});

test('a global code (no legal basis, retention out of range) is off', async () => {
    for (const over of [{ chat_monitoring_legal_basis: null }, { chat_monitoring_retention_days: 365 }, { chat_monitoring_signals: ['kinds'] }]) {
        const { d } = deps({ getSettings: async () => settings(over) });
        assert.equal((await flag.makeResolver(d).resolveChatMonitoring('org1')).state, 'off', JSON.stringify(over));
    }
});

test('a read error is OFF, never a throw', async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
        for (const broken of ['isModuleActive', 'hasCapability', 'getSettings', 'getDpia', 'hasAnyOrganization']) {
            const { d } = deps({ [broken]: async () => { throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }); } });
            assert.equal(await flag.makeResolver(d).resolveChatMonitoring('org1'), flag.OFF, broken);
        }
    } finally {
        console.warn = warn;
    }
});

test('the memo: one read per window, single-flight on a miss, invalidate forces a new read', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    let t = NOW;
    const { d, calls } = deps({
        now: () => t,
        getSettings: async () => { calls.settings++; await gate; return settings(); },
    });
    const r = flag.makeResolver(d);
    const [a, b] = [r.resolveChatMonitoring('org1'), r.resolveChatMonitoring('org1')];
    release();
    assert.equal(await a, await b, 'both callers share one read');
    assert.equal(calls.settings, 1);
    await r.resolveChatMonitoring('org1');
    assert.equal(calls.settings, 1, 'memoised');
    r.invalidate('org1');
    await r.resolveChatMonitoring('org1');
    assert.equal(calls.settings, 2, 'invalidate drops the memo');
    t += 31_000;
    await r.resolveChatMonitoring('org1');
    assert.equal(calls.settings, 3, 'expires after 30 s');
    await r.resolveChatMonitoring(null);
    assert.equal(calls.settings, 4, 'null reads the default bucket');
});

test('a read in flight when the route invalidates does not refill the memo with the old answer', async () => {
    let release;
    let started;
    const gate = new Promise(r => { release = r; });
    const reading = new Promise(r => { started = r; });
    let enabled = true;
    const { d } = deps({ getSettings: async () => { const s = settings({ chat_monitoring_enabled: enabled }); started(); await gate; return s; } });
    const r = flag.makeResolver(d);
    const stale = r.resolveChatMonitoring('org1');
    await reading;
    enabled = false;
    r.invalidate('org1');
    release();
    assert.equal((await stale).state, 'on', 'the old read answers its own caller');
    assert.equal((await r.resolveChatMonitoring('org1')).state, 'off', 'the next caller reads the saved state');
});

test('the default instance exposes resolve, invalidate and a test reset', () => {
    assert.equal(typeof flag.resolveChatMonitoring, 'function');
    assert.equal(typeof flag.invalidate, 'function');
    assert.equal(typeof flag._resetForTests, 'function');
});
