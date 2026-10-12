/**
 * execIntegrationAction's REUSE composition — the run memo and the durable
 * cross-run cache, and every gate between them.
 *
 * This file exists because that composition had no test at all. The stores and
 * the policy each have their own suite, but the properties that actually keep
 * one organisation's mail out of another's automation are not in either of them —
 * they are in the ORDER and the CONDITIONS here:
 *
 *   - the key is built AFTER the lending identity swap, so a borrowed
 *     connection is part of it rather than invisible to it;
 *   - the durable tier is refused whenever egressMode is not 'real', because
 *     under tokenize/redact two different people produce identical arguments;
 *   - a slept run (a Wait, or the far side of a pause) does not read it;
 *   - a hit writes no egress row and no shape-cache entry, because nothing
 *     left the box;
 *   - a failed dispatch stores nothing, because a transient 500 must not
 *     become the answer for the next hour.
 *
 * Every one of those was protected only by a comment.
 *
 * Run: node --test --test-force-exit core/automationRunner/execAi.cache.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { installResolveStub } = require('../../testUtils/stubRequire');

// ── The doubles ────────────────────────────────────────────────────────────

const cfg = {};                     // configStore rows, keyed as the policy keys them
const dispatches = [];              // every executeTool call that actually happened
const egressRows = [];              // safety.logEgress
const shapeCalls = [];              // shapeCache.recordShape
const durableRows = new Map();      // cache key → the stored record
const durableGets = [];
const durablePuts = [];

let dispatchResult = () => ({ ok: true, items: [1, 2] });
let egressModeValue = 'real';
let lending = null;                 // null = off; otherwise the resolved identity

const configStoreStub = {
    async getConfig(key) { return cfg[key] !== undefined ? cfg[key] : null; },
    async setConfig(key, value) { cfg[key] = value; return true; },
};

const integrationCacheStoreStub = {
    cacheKey: (identity) => crypto.createHash('sha256').update(String(identity || '')).digest('hex'),
    async get(key, organizationId, opts = {}) {
        durableGets.push({ key, organizationId, ...opts });
        const row = durableRows.get(key);
        return (row && row.organizationId === organizationId) ? { value: row.value } : null;
    },
    async put(record) {
        durablePuts.push(record);
        durableRows.set(record.key, record);
        return true;
    },
};

const safetyStub = {
    async resolveAutomationPolicy() { return { action: 'off', privacyScope: 'external' }; },
    buildAuditBase() { return {}; },
    async guardToolInput(inputs) { return { value: inputs, categories: [], wouldBlock: false }; },
    async guardToolOutput(result) { return { result, categories: [] }; },
    prepareForEgress(value) { return value; },
    restoreForRunState(value) { return value; },
    buildPiiSummary() { return null; },
    egressMode() { return egressModeValue; },
    async logEgress(row) { egressRows.push(row); },
};

const restore = installResolveStub({
    '../../stores/configStore': configStoreStub,
    '../../stores/integrationCacheStore': integrationCacheStoreStub,
    '../../stores/usageStore': { recordUsage: async () => {} },
    '../../stores/terminationStore': { logTermination: async () => {} },
    './safety': safetyStub,
    '../aiAgent': { getProviderForModel: () => null },
    '../providers': { getAdapter: () => null },
    '../../automation/bind': { resolveInputs: (inputs) => JSON.parse(JSON.stringify(inputs || {})) },
    '../../automation/sideEffectMap': { isSideEffect: () => false, isMemoisable: () => true },
    '../../automation/outputSchemas': { synthesizeDryRunOutput: () => ({ sample: true }) },
    '../../automation/shapeCache': { async recordShape(rec) { shapeCalls.push(rec); } },
    '../http/outboundProbe': {
        async runWithProbe(fn) { return { result: await fn(), probe: null }; },
        markLocal() {},
    },
    '../integrations/integrationToolMap': {
        resolveIntegration: () => ({ isLocal: false, server: 'mail.example', integration: 'gmail', label: 'Gmail' }),
    },
    '../tools/toolDispatcher': {
        async executeTool(tool, inputs, opts) {
            dispatches.push({ tool, inputs, opts });
            return dispatchResult();
        },
    },
    '../integrations/connectionResolution': {
        isLendingEnabled: () => !!lending,
        async runningUserContext() { return { orgId: 'org-runner', groups: [] }; },
        async resolveEffectiveIdentity() { return lending; },
    },
});
after(() => restore());

const { execIntegrationAction } = require('./execAi');
const { createToolMemo } = require('./toolMemo');
const policy = require('./integrationCachePolicy');

const ORG = 'org-a';
const POLICY_KEY = `org_integration_cache_${ORG}`;

/** The durable put is deliberately not awaited — let its microtask land. */
const flush = () => new Promise(r => setImmediate(r));

function makeStep(over = {}) {
    return {
        id: 's1', type: 'integration_action', tool: 'gmail_search',
        inputs: { q: 'invoice' },
        askOnce: { acrossRuns: true },
        ...over,
    };
}

function makeCtx(over = {}) {
    return {
        userId: 'u-runner', orgId: ORG,
        allowedToolNames: new Set(['gmail_search']),
        _toolMemo: createToolMemo(),
        session: {}, userAuth: {},
        ...over,
    };
}

const run = (step, ctx, mode = 'live') => execIntegrationAction(step, ctx, {}, mode);

beforeEach(() => {
    for (const k of Object.keys(cfg)) delete cfg[k];
    cfg[POLICY_KEY] = { enabled: true, ttlSeconds: 600 };
    policy.invalidateCachePolicy();
    dispatches.length = 0;
    egressRows.length = 0;
    shapeCalls.length = 0;
    durableGets.length = 0;
    durablePuts.length = 0;
    durableRows.clear();
    dispatchResult = () => ({ ok: true, items: [1, 2] });
    egressModeValue = 'real';
    lending = null;
    delete process.env.AUTOMATION_ASK_ONCE_DISABLED;
    delete process.env.INTEGRATION_CACHE_DISABLED;
});

// ── the gate ───────────────────────────────────────────────────────────────

test('nothing is cached when the step did not ask for it', async () => {
    await run(makeStep({ askOnce: undefined }), makeCtx());
    await flush();
    assert.deepStrictEqual(durableGets, []);
    assert.deepStrictEqual(durablePuts, []);
});

test('acrossRuns absent keeps the answer inside the run', async () => {
    const ctx = makeCtx();
    await run(makeStep({ askOnce: {} }), ctx);
    await run(makeStep({ askOnce: {} }), ctx);
    await flush();
    assert.strictEqual(dispatches.length, 1, 'the run memo still collapses the second call');
    assert.deepStrictEqual(durablePuts, [], 'but nothing is stored between runs');
});

test('the durable tier is refused unless the org opted in', async () => {
    cfg[POLICY_KEY] = { enabled: false };
    policy.invalidateCachePolicy();
    await run(makeStep(), makeCtx());
    await flush();
    assert.deepStrictEqual(durableGets, []);
    assert.deepStrictEqual(durablePuts, []);
});

test('a personal account (no org) never reaches the durable tier', async () => {
    // "The organisation decided" has nobody to be true of, and the row has no
    // tenant to be scoped to.
    await run(makeStep(), makeCtx({ orgId: null }));
    await flush();
    assert.deepStrictEqual(durablePuts, []);
});

test('egressMode other than real disqualifies BOTH tiers', async () => {
    // Under tokenize the outgoing arguments are run-vault placeholders and
    // under redact every person collapses to the literal [person] — so two
    // different data subjects produce the SAME arguments, and a cache keyed on
    // those would hand one person's answer to another.
    for (const mode of ['tokenize', 'redact']) {
        egressModeValue = mode;
        dispatches.length = 0; durableGets.length = 0; durablePuts.length = 0;
        const ctx = makeCtx();
        await run(makeStep(), ctx);
        await run(makeStep(), ctx);
        await flush();
        assert.strictEqual(dispatches.length, 2, `${mode}: every call is made for real`);
        assert.deepStrictEqual(durableGets, [], `${mode}: nothing is read from the store`);
        assert.deepStrictEqual(durablePuts, [], `${mode}: nothing is written to it`);
    }
});

test('the operator kill switch closes both tiers, and reads =0 as "leave it on"', async () => {
    process.env.AUTOMATION_ASK_ONCE_DISABLED = '1';
    const ctx = makeCtx();
    await run(makeStep(), ctx);
    await run(makeStep(), ctx);
    await flush();
    assert.strictEqual(dispatches.length, 2);
    assert.deepStrictEqual(durablePuts, []);

    // `=0` is a non-empty string: bare truthiness read the operator's "leave
    // it on" as "switch it off", and the only symptom was a slower automation.
    process.env.AUTOMATION_ASK_ONCE_DISABLED = '0';
    dispatches.length = 0;
    const ctx2 = makeCtx();
    await run(makeStep(), ctx2);
    await run(makeStep(), ctx2);
    assert.strictEqual(dispatches.length, 1, 'AUTOMATION_ASK_ONCE_DISABLED=0 leaves reuse working');
});

test('a dry-run neither reads nor writes the cache', async () => {
    await run(makeStep(), makeCtx(), 'dry_run');
    await flush();
    assert.deepStrictEqual(durableGets, []);
    assert.deepStrictEqual(durablePuts, []);
});

// ── the identity in the key ────────────────────────────────────────────────

test('the key follows the LENDING swap, so the answer lands in the lender org', async () => {
    // Keying on ctx.userId would serve one user's Gmail to another the moment
    // lending is enabled, and storing under the RUNNER's org would put the
    // lender's mail in the borrower's tenant.
    lending = { integrationUserId: 'u-owner', integrationOrgId: 'org-owner', connectionId: 'c1', grantId: 'g1' };
    cfg['org_integration_cache_org-owner'] = { enabled: true, ttlSeconds: 600 };
    policy.invalidateCachePolicy();

    await run(makeStep(), makeCtx({ resourceOwnerUserId: 'u-owner' }));
    await flush();

    assert.strictEqual(durablePuts.length, 1);
    assert.strictEqual(durablePuts[0].organizationId, 'org-owner');
    assert.strictEqual(durablePuts[0].userId, 'u-owner');
    assert.strictEqual(durableGets[0].organizationId, 'org-owner');
});

test('a borrowed answer is not served back to the runner without the lend', async () => {
    lending = { integrationUserId: 'u-owner', integrationOrgId: ORG, connectionId: 'c1', grantId: 'g1' };
    await run(makeStep(), makeCtx({ resourceOwnerUserId: 'u-owner' }));
    await flush();
    const lentKey = durablePuts[0].key;

    lending = null;
    await run(makeStep(), makeCtx());
    await flush();
    assert.notStrictEqual(durablePuts[1].key, lentKey,
        'the runner asking on their own behalf is a different call');
});

test('two different grants never share an answer', async () => {
    // A lend revoked and re-granted, or a different grant entirely, must not
    // be served the previous one's answer.
    const keys = [];
    for (const grantId of ['g1', 'g2']) {
        lending = { integrationUserId: 'u-owner', integrationOrgId: ORG, connectionId: 'c1', grantId };
        await run(makeStep(), makeCtx({ resourceOwnerUserId: 'u-owner' }));
        await flush();
        keys.push(durablePuts.at(-1).key);
    }
    assert.notStrictEqual(keys[0], keys[1]);
    assert.strictEqual(dispatches.length, 2, 'both grants made their own call');
});

test('different arguments are different calls', async () => {
    const ctx = makeCtx();
    await run(makeStep({ inputs: { q: 'invoice' } }), ctx);
    await run(makeStep({ inputs: { q: 'receipt' } }), ctx);
    await flush();
    assert.strictEqual(dispatches.length, 2);
    assert.strictEqual(new Set(durablePuts.map(p => p.key)).size, 2);
});

// ── a hit ──────────────────────────────────────────────────────────────────

test('a stored answer is replayed, and marked as coming from storage', async () => {
    await run(makeStep(), makeCtx());
    await flush();
    assert.strictEqual(dispatches.length, 1);

    // A new run — a fresh memo, the same stored row.
    const out = await run(makeStep(), makeCtx());
    assert.strictEqual(dispatches.length, 1, 'the app was not asked again');
    assert.deepStrictEqual(out.output, { ok: true, items: [1, 2] });
    assert.strictEqual(out.reused, 'stored',
        '"we did not contact this app at all today" is a different fact from a run-memo hit');
});

test('a durable hit writes NO egress row and NO shape-cache entry', async () => {
    // integration_activity_log's invariant is "bytes crossed the boundary, or
    // were stopped at it", and its readers COUNT calls and take MAX(timestamp)
    // for the Art. 44 check and the RoPA. A synthetic row would assert a
    // transfer that did not happen.
    await run(makeStep(), makeCtx());
    await flush();
    egressRows.length = 0;
    shapeCalls.length = 0;

    await run(makeStep(), makeCtx());
    assert.deepStrictEqual(egressRows, []);
    assert.deepStrictEqual(shapeCalls, []);
});

test('a run-memo hit is marked "run", not "stored"', async () => {
    const ctx = makeCtx();
    await run(makeStep(), ctx);
    const out = await run(makeStep(), ctx);
    assert.strictEqual(out.reused, 'run');
});

test('a slept run does not read the durable tier', async () => {
    await run(makeStep(), makeCtx());
    await flush();
    durableGets.length = 0;
    dispatches.length = 0;

    // A Wait clears the memo precisely so the next look-up is asked again;
    // falling through to a row whose TTL is up to an hour would hand back the
    // very answer the clear was meant to discard.
    const ctx = makeCtx();
    ctx._toolMemo.clear();
    await run(makeStep(), ctx);
    assert.deepStrictEqual(durableGets, [], 'the durable tier is shut for the rest of the run');
    assert.strictEqual(dispatches.length, 1, 'the app is asked for real');
});

test('a leg RESUMED after a pause does not read the durable tier', async () => {
    // execution.js builds the resumed leg's memo with startSlept: true. An
    // approval or a form page waits on a PERSON — days, not the half-minute a
    // Wait usually is — so it is the stronger signal of the two.
    await run(makeStep(), makeCtx());
    await flush();
    durableGets.length = 0;
    dispatches.length = 0;

    await run(makeStep(), makeCtx({ _toolMemo: createToolMemo({ startSlept: true }) }));
    assert.deepStrictEqual(durableGets, []);
    assert.strictEqual(dispatches.length, 1);
});

// ── the TTL ────────────────────────────────────────────────────────────────

test('the durable TTL is min(org window, step window)', async () => {
    // Distinct arguments per case: the step's own ttl is deliberately NOT part
    // of the key, so re-running the same call would be served the first row
    // rather than writing a second one.
    cfg[POLICY_KEY] = { enabled: true, ttlSeconds: 600 };
    policy.invalidateCachePolicy();
    await run(makeStep({ inputs: { q: 'a' }, askOnce: { acrossRuns: true, ttlSeconds: 120 } }), makeCtx());
    await flush();
    assert.strictEqual(durablePuts.at(-1).ttlSeconds, 120, 'the step may ask for less');

    await run(makeStep({ inputs: { q: 'b' }, askOnce: { acrossRuns: true, ttlSeconds: 900 } }), makeCtx());
    await flush();
    assert.strictEqual(durablePuts.at(-1).ttlSeconds, 600, 'but never for more than the org allows');

    await run(makeStep({ inputs: { q: 'c' } }), makeCtx());
    await flush();
    assert.strictEqual(durablePuts.at(-1).ttlSeconds, 600, 'no step window means the org window');
});

test('the read carries the CURRENT window, not the one stamped on the row', async () => {
    // expires_at records the policy as it stood at write time, so an admin who
    // drops the window from 60 minutes to 5 after seeing stale data would
    // otherwise keep being served the old answers for another 55.
    await run(makeStep(), makeCtx());
    await flush();
    durableGets.length = 0;

    cfg[POLICY_KEY] = { enabled: true, ttlSeconds: 300 };
    policy.invalidateCachePolicy();
    await run(makeStep(), makeCtx());
    assert.strictEqual(durableGets[0].maxAgeSeconds, 300);
});

test('a stored answer names a size limit, so no caller can be unbounded', async () => {
    await run(makeStep(), makeCtx());
    await flush();
    assert.ok(durablePuts[0].maxBytes > 0);
});

// ── failures store nothing ─────────────────────────────────────────────────

test('a thrown dispatch stores nothing durable, but IS logged as egress', async () => {
    // A transient 500 must not become the answer for the next hour. The bytes
    // still left the box, so the ledger row is owed.
    dispatchResult = () => { throw new Error('upstream 500'); };
    await assert.rejects(() => run(makeStep(), makeCtx()), /upstream 500/);
    await flush();
    assert.deepStrictEqual(durablePuts, []);
    assert.strictEqual(egressRows.length, 1);
    assert.ok(egressRows[0].error, 'a failed call is still a transfer');
});

test('a soft { error } result fails the step and stores nothing', async () => {
    // It arrives as an ordinary VALUE, not a throw, so it slipped straight past
    // "a failure is never stored" — and then served "not authorised" as this
    // call's answer for the whole TTL, failing every later run with no request
    // to the app to explain why.
    dispatchResult = () => ({ error: 'not authorised' });
    await assert.rejects(() => run(makeStep(), makeCtx()), /not authorised/);
    await flush();
    assert.deepStrictEqual(durablePuts, []);
});

test('a soft { error } result is not kept in the RUN memo either', async () => {
    dispatchResult = () => ({ error: 'rate limited' });
    const ctx = makeCtx();
    await assert.rejects(() => run(makeStep(), ctx), /rate limited/);
    dispatchResult = () => ({ ok: true, items: [1, 2] });
    const out = await run(makeStep(), ctx);
    assert.deepStrictEqual(out.output, { ok: true, items: [1, 2] },
        'the retry has to reach the app, not be handed the failure again');
    assert.strictEqual(dispatches.length, 2);
});

test('a durable store that is unreachable is a MISS, never an error', async () => {
    // Nothing about a step's correctness may depend on the cache being
    // reachable: the only correct response to a failure here is to make the
    // call for real.
    const realGet = integrationCacheStoreStub.get;
    integrationCacheStoreStub.get = async () => { throw new Error('db down'); };
    try {
        const out = await run(makeStep(), makeCtx());
        assert.deepStrictEqual(out.output, { ok: true, items: [1, 2] });
        assert.strictEqual(dispatches.length, 1, 'the app was asked for real');
    } finally {
        integrationCacheStoreStub.get = realGet;
    }
});

test('a failing durable write never fails the step', async () => {
    const realPut = integrationCacheStoreStub.put;
    integrationCacheStoreStub.put = async () => { throw new Error('quota'); };
    try {
        const out = await run(makeStep(), makeCtx());
        await flush();
        assert.deepStrictEqual(out.output, { ok: true, items: [1, 2] });
    } finally {
        integrationCacheStoreStub.put = realPut;
    }
});

// ── the write re-checks the policy ─────────────────────────────────────────

test('an org switched off mid-call has nothing written behind it', async () => {
    // invalidateCachePolicy is in-process only, so another replica keeps its
    // 30-second-old "enabled: true". Without the fresh re-read on the write
    // path, an admin's "switch it off and delete everything" is refilled by
    // whatever was already in flight.
    dispatchResult = () => {
        cfg[POLICY_KEY] = { enabled: false };
        return { ok: true, items: [1, 2] };
    };
    await run(makeStep(), makeCtx());
    await flush();
    assert.strictEqual(durableGets.length, 1, 'the read still happened — it was still on then');
    assert.deepStrictEqual(durablePuts, [], 'the write saw the switch that had already been flipped');
});

test('a window shortened mid-call is the one the row is written with', async () => {
    dispatchResult = () => {
        cfg[POLICY_KEY] = { enabled: true, ttlSeconds: 60 };
        return { ok: true, items: [1, 2] };
    };
    await run(makeStep(), makeCtx());
    await flush();
    assert.strictEqual(durablePuts[0].ttlSeconds, 60);
});
