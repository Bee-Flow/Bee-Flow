/**
 * The ai_step answer cache: the run memo and the durable cross-run tier, and
 * every gate between them.
 *
 *   - no plan in a dry run, without askOnce, with tools offered, or with the
 *     operator switch on;
 *   - the key follows the GUARDED messages, the model, the connection, the
 *     sampling options and the user, so any difference is a different key;
 *   - the durable tier needs acrossRuns + an opted-in org + scopes.ai (the
 *     integration tick alone is not consent), and is closed after a sleep;
 *   - the durable write re-reads the fresh policy and writes nothing when it
 *     was switched off meanwhile;
 *   - a store that fails is a miss, never an error.
 *
 * Run: node --test core/automationRunner/aiStepCache.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { installResolveStub } = require('../../testUtils/stubRequire');

const cfg = {};
const durableRows = new Map();
const durableGets = [];
const durablePuts = [];
let storeFails = false;

const restore = installResolveStub({
    '../../stores/configStore': {
        async getConfig(key) { return cfg[key] !== undefined ? cfg[key] : null; },
        async setConfig(key, value) { cfg[key] = value; return true; },
    },
    '../../stores/integrationCacheStore': {
        cacheKey: (identity) => crypto.createHash('sha256').update(String(identity || '')).digest('hex'),
        async get(key, organizationId, opts = {}) {
            durableGets.push({ key, organizationId, ...opts });
            if (storeFails) throw new Error('database unavailable');
            const row = durableRows.get(key);
            return (row && row.organizationId === organizationId) ? { value: row.value } : null;
        },
        async put(record) {
            durablePuts.push(record);
            if (storeFails) throw new Error('database unavailable');
            durableRows.set(record.key, record);
            return true;
        },
    },
});
after(() => restore());

const { planAiReuse, readAiReuse, rememberAiAnswer } = require('./aiStepCache');
const { createToolMemo } = require('./toolMemo');
const policy = require('./integrationCachePolicy');

const ORG = 'org-a';
const POLICY_KEY = `org_integration_cache_${ORG}`;
const flush = () => new Promise(r => setImmediate(r));

const REQUEST = {
    route: 'structured',
    messages: [{ role: 'system', content: 'Sort the item.' }, { role: 'user', content: 'item <PERSON_1> arrived' }],
    schema: { type: 'object', properties: { label: { type: 'string' } } },
    temperature: 0.2,
    maxOutputTokens: 1024,
    reasoningEffort: null,
};
const ANSWER = { content: null, structured: { label: 'alpha' } };

const makeCtx = (over = {}) => ({ userId: 'u1', orgId: ORG, _toolMemo: createToolMemo(), ...over });
const makeArgs = (over = {}) => ({
    step: { id: 's1', type: 'ai_step', askOnce: { acrossRuns: true } },
    ctx: makeCtx(),
    mode: 'live',
    policy: { action: 'tokenize', privacyScope: 'external' },
    modelId: 'model-a',
    providerKey: 'llm:abc',
    toolsOffered: false,
    request: REQUEST,
    ...over,
});
const keyOf = async (over) => (await planAiReuse(makeArgs(over))).memoK;

beforeEach(() => {
    for (const k of Object.keys(cfg)) delete cfg[k];
    cfg[POLICY_KEY] = { enabled: true, ttlSeconds: 600, scopes: { integration: true, http: false, ai: true } };
    policy.invalidateCachePolicy();
    durableRows.clear();
    durableGets.length = 0;
    durablePuts.length = 0;
    storeFails = false;
    delete process.env.AUTOMATION_ASK_ONCE_DISABLED;
    delete process.env.INTEGRATION_CACHE_DISABLED;
});

// ── when there is no plan ──────────────────────────────────────────────────

test('no plan in a dry run, without askOnce, with tools offered, without a memo, or with the operator switch on', async () => {
    assert.strictEqual(await planAiReuse(makeArgs({ mode: 'dry_run' })), null);
    assert.strictEqual(await planAiReuse(makeArgs({ step: { id: 's1', type: 'ai_step' } })), null);
    assert.strictEqual(await planAiReuse(makeArgs({ toolsOffered: true })), null);
    assert.strictEqual(await planAiReuse(makeArgs({ ctx: { userId: 'u1', orgId: ORG } })), null);
    assert.strictEqual(await planAiReuse(makeArgs({ ctx: makeCtx({ stepInputsSynthetic: true }) })), null);
    process.env.AUTOMATION_ASK_ONCE_DISABLED = '1';
    assert.strictEqual(await planAiReuse(makeArgs()), null);
    process.env.AUTOMATION_ASK_ONCE_DISABLED = '0';
    assert.notStrictEqual(await planAiReuse(makeArgs()), null, '=0 means leave it on');
});

test('reading and remembering with no plan are no-ops', async () => {
    assert.deepStrictEqual(await readAiReuse(null), { reused: null });
    rememberAiAnswer(null, { answer: ANSWER, userId: 'u1' });
});

test('a memo that cannot store is a future miss, never an error', async () => {
    const plan = await planAiReuse(makeArgs({ step: { id: 's1', type: 'ai_step', askOnce: true } }));
    plan.memo = { peek: () => undefined, store: () => { throw new Error('memo full'); } };
    assert.doesNotThrow(() => rememberAiAnswer(plan, { answer: ANSWER, userId: 'u1' }));
    assert.deepStrictEqual(await readAiReuse(plan), { reused: null });
});

// ── the run memo ───────────────────────────────────────────────────────────

test('askOnce: true keeps the answer inside the run, nothing durable', async () => {
    const args = makeArgs({ step: { id: 's1', type: 'ai_step', askOnce: true } });
    const plan = await planAiReuse(args);
    assert.strictEqual(plan.durable, null);
    assert.deepStrictEqual(await readAiReuse(plan), { reused: null });
    rememberAiAnswer(plan, { answer: ANSWER, userId: 'u1' });
    await flush();
    const again = await readAiReuse(await planAiReuse(args));
    assert.strictEqual(again.reused, 'run');
    assert.deepStrictEqual(again.hit, ANSWER);
    assert.deepStrictEqual(durableGets, []);
    assert.deepStrictEqual(durablePuts, []);
});

test('a memo hit is a copy: changing it does not change the next hit', async () => {
    const args = makeArgs({ step: { id: 's1', type: 'ai_step', askOnce: true } });
    rememberAiAnswer(await planAiReuse(args), { answer: ANSWER, userId: 'u1' });
    const first = await readAiReuse(await planAiReuse(args));
    first.hit.structured.label = 'changed';
    const second = await readAiReuse(await planAiReuse(args));
    assert.strictEqual(second.hit.structured.label, 'alpha');
});

test('only the content and structured fields are kept, and an empty answer is not stored', async () => {
    const args = makeArgs({ step: { id: 's1', type: 'ai_step', askOnce: true } });
    const plan = await planAiReuse(args);
    rememberAiAnswer(plan, { answer: { content: null, structured: null }, userId: 'u1' });
    assert.deepStrictEqual(await readAiReuse(plan), { reused: null });
    rememberAiAnswer(plan, { answer: { content: 'hello', structured: null, usage: { tokens: 1 }, raw: {} }, userId: 'u1' });
    assert.deepStrictEqual((await readAiReuse(plan)).hit, { content: 'hello', structured: null });
});

// ── the durable tier ───────────────────────────────────────────────────────

test('the durable tier needs acrossRuns, an opted-in org and scopes.ai', async () => {
    assert.ok((await planAiReuse(makeArgs())).durable, 'all three: on');
    assert.strictEqual((await planAiReuse(makeArgs({ step: { id: 's1', type: 'ai_step', askOnce: {} } }))).durable, null, 'no acrossRuns');
    assert.strictEqual((await planAiReuse(makeArgs({ step: { id: 's1', type: 'ai_step', askOnce: { acrossRuns: 'true' } } }))).durable, null, 'only a literal true');
    assert.strictEqual((await planAiReuse(makeArgs({ ctx: makeCtx({ orgId: null }) }))).durable, null, 'personal account');

    cfg[POLICY_KEY] = { enabled: false, scopes: { ai: true } };
    policy.invalidateCachePolicy();
    assert.strictEqual((await planAiReuse(makeArgs())).durable, null, 'org not opted in');

    cfg[POLICY_KEY] = { enabled: true, ttlSeconds: 600, scopes: { integration: true, http: true } };
    policy.invalidateCachePolicy();
    assert.strictEqual((await planAiReuse(makeArgs())).durable, null, 'scopes.integration alone is not enough');

    cfg[POLICY_KEY] = { enabled: true, ttlSeconds: 600, scopes: { integration: false, ai: true } };
    policy.invalidateCachePolicy();
    assert.ok((await planAiReuse(makeArgs())).durable, 'scopes.ai alone is enough');
});

test('the INTEGRATION_CACHE_DISABLED kill switch closes the durable tier but not the run memo', async () => {
    process.env.INTEGRATION_CACHE_DISABLED = '1';
    const plan = await planAiReuse(makeArgs());
    assert.ok(plan);
    assert.strictEqual(plan.durable, null);
});

test('a run that has slept skips the durable tier', async () => {
    const ctx = makeCtx();
    ctx._toolMemo.clear();
    const plan = await planAiReuse(makeArgs({ ctx }));
    assert.ok(plan, 'the memo itself is still usable');
    assert.strictEqual(plan.durable, null);
    assert.deepStrictEqual(durableGets, []);
});

test('an answer stored by one run is served to another run as "stored", and written back to the memo', async () => {
    rememberAiAnswer(await planAiReuse(makeArgs()), { answer: ANSWER, userId: 'u1' });
    await flush();
    assert.strictEqual(durablePuts.length, 1);
    const put = durablePuts[0];
    assert.strictEqual(put.toolName, 'ai_step');
    assert.strictEqual(put.organizationId, ORG);
    assert.strictEqual(put.userId, 'u1');
    assert.deepStrictEqual(put.value, ANSWER);
    assert.strictEqual(put.ttlSeconds, 600);
    assert.strictEqual(put.maxBytes, 262144);

    // A second run: its own memo, same request.
    const ctx2 = makeCtx();
    const plan2 = await planAiReuse(makeArgs({ ctx: ctx2 }));
    const first = await readAiReuse(plan2);
    assert.strictEqual(first.reused, 'stored');
    assert.deepStrictEqual(first.hit, ANSWER);
    assert.strictEqual(durableGets[0].maxAgeSeconds, 600, 'the window as it stands now');
    assert.strictEqual(ctx2._toolMemo.stats().durableHits, 1);
    // The next ask in that run comes from the memo, not the database.
    const second = await readAiReuse(plan2);
    assert.strictEqual(second.reused, 'run');
    assert.strictEqual(durableGets.length, 1);
});

test('the step window is clamped to 1..900 s and caps the stored window', async () => {
    const plan = await planAiReuse(makeArgs({ step: { id: 's1', type: 'ai_step', askOnce: { acrossRuns: true, ttlSeconds: 5000 } } }));
    rememberAiAnswer(plan, { answer: ANSWER, userId: 'u1' });
    await flush();
    assert.strictEqual(durablePuts[0].ttlSeconds, 600, 'min(org 600, step 900)');

    durablePuts.length = 0;
    const short = await planAiReuse(makeArgs({ step: { id: 's1', type: 'ai_step', askOnce: { acrossRuns: true, ttlSeconds: 30 } } }));
    rememberAiAnswer(short, { answer: ANSWER, userId: 'u1' });
    await flush();
    assert.strictEqual(durablePuts[0].ttlSeconds, 30);
});

test('the durable write re-reads the fresh policy and writes nothing when ai was switched off meanwhile', async () => {
    const plan = await planAiReuse(makeArgs());
    // The admin switches the tick off; this replica still holds the memoised policy.
    cfg[POLICY_KEY] = { enabled: true, ttlSeconds: 600, scopes: { integration: true, ai: false } };
    rememberAiAnswer(plan, { answer: ANSWER, userId: 'u1' });
    await flush();
    assert.deepStrictEqual(durablePuts, []);

    cfg[POLICY_KEY] = { enabled: false };
    rememberAiAnswer(plan, { answer: ANSWER, userId: 'u1' });
    await flush();
    assert.deepStrictEqual(durablePuts, []);
    // The run memo still has it.
    assert.strictEqual((await readAiReuse(plan)).reused, 'run');
});

test('a store that fails is a miss on read and silent on write', async () => {
    storeFails = true;
    const plan = await planAiReuse(makeArgs());
    assert.deepStrictEqual(await readAiReuse(plan), { reused: null });
    rememberAiAnswer(plan, { answer: ANSWER, userId: 'u1' });
    await flush();
    assert.strictEqual(durablePuts.length, 1, 'it tried, and nothing threw');
});

test('a malformed stored value is a miss', async () => {
    const plan = await planAiReuse(makeArgs());
    for (const value of ['text', 42, [], { content: 5, structured: null }, { content: null, structured: 'x' }, { content: null, structured: null }]) {
        durableRows.set(plan.durable.key, { organizationId: ORG, value });
        assert.deepStrictEqual(await readAiReuse(plan), { reused: null }, JSON.stringify(value));
    }
});

test('another organisation never reads this one\'s row', async () => {
    rememberAiAnswer(await planAiReuse(makeArgs()), { answer: ANSWER, userId: 'u1' });
    await flush();
    const row = [...durableRows.values()][0];
    row.organizationId = 'org-b';
    assert.deepStrictEqual(await readAiReuse(await planAiReuse(makeArgs({ ctx: makeCtx() }))), { reused: null });
});

// ── the key ────────────────────────────────────────────────────────────────

test('the same request gives the same key; any difference gives another', async () => {
    const base = await keyOf();
    assert.strictEqual(await keyOf(), base);
    assert.strictEqual(await keyOf({ request: { ...REQUEST, messages: [...REQUEST.messages] } }), base, 'equal content, equal key');

    const others = [
        await keyOf({ request: { ...REQUEST, messages: [REQUEST.messages[0], { role: 'user', content: 'item <PERSON_2> arrived' }] } }),
        await keyOf({ request: { ...REQUEST, temperature: 0.7 } }),
        await keyOf({ request: { ...REQUEST, route: 'prompt' } }),
        await keyOf({ request: { ...REQUEST, schema: null } }),
        await keyOf({ request: { ...REQUEST, maxOutputTokens: 2048 } }),
        await keyOf({ request: { ...REQUEST, reasoningEffort: 'low' } }),
        await keyOf({ modelId: 'model-b' }),
        await keyOf({ providerKey: 'llm:other' }),
        await keyOf({ ctx: makeCtx({ userId: 'u2' }) }),
        await keyOf({ ctx: makeCtx({ orgId: 'org-b' }) }),
        await keyOf({ policy: { action: 'redact', privacyScope: 'external' } }),
    ];
    for (const k of others) assert.notStrictEqual(k, base);
    assert.strictEqual(new Set(others).size, others.length, 'and they differ from each other');
});

test('different users never share a durable key', async () => {
    const a = await planAiReuse(makeArgs({ ctx: makeCtx({ userId: 'u1' }) }));
    const b = await planAiReuse(makeArgs({ ctx: makeCtx({ userId: 'u2' }) }));
    assert.notStrictEqual(a.durable.key, b.durable.key);
});
