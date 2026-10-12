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
    orgMemoryKey,
    getOrgMemorySettings,
    setOrgMemorySettings,
    memorySensitiveOptInKey,
    isSensitiveOptInForUser,
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

// ── Org layer ────────────────────────────────────────────────────────

test('an org that never saved settings gets the defaults', async () => {
    assert.deepStrictEqual(await getOrgMemorySettings('org1'), { enabled: true, sensitiveOptInAllowed: false, maxPerUser: 1000 });
    assert.deepStrictEqual(await getOrgMemorySettings(null), { enabled: true, sensitiveOptInAllowed: false, maxPerUser: 1000 });
});

test('setOrgMemorySettings merges a patch, sanitises it and clamps maxPerUser', async () => {
    assert.strictEqual((await setOrgMemorySettings('org1', { maxPerUser: 5 })).maxPerUser, 50);
    assert.strictEqual((await setOrgMemorySettings('org1', { maxPerUser: 99999 })).maxPerUser, 10000);
    assert.strictEqual((await setOrgMemorySettings('org1', { maxPerUser: 'nope' })).maxPerUser, 1000);
    const s = await setOrgMemorySettings('org1', { enabled: false, bogus: 1 });
    assert.deepStrictEqual(s, { enabled: false, sensitiveOptInAllowed: false, maxPerUser: 1000 });
    assert.deepStrictEqual(rows.get(orgMemoryKey('org1')), s, 'stored under org_memory_<orgId>, unknown keys dropped');
    assert.strictEqual(orgMemoryKey('org1'), 'org_memory_org1');
});

test('org disabled beats a user who has memory on, in both directions', async () => {
    rows.set(orgMemoryKey('org1'), { enabled: false });
    const p = await resolveMemoryPolicy({ userId: 'bob', orgId: 'org1', perChatWriteEnabled: true, perChatReadEnabled: true });
    assert.deepStrictEqual(p, { read: false, write: false, reason: 'org_disabled', sensitive: false });
});

test('org disabled is reported before user disabled', async () => {
    rows.set(orgMemoryKey('org1'), { enabled: false });
    rows.set(memoryEnabledKey('bob'), false);
    assert.strictEqual((await resolveMemoryPolicy({ userId: 'bob', orgId: 'org1' })).reason, 'org_disabled');
});

test('an org with memory on does not override the user switch', async () => {
    rows.set(orgMemoryKey('org1'), { enabled: true });
    rows.set(memoryEnabledKey('bob'), false);
    assert.strictEqual((await resolveMemoryPolicy({ userId: 'bob', orgId: 'org1' })).reason, 'user_disabled');
});

test('a user without an org never touches the org key', async () => {
    await resolveMemoryPolicy({ userId: 'bob' });
    assert.ok(!reads.some(k => k.startsWith('org_memory_')));
});

test('per-chat read off blocks read AND write; it ranks below the embed agent', async () => {
    const off = await resolveMemoryPolicy({ userId: 'bob', perChatReadEnabled: false });
    assert.deepStrictEqual(off, { read: false, write: false, reason: 'chat_off', sensitive: false });
    const embed = await resolveMemoryPolicy({ userId: 'bob', perChatReadEnabled: false, agent: { embed_enabled: true } });
    assert.strictEqual(embed.reason, 'embed_agent');
});

test('chat_off ranks above chat_paused and blocked; an undefined read flag is not off', async () => {
    const both = await resolveMemoryPolicy({ userId: 'bob', perChatReadEnabled: false, perChatWriteEnabled: false, blocked: true });
    assert.strictEqual(both.reason, 'chat_off');
    const none = await resolveMemoryPolicy({ userId: 'bob', perChatReadEnabled: undefined });
    assert.deepStrictEqual(none, { read: true, write: true, reason: 'enabled', sensitive: false });
});

test('a paused write ranks above blocked', async () => {
    assert.strictEqual((await resolveMemoryPolicy({ userId: 'bob', perChatWriteEnabled: false, blocked: true })).reason, 'chat_paused');
});

test('an anonymous caller is inert even when the org has memory on, without a config read', async () => {
    const p = await resolveMemoryPolicy({ userId: 'guest_1', orgId: 'org1' });
    assert.strictEqual(p.reason, 'anonymous');
    assert.deepStrictEqual(reads, []);
});

test('a config outage on the org read fails open', async () => {
    require.cache[configStorePath].exports = { getConfig: async () => { throw new Error('pg down'); } };
    try {
        const p = await resolveMemoryPolicy({ userId: 'bob', orgId: 'org1' });
        assert.deepStrictEqual({ read: p.read, write: p.write }, { read: true, write: true });
    } finally {
        require.cache[configStorePath].exports = configStub;
    }
});

// ── isSensitiveOptInForUser ──────────────────────────────────────────

test('sensitive opt-in needs the user flag AND the org allowance', async () => {
    assert.strictEqual(memorySensitiveOptInKey('u1'), 'memory_sensitive_opt_in_user_u1');
    assert.strictEqual(await isSensitiveOptInForUser('u1', 'o1'), false);
    rows.set(memorySensitiveOptInKey('u1'), true);
    assert.strictEqual(await isSensitiveOptInForUser('u1', 'o1'), false, 'org has not allowed it');
    rows.set(orgMemoryKey('o1'), { sensitiveOptInAllowed: true });
    assert.strictEqual(await isSensitiveOptInForUser('u1', 'o1'), true);
    rows.set(memorySensitiveOptInKey('u1'), 'yes');
    assert.strictEqual(await isSensitiveOptInForUser('u1', 'o1'), false, 'only boolean true counts');
    assert.strictEqual(await isSensitiveOptInForUser('guest_x', 'o1'), false);
});

test('sensitive opt-in fails closed on a config error', async () => {
    const orig = configStub.getConfig;
    configStub.getConfig = async () => { throw new Error('db down'); };
    try {
        assert.strictEqual(await isSensitiveOptInForUser('u1', 'o1'), false);
    } finally { configStub.getConfig = orig; }
});

// ── sensitive (art. 9) on the read side ──────────────────────────────

test('resolveMemoryPolicy carries sensitive: true only for an opted-in user in an org that allows it', async () => {
    rows.set(orgMemoryKey('org1'), { sensitiveOptInAllowed: true });
    assert.strictEqual((await resolveMemoryPolicy({ userId: 'bob', orgId: 'org1' })).sensitive, false, 'user has not opted in');
    rows.set(memorySensitiveOptInKey('bob'), true);
    assert.strictEqual((await resolveMemoryPolicy({ userId: 'bob', orgId: 'org1' })).sensitive, true);
    assert.strictEqual((await resolveMemoryPolicy({ userId: 'bob', orgId: 'org1', perChatWriteEnabled: false })).sensitive, true, 'a paused write still reads');
    rows.set(orgMemoryKey('org1'), { sensitiveOptInAllowed: false });
    assert.strictEqual((await resolveMemoryPolicy({ userId: 'bob', orgId: 'org1' })).sensitive, false, 'the org no longer allows it');
});

test('a turn with memory off reads no sensitive config and says sensitive: false', async () => {
    rows.set(memorySensitiveOptInKey('bob'), true);
    rows.set(memoryEnabledKey('bob'), false);
    reads.length = 0;
    const p = await resolveMemoryPolicy({ userId: 'bob', orgId: 'org1' });
    assert.strictEqual(p.sensitive, false);
    assert.ok(!reads.includes(memorySensitiveOptInKey('bob')));
});
