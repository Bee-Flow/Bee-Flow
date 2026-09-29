/**
 * The memory master switch, and the precedence between it and everything else
 * that can suppress memory for a turn.
 *
 * The headline assertion is that OFF suppresses *reads* as well as writes. The
 * bug this feature exists to fix was exactly that asymmetry: the composer's
 * Brain toggle was consulted at the two extraction sites and at neither of the
 * two retrieval sites, so "memory off" stopped new memories being saved while
 * every stored one was still injected into every system prompt. A test that
 * only asserts `write === false` would pass against that bug.
 *
 * configStore is stubbed through require.cache, so no database is touched.
 *
 * Run: cd server && node --test core/memory/memoryPolicy.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// ── Stub configStore before the module under test requires it ────────
const rows = new Map();
const reads = [];
const configStub = {
    getConfig: async (key) => { reads.push(key); return rows.has(key) ? rows.get(key) : null; },
    setConfig: async (key, value) => { rows.set(key, value); return true; },
};
const configStorePath = require.resolve('../../stores/configStore');
require.cache[configStorePath] = {
    id: configStorePath, filename: configStorePath, loaded: true, exports: configStub,
};

const {
    memoryEnabledKey,
    isAnonymousUserId,
    isMemoryEnabledForUser,
    resolveMemoryPolicy,
} = require('./memoryPolicy');

beforeEach(() => { rows.clear(); reads.length = 0; });

// ── isAnonymousUserId ────────────────────────────────────────────────

test('a guest id is anonymous; a real id is not', () => {
    assert.strictEqual(isAnonymousUserId('guest_abc123'), true);
    assert.strictEqual(isAnonymousUserId('usr_42'), false);
    assert.strictEqual(isAnonymousUserId('bob'), false);
});

test('a missing or malformed id is treated as anonymous', () => {
    // Fail closed: an id we cannot reason about must not get memory written for it.
    for (const bad of [null, undefined, '', 0, 42, {}, []]) {
        assert.strictEqual(isAnonymousUserId(bad), true, `${JSON.stringify(bad)} must be anonymous`);
    }
});

// ── isMemoryEnabledForUser ───────────────────────────────────────────

test('an absent key means ENABLED', async () => {
    // The neighbouring simpleMode preference reads `!!value` and defaults off.
    // Copying that here would have switched memory off for every existing user
    // on the deploy that shipped this switch.
    assert.strictEqual(await isMemoryEnabledForUser('bob'), true);
});

test('only an explicit false disables it', async () => {
    rows.set(memoryEnabledKey('bob'), false);
    assert.strictEqual(await isMemoryEnabledForUser('bob'), false);

    rows.set(memoryEnabledKey('bob'), true);
    assert.strictEqual(await isMemoryEnabledForUser('bob'), true);
});

test('an anonymous caller is disabled without asking configStore', async () => {
    // Both properties matter: the data property (no memory for guests) and the
    // cost property (an anonymous request must not cost a config round trip).
    assert.strictEqual(await isMemoryEnabledForUser('guest_xyz'), false);
    assert.deepStrictEqual(reads, [], 'no config lookup for an anonymous caller');
});

test('a config outage leaves memory ON rather than silently wiping it', async () => {
    const boom = { getConfig: async () => { throw new Error('pg down'); } };
    require.cache[configStorePath].exports = boom;
    try {
        assert.strictEqual(await isMemoryEnabledForUser('bob'), true);
    } finally {
        require.cache[configStorePath].exports = configStub;
    }
});

// ── resolveMemoryPolicy — precedence ─────────────────────────────────

test('by default a turn may both read and write', async () => {
    const p = await resolveMemoryPolicy({ userId: 'bob' });
    assert.deepStrictEqual({ read: p.read, write: p.write }, { read: true, write: true });
});

test('the master switch off suppresses READ as well as write', async () => {
    // The whole point of the feature. Asserting only `write` is how this regresses.
    rows.set(memoryEnabledKey('bob'), false);
    const p = await resolveMemoryPolicy({ userId: 'bob' });
    assert.strictEqual(p.read, false, 'nothing may be retrieved into the prompt');
    assert.strictEqual(p.write, false, 'nothing may be saved');
    assert.strictEqual(p.reason, 'user_disabled');
});

test('the master switch beats an explicitly-enabled per-chat toggle', async () => {
    rows.set(memoryEnabledKey('bob'), false);
    const p = await resolveMemoryPolicy({ userId: 'bob', perChatWriteEnabled: true });
    assert.strictEqual(p.read, false);
    assert.strictEqual(p.write, false);
});

test('the per-chat pause suppresses writes but NOT reads', async () => {
    // The composer toggle is labelled "Memory saving paused" and is per-chat and
    // per-device. It is deliberately weaker than the account-wide switch.
    const p = await resolveMemoryPolicy({ userId: 'bob', perChatWriteEnabled: false });
    assert.strictEqual(p.read, true, 'existing memories still apply');
    assert.strictEqual(p.write, false);
    assert.strictEqual(p.reason, 'chat_paused');
});

test('an anonymous turn is inert in both directions', async () => {
    const p = await resolveMemoryPolicy({ userId: 'guest_abc' });
    assert.deepStrictEqual({ read: p.read, write: p.write }, { read: false, write: false });
    assert.strictEqual(p.reason, 'anonymous');
    assert.deepStrictEqual(reads, [], 'and costs no config lookup');
});

test('an embed agent stays inert even with the switch on', async () => {
    const p = await resolveMemoryPolicy({ userId: 'bob', agent: { embed_enabled: true } });
    assert.deepStrictEqual({ read: p.read, write: p.write }, { read: false, write: false });
    assert.strictEqual(p.reason, 'embed_agent');
});

test('a blocked turn may still read, but not write', async () => {
    const p = await resolveMemoryPolicy({ userId: 'bob', blocked: true });
    assert.strictEqual(p.read, true);
    assert.strictEqual(p.write, false);
    assert.strictEqual(p.reason, 'blocked');
});

test('an undefined per-chat toggle is not a pause', async () => {
    // The wire default is "absent means on" — `!== false`, not `=== true`.
    const p = await resolveMemoryPolicy({ userId: 'bob', perChatWriteEnabled: undefined });
    assert.strictEqual(p.write, true);
});
