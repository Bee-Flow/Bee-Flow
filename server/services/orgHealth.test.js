/**
 * Tests for the org-health emitter (services/orgHealth.js): never-throws
 * contract, CODES catalog invariants, meta sanitizer privacy behaviors, and
 * the in-memory recurrence/liveness throttles with an injectable clock.
 *
 * The store is injected via _setStore so the real orgHealthStore (and the pg
 * pool behind it) is never loaded.
 *
 * Run: cd server && node --test services/orgHealth.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const orgHealth = require('./orgHealth');

const SIX_HOURS = 6 * 60 * 60 * 1000;
const FIFTEEN_MIN = 15 * 60 * 1000;

function makeStub(overrides = {}) {
    const calls = { upsert: [], append: [], resolve: [], liveness: [] };
    const store = {
        upsertProblem: async (p) => {
            calls.upsert.push(p);
            return 'upsertResult' in overrides ? overrides.upsertResult : { inserted: true, reopened: false, count: 1 };
        },
        appendEvent: async (e) => { calls.append.push(e); return { id: 'ev1' }; },
        resolveProblems: async (id, codes, by) => { calls.resolve.push({ id, codes, by }); return 'resolveCount' in overrides ? overrides.resolveCount : 1; },
        touchLiveness: async (orgId, flags) => { calls.liveness.push({ orgId, flags }); },
    };
    return { calls, store };
}

test.beforeEach(() => {
    orgHealth._resetThrottles();
    orgHealth._setNow(); // restore real clock
    orgHealth._setStore(null);
});

// ── never-throws contract ──────────────────────────────────────────────────

test('problem/event/resolve/touchLiveness never throw or reject when the store throws synchronously', async () => {
    orgHealth._setStore({
        upsertProblem() { throw new Error('boom'); },
        appendEvent() { throw new Error('boom'); },
        resolveProblems() { throw new Error('boom'); },
        touchLiveness() { throw new Error('boom'); },
    });
    await assert.doesNotReject(async () => {
        await orgHealth.problem('chat.subscription_blocked', { orgId: 'o1' });
        await orgHealth.event('bootstrap.org_created', { orgId: 'o1' });
        assert.strictEqual(await orgHealth.resolve('o1', ['chat.subscription_blocked']), 0);
        await orgHealth.touchLiveness('o1', 'authOk');
    });
});

test('problem/event/resolve/touchLiveness never reject when the store rejects', async () => {
    orgHealth._setStore({
        upsertProblem: async () => { throw new Error('db down'); },
        appendEvent: async () => { throw new Error('db down'); },
        resolveProblems: async () => { throw new Error('db down'); },
        touchLiveness: async () => { throw new Error('db down'); },
    });
    await assert.doesNotReject(async () => {
        await orgHealth.problem('bootstrap.community_fallback', { orgId: 'o1' });
        await orgHealth.event('onboarding.completed', { orgId: 'o1' });
        await orgHealth.resolve('o1', ['auth.blocked_onboarding_pending']);
        await orgHealth.touchLiveness('o1', 'bootstrap');
    });
});

test('problem() with garbage input still returns a resolvable promise', async () => {
    const { store } = makeStub();
    orgHealth._setStore(store);
    const p = orgHealth.problem('not.in_catalog', { meta: { weird: Symbol('x') } });
    assert.strictEqual(typeof p.then, 'function');
    await assert.doesNotReject(() => p);
});

// ── CODES catalog invariants ───────────────────────────────────────────────

const CATEGORIES = ['bootstrap', 'auth', 'chat', 'binding', 'onboarding', 'connector'];

test('CODES: every entry has category, severity, defaultMessage, remediation and i18nKey', () => {
    const codes = Object.keys(orgHealth.CODES);
    assert.ok(codes.length >= 30, `expected full catalog, got ${codes.length}`);
    for (const code of codes) {
        const def = orgHealth.CODES[code];
        assert.ok(CATEGORIES.includes(def.category), `${code}: bad category ${def.category}`);
        assert.strictEqual(def.category, code.split('.')[0], `${code}: category must match prefix`);
        assert.ok(orgHealth.SEVERITIES.includes(def.severity), `${code}: bad severity ${def.severity}`);
        assert.ok(typeof def.defaultMessage === 'string' && def.defaultMessage.length > 0, `${code}: missing defaultMessage`);
        assert.ok(typeof def.remediation === 'string' && def.remediation.length > 0, `${code}: missing remediation`);
        assert.strictEqual(def.i18nKey, `admin.orgHealth.problem.${code}`, `${code}: i18nKey drift`);
    }
});

test('CODES: lifecycle set matches the design and every ALWAYS_APPEND code exists', () => {
    const expected = [
        'auth.user_auto_provisioned',
        'binding.approved',
        'binding.denied',
        'binding.pairing_code_generated',
        'binding.removed',
        'bootstrap.org_adopted',
        'bootstrap.org_created',
        'bootstrap.pairing_redeemed',
        'bootstrap.plan_applied',
        'bootstrap.verification_succeeded',
        'onboarding.completed',
    ];
    assert.deepStrictEqual([...orgHealth.ALWAYS_APPEND].sort(), expected);
    for (const code of orgHealth.ALWAYS_APPEND) {
        assert.ok(orgHealth.CODES[code], `${code} in ALWAYS_APPEND but not in CODES`);
    }
});

test('CODES: critical gates carry actionable remediation', () => {
    const cf = orgHealth.CODES['bootstrap.community_fallback'];
    assert.strictEqual(cf.severity, 'critical');
    assert.match(cf.remediation, /default plan/i);
    assert.match(cf.remediation, /subscription/i);

    const sb = orgHealth.CODES['chat.subscription_blocked'];
    assert.strictEqual(sb.severity, 'critical');
    assert.match(sb.remediation, /subscription/i);

    assert.strictEqual(orgHealth.CODES['connector.key_divergence'].severity, 'critical');
    assert.strictEqual(orgHealth.CODES['auth.no_matching_tenant_key'].severity, 'critical');
    assert.strictEqual(orgHealth.CODES['bootstrap.org_create_failed'].severity, 'critical');
});

// ── _sanitizeMeta ──────────────────────────────────────────────────────────

test('_sanitizeMeta strips secret-ish keys wholesale', () => {
    const out = orgHealth._sanitizeMeta({
        apiToken: 'x', clientSecret: 'y', Authorization: 'Bearer abc', tenantKey: 'k',
        password: 'p', Cookie: 'c', SESSION_TOKEN: 's',
        safe: 'ok', reason: 'no_subscription',
    });
    assert.deepStrictEqual(out, { safe: 'ok', reason: 'no_subscription' });
});

test('_sanitizeMeta rejects content-bearing fields (never prompt/message content)', () => {
    const out = orgHealth._sanitizeMeta({
        content: 'user typed this', prompt: 'system prompt', message_body: 'hello',
        Content: 'x', PROMPT: 'y',
        modelId: 'claude-fable-5',
    });
    assert.deepStrictEqual(out, { modelId: 'claude-fable-5' });
});

test('_sanitizeMeta truncates long strings to 300 chars', () => {
    const out = orgHealth._sanitizeMeta({ note: 'a'.repeat(1000) });
    assert.strictEqual(out.note.length, 301);
    assert.ok(out.note.endsWith('…'));
    assert.strictEqual(out.note.slice(0, 300), 'a'.repeat(300));
});

test('_sanitizeMeta masks emails (standalone and embedded)', () => {
    const out = orgHealth._sanitizeMeta({
        adminEmail: 'tomsmit@beeflow.nl',
        note: 'contact tomsmit@beeflow.nl about this',
    });
    assert.strictEqual(out.adminEmail, 't•••t@beeflow.nl');
    assert.ok(!out.adminEmail.includes('omsmit'));
    assert.ok(!out.note.includes('tomsmit@'));
    assert.ok(out.note.includes('t•••t@beeflow.nl'));
});

test('_sanitizeMeta caps nesting at depth 2 and bounds arrays', () => {
    const out = orgHealth._sanitizeMeta({
        a: { b: 1, deep: { x: 1 } },
        arr: [1, 'e@x.nl', { y: 2 }],
    });
    assert.deepStrictEqual(out.a, { b: 1 }, 'depth-3 object dropped');
    assert.deepStrictEqual(out.arr, [1, 'e•••@x.nl'], 'depth-3 array element dropped, email masked');
});

test('_sanitizeMeta routes Error instances through the error sanitizer', () => {
    const err = new Error('API error 400: {"messages":[{"role":"user","content":"secret stuff here"}]}');
    const out = orgHealth._sanitizeMeta({ error: err });
    assert.strictEqual(typeof out.error, 'object');
    assert.ok(out.error.errorCode, 'classified code present');
    assert.ok(!JSON.stringify(out.error).includes('secret stuff'), 'payload echo must not survive');
    assert.match(out.error.errorFirstLine, /<redacted>/);
});

test('_sanitizeMeta handles non-object input and never throws', () => {
    assert.deepStrictEqual(orgHealth._sanitizeMeta(null), {});
    assert.deepStrictEqual(orgHealth._sanitizeMeta('a string'), {});
    assert.deepStrictEqual(orgHealth._sanitizeMeta([1, 2, 3]), {});
    assert.deepStrictEqual(orgHealth._sanitizeMeta(undefined), {});
});

// ── subject-key resolution ─────────────────────────────────────────────────

test('problem() resolves subject keys: orgId > nc: > explicit > unknown', async () => {
    const { calls, store } = makeStub();
    orgHealth._setStore(store);

    await orgHealth.problem('bootstrap.verify_failed', { ncInstanceId: 'abc' });
    assert.strictEqual(calls.upsert[0].subjectKey, 'nc:abc');
    assert.strictEqual(calls.upsert[0].organizationId, null);

    await orgHealth.problem('auth.no_matching_tenant_key', { subjectKey: 'domain:beeflow.nl' });
    assert.strictEqual(calls.upsert[1].subjectKey, 'domain:beeflow.nl');

    await orgHealth.problem('chat.provider_error', {});
    assert.strictEqual(calls.upsert[2].subjectKey, 'unknown');

    await orgHealth.problem('chat.provider_error', { orgId: 'o1', ncInstanceId: 'abc', subjectKey: 'domain:x' });
    assert.strictEqual(calls.upsert[3].subjectKey, 'o1', 'orgId wins');
    assert.strictEqual(calls.upsert[3].organizationId, 'o1');
});

test('problem() fills message/remediation/category from the catalog', async () => {
    const { calls, store } = makeStub();
    orgHealth._setStore(store);
    await orgHealth.problem('bootstrap.community_fallback', { orgId: 'o1', source: 'connectorBootstrap' });
    const p = calls.upsert[0];
    assert.strictEqual(p.category, 'bootstrap');
    assert.strictEqual(p.severity, 'critical');
    assert.strictEqual(p.message, orgHealth.CODES['bootstrap.community_fallback'].defaultMessage);
    assert.strictEqual(p.remediation, orgHealth.CODES['bootstrap.community_fallback'].remediation);
    assert.strictEqual(p.source, 'connectorBootstrap');
});

// ── recurrence throttle (6h, injectable clock) ─────────────────────────────

test('recurrence throttle: at most one timeline event per 6h for pure recurrences', async () => {
    let now = 1_000_000;
    orgHealth._setNow(() => now);
    const { calls, store } = makeStub({ upsertResult: { inserted: false, reopened: false, count: 7 } });
    orgHealth._setStore(store);

    await orgHealth.problem('auth.blocked_onboarding_pending', { orgId: 'o1' });
    await orgHealth.problem('auth.blocked_onboarding_pending', { orgId: 'o1' });
    await orgHealth.problem('auth.blocked_onboarding_pending', { orgId: 'o1' });
    assert.strictEqual(calls.upsert.length, 3, 'rollup always written');
    assert.strictEqual(calls.append.length, 1, 'timeline appended at most once inside the window');

    now += SIX_HOURS + 1;
    await orgHealth.problem('auth.blocked_onboarding_pending', { orgId: 'o1' });
    assert.strictEqual(calls.append.length, 2, 'append again after the window elapses');
    assert.strictEqual(calls.append[1].meta.occurrenceCount, 7, 'recurrence event carries the rollup count');
});

test('recurrence throttle: state transitions (insert/reopen) bypass the window', async () => {
    let now = 0;
    orgHealth._setNow(() => now);
    const { calls, store } = makeStub({ upsertResult: { inserted: false, reopened: true, count: 2 } });
    orgHealth._setStore(store);

    await orgHealth.problem('chat.subscription_blocked', { orgId: 'o1' });
    now += 1000; // well inside the 6h window
    await orgHealth.problem('chat.subscription_blocked', { orgId: 'o1' });
    assert.strictEqual(calls.append.length, 2, 'reopen is a transition — always on the timeline');
});

test('recurrence throttle is scoped per (subject, code)', async () => {
    let now = 0;
    orgHealth._setNow(() => now);
    const { calls, store } = makeStub({ upsertResult: { inserted: false, reopened: false, count: 2 } });
    orgHealth._setStore(store);

    await orgHealth.problem('auth.blocked_geo', { orgId: 'o1' });
    await orgHealth.problem('auth.blocked_geo', { orgId: 'o2' });
    await orgHealth.problem('auth.blocked_seat_cap', { orgId: 'o1' });
    assert.strictEqual(calls.append.length, 3, 'different subjects/codes throttle independently');
});

// ── event() ────────────────────────────────────────────────────────────────

test('event() always appends, stamps actor + ip from req', async () => {
    const { calls, store } = makeStub();
    orgHealth._setStore(store);
    await orgHealth.event('onboarding.completed', {
        orgId: 'o1', actorUserId: 'u1', actorKind: 'user',
        req: { headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' } },
        meta: { syncMode: 'mirror_all' },
    });
    await orgHealth.event('onboarding.completed', { orgId: 'o1', actorKind: 'alien' });
    assert.strictEqual(calls.append.length, 2, 'no throttle on lifecycle events');
    const e = calls.append[0];
    assert.strictEqual(e.code, 'onboarding.completed');
    assert.strictEqual(e.category, 'onboarding');
    assert.strictEqual(e.actorKind, 'user');
    assert.strictEqual(e.actorUserId, 'u1');
    assert.strictEqual(e.ip, '9.9.9.9');
    assert.deepStrictEqual(e.meta, { syncMode: 'mirror_all' });
    assert.strictEqual(calls.append[1].actorKind, 'system', 'invalid actorKind coerced');
});

// ── resolve() ──────────────────────────────────────────────────────────────

test('resolve() appends a health.resolved event only when rows flipped', async () => {
    const zero = makeStub({ resolveCount: 0 });
    orgHealth._setStore(zero.store);
    assert.strictEqual(await orgHealth.resolve('o1', ['chat.subscription_blocked']), 0);
    assert.strictEqual(zero.calls.append.length, 0, 'nothing flipped → no timeline noise');

    const two = makeStub({ resolveCount: 2 });
    orgHealth._setStore(two.store);
    assert.strictEqual(await orgHealth.resolve('o1', ['chat.subscription_blocked', 'chat.budget_exhausted']), 2);
    assert.strictEqual(two.calls.append.length, 1);
    const e = two.calls.append[0];
    assert.strictEqual(e.code, 'health.resolved');
    assert.strictEqual(e.organizationId, 'o1');
    assert.deepStrictEqual(e.meta.codes, ['chat.subscription_blocked', 'chat.budget_exhausted']);
    assert.strictEqual(e.actorKind, 'system');
});

test('resolve() with a bucket subject keeps organizationId null; admin resolver is stamped', async () => {
    const { calls, store } = makeStub({ resolveCount: 1 });
    orgHealth._setStore(store);
    await orgHealth.resolve('nc:abc', ['bootstrap.verify_failed']);
    assert.strictEqual(calls.append[0].organizationId, null);
    assert.strictEqual(calls.append[0].subjectKey, 'nc:abc');

    await orgHealth.resolve('o1', ['chat.dlp_blocked'], { resolvedBy: 'u42' });
    assert.strictEqual(calls.resolve[1].by, 'u42');
    assert.strictEqual(calls.append[1].actorKind, 'admin');
    assert.strictEqual(calls.append[1].actorUserId, 'u42');
});

test('resolve() with empty codes or missing subject is a 0 no-op', async () => {
    const { calls, store } = makeStub();
    orgHealth._setStore(store);
    assert.strictEqual(await orgHealth.resolve('o1', []), 0);
    assert.strictEqual(await orgHealth.resolve(null, ['x']), 0);
    assert.strictEqual(calls.resolve.length, 0);
});

// ── liveness throttle (15 min, injectable clock) ───────────────────────────

test('touchLiveness: one DB write per org/kind per 15 minutes', async () => {
    let now = 0;
    orgHealth._setNow(() => now);
    const { calls, store } = makeStub();
    orgHealth._setStore(store);

    await orgHealth.touchLiveness('o1', 'authOk');
    await orgHealth.touchLiveness('o1', 'authOk');
    assert.strictEqual(calls.liveness.length, 1);
    assert.deepStrictEqual(calls.liveness[0], { orgId: 'o1', flags: { authOk: true, connectorVersion: null } });

    // different kind → separate throttle bucket
    await orgHealth.touchLiveness('o1', 'statusReport', { connectorVersion: '1.2.3' });
    assert.strictEqual(calls.liveness.length, 2);
    assert.deepStrictEqual(calls.liveness[1].flags, { statusReport: true, connectorVersion: '1.2.3' });

    now += FIFTEEN_MIN + 1;
    await orgHealth.touchLiveness('o1', 'authOk');
    assert.strictEqual(calls.liveness.length, 3, 'window elapsed → write again');
});

test('touchLiveness: unknown kind coerces to authOk; missing orgId is a no-op', async () => {
    const { calls, store } = makeStub();
    orgHealth._setStore(store);
    await orgHealth.touchLiveness('o1', 'weird_kind');
    assert.deepStrictEqual(calls.liveness[0].flags, { authOk: true, connectorVersion: null });
    await orgHealth.touchLiveness(null, 'authOk');
    assert.strictEqual(calls.liveness.length, 1);
});

// ── openProblemLastSeen (backoff reads off the rollup) ─────────────────────

test('connector.nc_sync_failed is a warning, so a failing user sync never marks the org as blocked', () => {
    const def = orgHealth.CODES['connector.nc_sync_failed'];
    assert.ok(def, 'catalog entry missing');
    assert.strictEqual(def.category, 'connector');
    assert.strictEqual(def.severity, 'warning');
    assert.match(def.remediation, /re-pair/i);
});

test('openProblemLastSeen maps open rows of one code to subject → last-seen ms', async () => {
    const seen = [];
    orgHealth._setStore({
        listProblems: async (opts) => {
            seen.push(opts);
            return [
                { organizationId: 'o1', subjectKey: 'o1', code: 'connector.nc_sync_failed', lastSeenAt: new Date('2026-09-26T08:00:00Z') },
                { organizationId: null, subjectKey: 'nc:inst-9', code: 'connector.nc_sync_failed', lastSeenAt: '2026-09-25T08:00:00Z' },
                { organizationId: 'o2', subjectKey: 'o2', code: 'connector.nc_sync_failed', lastSeenAt: null },
            ];
        },
    });
    const map = await orgHealth.openProblemLastSeen('connector.nc_sync_failed');
    assert.strictEqual(seen[0].code, 'connector.nc_sync_failed');
    assert.ok(!seen[0].includeResolved, 'resolved problems must not count');
    assert.strictEqual(map.get('o1'), Date.parse('2026-09-26T08:00:00Z'));
    assert.strictEqual(map.get('nc:inst-9'), Date.parse('2026-09-25T08:00:00Z'));
    assert.strictEqual(map.has('o2'), false, 'a row without a timestamp is not a known failure time');
});

test('openProblemLastSeen never rejects: a failing read is an empty map', async () => {
    orgHealth._setStore({ listProblems: async () => { throw new Error('db down'); } });
    const map = await orgHealth.openProblemLastSeen('connector.nc_sync_failed');
    assert.ok(map instanceof Map);
    assert.strictEqual(map.size, 0);
    orgHealth._setStore({ listProblems() { throw new Error('sync boom'); } });
    assert.strictEqual((await orgHealth.openProblemLastSeen('x.y')).size, 0);
    assert.strictEqual((await orgHealth.openProblemLastSeen('')).size, 0);
});
