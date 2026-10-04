/**
 * The policy that decides whether an organisation's third-party answers are
 * STORED. Every test here is a way the default could quietly become "on".
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

// The policy reads configStore; stub it before the module is first required.
const blobs = {};
const csPath = require.resolve('../../stores/configStore');
require.cache[csPath] = {
    id: csPath, filename: csPath, loaded: true,
    exports: {
        async getConfig(key) { return blobs[key] !== undefined ? blobs[key] : null; },
        async setConfig(key, v) { blobs[key] = v; return true; },
    },
};
delete require.cache[require.resolve('./integrationCachePolicy')];
const policy = require('./integrationCachePolicy');

beforeEach(() => {
    for (const k of Object.keys(blobs)) delete blobs[k];
    delete process.env.INTEGRATION_CACHE_DISABLED;
    policy.invalidateCachePolicy();
});
afterEach(() => { delete process.env.INTEGRATION_CACHE_DISABLED; });

test('nothing configured means off', async () => {
    const p = await policy.resolveCachePolicy('org-a');
    assert.strictEqual(p.enabled, false);
});

test('a personal account (no org) never gets the durable cache', async () => {
    // "The organisation decided" has nobody to be true of here, and there is no
    // admin to have decided it.
    for (const orgId of [null, undefined, '']) {
        assert.strictEqual((await policy.resolveCachePolicy(orgId)).enabled, false);
    }
});

test('only a literal true enables it', () => {
    for (const v of ['true', 1, 'on', 'yes', {}, [], 'enabled']) {
        assert.strictEqual(policy.normalizePolicy({ enabled: v }).enabled, false,
            `${JSON.stringify(v)} is not an organisation deciding anything`);
    }
    assert.strictEqual(policy.normalizePolicy({ enabled: true }).enabled, true);
});

test('a corrupt config row falls back to off, never to on', () => {
    for (const stored of [null, undefined, 'garbage', 42, [], { ttlSeconds: 600 }]) {
        assert.strictEqual(policy.normalizePolicy(stored).enabled, false);
    }
});

test('the ttl is clamped into a range the runtime can honour', () => {
    assert.strictEqual(policy.normalizePolicy({ ttlSeconds: 1 }).ttlSeconds, policy.MIN_TTL_SECONDS);
    assert.strictEqual(policy.normalizePolicy({ ttlSeconds: 10 ** 9 }).ttlSeconds, policy.MAX_TTL_SECONDS);
    assert.strictEqual(policy.normalizePolicy({ ttlSeconds: 600 }).ttlSeconds, 600);
});

test('an absent or unreadable ttl is the default, not zero', () => {
    // Number(null) and Number('') are 0, so a naive coercion would clamp an
    // absent field to the MINIMUM and quietly rewrite the default.
    for (const v of [null, undefined, '', 'soon', NaN]) {
        assert.strictEqual(policy.normalizePolicy({ ttlSeconds: v }).ttlSeconds, 300);
    }
});

test('the env kill switch beats a stored ON', async () => {
    blobs['org_integration_cache_org-a'] = { enabled: true, ttlSeconds: 900 };
    assert.strictEqual((await policy.resolveCachePolicy('org-a')).enabled, true);

    process.env.INTEGRATION_CACHE_DISABLED = '1';
    policy.invalidateCachePolicy();
    const p = await policy.resolveCachePolicy('org-a');
    assert.strictEqual(p.enabled, false);
    assert.strictEqual(p.killSwitch, true);
});

test('the kill switch accepts the shapes an operator would actually type', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' Yes ']) {
        process.env.INTEGRATION_CACHE_DISABLED = v;
        assert.strictEqual(policy.killSwitchOn(), true, `${v} should switch it off`);
    }
    for (const v of ['0', 'false', 'off', '', 'no']) {
        process.env.INTEGRATION_CACHE_DISABLED = v;
        assert.strictEqual(policy.killSwitchOn(), false);
    }
});

test('a config-store failure resolves to off rather than throwing', async () => {
    const stub = require.cache[csPath].exports;
    const orig = stub.getConfig;
    stub.getConfig = async () => { throw new Error('db down'); };
    try {
        policy.invalidateCachePolicy();
        const p = await policy.resolveCachePolicy('org-b');
        assert.strictEqual(p.enabled, false, 'a step must never fail because a cache policy could not be read');
    } finally {
        stub.getConfig = orig;
    }
});

test('the memo is dropped per org, not globally, on invalidate', async () => {
    blobs['org_integration_cache_org-a'] = { enabled: true };
    blobs['org_integration_cache_org-b'] = { enabled: true };
    await policy.resolveCachePolicy('org-a');
    await policy.resolveCachePolicy('org-b');
    blobs['org_integration_cache_org-a'] = { enabled: false };
    blobs['org_integration_cache_org-b'] = { enabled: false };
    policy.invalidateCachePolicy('org-a');
    assert.strictEqual((await policy.resolveCachePolicy('org-a')).enabled, false, 'org-a re-read');
    assert.strictEqual((await policy.resolveCachePolicy('org-b')).enabled, true, 'org-b still memoised');
});

// ── the write path bypasses the memo ────────────────────────────────────────
//
// invalidateCachePolicy is in-process only. An admin who switches the feature
// off and purges takes effect on THEIR replica instantly; every other replica
// keeps its 30-second-old "enabled: true" and would happily write new rows
// into the table they just emptied. Serving a stale HIT is an answer the org
// consented to storing; manufacturing a new ROW after the deletion is not.

test('the write path re-reads the config row, so a purge cannot be refilled behind it', async () => {
    blobs['org_integration_cache_org-w'] = { enabled: true };
    assert.strictEqual((await policy.resolveCachePolicy('org-w')).enabled, true);

    // Another replica switches it off — this process was never told.
    blobs['org_integration_cache_org-w'] = { enabled: false };
    assert.strictEqual((await policy.resolveCachePolicy('org-w')).enabled, true,
        'the read path is deliberately still memoised — it is the hot path');
    assert.strictEqual((await policy.resolveCachePolicyFresh('org-w')).enabled, false,
        'the write path must see the switch that was already flipped');
});

test('a fresh read also refreshes the memo, so the hot path catches up too', async () => {
    blobs['org_integration_cache_org-w2'] = { enabled: true, ttlSeconds: 600 };
    await policy.resolveCachePolicy('org-w2');
    blobs['org_integration_cache_org-w2'] = { enabled: true, ttlSeconds: 120 };
    await policy.resolveCachePolicyFresh('org-w2');
    assert.strictEqual((await policy.resolveCachePolicy('org-w2')).ttlSeconds, 120);
});

test('the fresh read honours the kill switch and the no-org case', async () => {
    blobs['org_integration_cache_org-w3'] = { enabled: true };
    process.env.INTEGRATION_CACHE_DISABLED = '1';
    assert.strictEqual((await policy.resolveCachePolicyFresh('org-w3')).enabled, false);
    delete process.env.INTEGRATION_CACHE_DISABLED;
    assert.strictEqual((await policy.resolveCachePolicyFresh(null)).enabled, false);
});

// ── the shared flag grammar ─────────────────────────────────────────────────
//
// Both operator switches read env through envFlagOn. The run memo's used bare
// truthiness (`!process.env.AUTOMATION_ASK_ONCE_DISABLED`), so `=0` and
// `=false` — the two things an operator types to mean "leave it on" — both
// switched the feature OFF, and the only symptom was an automation quietly getting
// slower.

test('envFlagOn reads the shapes an operator would actually type', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' Yes ', 'On']) {
        process.env.BF_FLAG_TEST = v;
        assert.strictEqual(policy.envFlagOn('BF_FLAG_TEST'), true, `${JSON.stringify(v)} means on`);
    }
    for (const v of ['0', 'false', 'off', 'no', '', '  ', 'disabled']) {
        process.env.BF_FLAG_TEST = v;
        assert.strictEqual(policy.envFlagOn('BF_FLAG_TEST'), false, `${JSON.stringify(v)} must not mean on`);
    }
    delete process.env.BF_FLAG_TEST;
    assert.strictEqual(policy.envFlagOn('BF_FLAG_TEST'), false, 'unset is off');
});

test('AUTOMATION_ASK_ONCE_DISABLED=false leaves the run memo ENABLED', () => {
    // The whole point of moving execAi onto this parser: a "disabled" switch
    // set to the word for "no" must not disable anything.
    for (const v of ['0', 'false', 'off', 'no']) {
        process.env.AUTOMATION_ASK_ONCE_DISABLED = v;
        assert.strictEqual(policy.envFlagOn('AUTOMATION_ASK_ONCE_DISABLED'), false,
            `AUTOMATION_ASK_ONCE_DISABLED=${v} must leave "ask once" working`);
    }
    process.env.AUTOMATION_ASK_ONCE_DISABLED = '1';
    assert.strictEqual(policy.envFlagOn('AUTOMATION_ASK_ONCE_DISABLED'), true);
    delete process.env.AUTOMATION_ASK_ONCE_DISABLED;
});

test('killSwitchOn is that same parser, so the two switches cannot drift', () => {
    process.env.INTEGRATION_CACHE_DISABLED = 'yes';
    assert.strictEqual(policy.killSwitchOn(), policy.envFlagOn('INTEGRATION_CACHE_DISABLED'));
    process.env.INTEGRATION_CACHE_DISABLED = '0';
    assert.strictEqual(policy.killSwitchOn(), false);
});

// ── scopes: one decision, one row, two ticks ────────────────────────────────
//
// The underlying question is the same one — may third-party response payloads
// be stored at rest for this org — so a second config key would let an org sit
// half-on with nobody able to see which half. But an admin who consented to
// "what a connected app answers" did not consent to arbitrary outbound HTTP.

test('an org already opted in keeps its app-look-up consent when scopes are absent', async () => {
    // The migration stamps these rows; a replica that reads one first must
    // agree with what the migration will write, or the cache flickers off.
    blobs['org_integration_cache_org-a'] = { enabled: true, ttlSeconds: 300 };
    const p = await policy.resolveCachePolicy('org-a');
    assert.strictEqual(p.scopes.integration, true);
});

test('http is OFF on a row written before scopes existed', async () => {
    blobs['org_integration_cache_org-a'] = { enabled: true, ttlSeconds: 300 };
    const p = await policy.resolveCachePolicy('org-a');
    assert.strictEqual(p.scopes.http, false,
        'there is no reading of an older row under which the admin agreed to outbound HTTP');
});

test('only a literal true turns the http scope on', () => {
    for (const v of ['true', 1, 'on', 'yes', {}, [], 'enabled']) {
        assert.strictEqual(policy.normalizePolicy({ enabled: true, scopes: { http: v } }).scopes.http, false,
            `${JSON.stringify(v)} is not an organisation deciding anything`);
    }
    assert.strictEqual(policy.normalizePolicy({ enabled: true, scopes: { http: true } }).scopes.http, true);
});

test('the app-look-up scope is switched off only by a literal false', () => {
    assert.strictEqual(policy.normalizeScopes({ integration: false }).integration, false);
    for (const v of [undefined, null, 0, '', 'no']) {
        assert.strictEqual(policy.normalizeScopes({ integration: v }).integration, true, JSON.stringify(v));
    }
});

test('a corrupt scopes blob falls back to the safe pair, never to both-on', () => {
    for (const scopes of [null, 'garbage', 42, []]) {
        const s = policy.normalizePolicy({ enabled: true, scopes }).scopes;
        assert.deepStrictEqual(s, { integration: true, http: false });
    }
});

test('the default policy carries the same pair', () => {
    assert.deepStrictEqual({ ...policy.DEFAULT_POLICY.scopes }, { integration: true, http: false });
});

test('a personal account gets scopes too, so no caller has to null-check them', async () => {
    const p = await policy.resolveCachePolicy(null);
    assert.strictEqual(p.scopes.http, false);
});
