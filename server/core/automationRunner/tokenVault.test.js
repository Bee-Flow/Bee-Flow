/**
 * The run-scoped token vault.
 *
 * What these tests protect:
 *  1. Seeding — a resumed run continues the earlier process's placeholders.
 *  2. Merge + dirty/flush — the map is written through, and a merge that lands
 *     DURING a flush is not swallowed by it.
 *  3. Concurrency — two parallel branches minting at the same time can never
 *     hand the same placeholder to two different values.
 *  4. The ceiling — front-eviction is bounded AND audited (an evicted token is
 *     genuinely unrestorable, so it must never be silent).
 *
 * Run: node --test server/core/automationRunner/tokenVault.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');

const { createTokenVault, MAX_TOKENS_PER_RUN } = require('./tokenVault');

test('seeds from a prior run and keeps only string→string entries', () => {
    const v = createTokenVault({
        runId: 'r1',
        seed: { '[person_1]': 'Jan de Vries', '[email_3]': 'jan@acme.nl', bad: 42, 7: null },
    });
    assert.strictEqual(v.all()['[person_1]'], 'Jan de Vries');
    assert.strictEqual(v.all()['[email_3]'], 'jan@acme.nl');
    assert.strictEqual(v.size, 2, 'non-string entries must not enter the map');
    assert.strictEqual(v.dirty, false, 'a fresh seed is already persisted');
});

test('merge marks dirty; flush persists and clears', async () => {
    const writes = [];
    const v = createTokenVault({ runId: 'r2', persist: async (id, map) => { writes.push({ id, map }); } });
    v.merge({ '[person_1]': 'Ada' });
    assert.strictEqual(v.dirty, true);
    await v.flush();
    assert.deepStrictEqual(writes, [{ id: 'r2', map: { '[person_1]': 'Ada' } }]);
    assert.strictEqual(v.dirty, false);
    await v.flush();
    assert.strictEqual(writes.length, 1, 'a clean vault must not write again');
});

test('a merge that lands during a flush is not swallowed by it', async () => {
    const writes = [];
    let release;
    const gate = new Promise(r => { release = r; });
    const v = createTokenVault({
        runId: 'r3',
        persist: async (id, map) => { await gate; writes.push(map); },
    });
    v.merge({ '[person_1]': 'Ada' });
    const inFlight = v.flush();
    v.merge({ '[person_2]': 'Grace' }); // arrives while the write is open
    release();
    await inFlight;
    assert.strictEqual(v.dirty, true, 'the second value still needs persisting');
    await v.flush();
    assert.deepStrictEqual(writes[1], { '[person_1]': 'Ada', '[person_2]': 'Grace' });
});

test('a failed write keeps the vault dirty (the map is not lost)', async () => {
    const v = createTokenVault({ runId: 'r4', persist: async () => { throw new Error('db down'); } });
    v.merge({ '[person_1]': 'Ada' });
    const ok = await v.flush();
    assert.strictEqual(ok, false);
    assert.strictEqual(v.dirty, true);
});

test('concurrent mints never hand the same placeholder to two values', async () => {
    const v = createTokenVault({ runId: 'r5' });
    // A minimal stand-in for tokenizeText: mint the next free number for the
    // category, seeded from whatever the vault already holds.
    const mintFor = (value) => v.mint((seed) => {
        const used = Object.keys(seed)
            .map(k => /^\[person_(\d+)\]$/.exec(k))
            .filter(Boolean)
            .map(m => Number(m[1]));
        const next = (used.length ? Math.max(...used) : 0) + 1;
        const token = `[person_${next}]`;
        return { tokenizedText: token, tokenMap: { [token]: value } };
    });

    const names = ['Ada', 'Grace', 'Alan', 'Katherine', 'Barbara'];
    const minted = await Promise.all(names.map(mintFor));

    const tokens = minted.map(m => m.tokenizedText);
    assert.strictEqual(new Set(tokens).size, names.length, 'every value must get its own placeholder');
    assert.strictEqual(v.size, names.length);
    // And every placeholder resolves back to the value it was minted for.
    minted.forEach((m, i) => assert.strictEqual(v.all()[m.tokenizedText], names[i]));
});

test('a throwing mint does not deadlock the ones behind it', async () => {
    const v = createTokenVault({ runId: 'r6' });
    await assert.rejects(v.mint(() => { throw new Error('boom'); }), /boom/);
    const after = await v.mint(() => ({ tokenizedText: '[email_1]', tokenMap: { '[email_1]': 'a@b.c' } }));
    assert.strictEqual(after.tokenizedText, '[email_1]');
    assert.strictEqual(v.size, 1);
});

test('the ceiling front-evicts and reports it — an evicted token is unrestorable', () => {
    const evictions = [];
    const v = createTokenVault({ runId: 'r7', onEvict: (n) => evictions.push(n) });
    const big = {};
    for (let i = 1; i <= MAX_TOKENS_PER_RUN + 5; i++) big[`[person_${i}]`] = `name ${i}`;
    v.merge(big);
    assert.strictEqual(v.size, MAX_TOKENS_PER_RUN);
    assert.strictEqual(v.evicted, 5);
    assert.deepStrictEqual(evictions, [5], 'eviction must be audited, never silent');
    assert.strictEqual(v.all()['[person_1]'], undefined, 'oldest go first');
    assert.strictEqual(v.all()[`[person_${MAX_TOKENS_PER_RUN + 5}]`], `name ${MAX_TOKENS_PER_RUN + 5}`);
});

test('re-merging an identical entry does not re-dirty the vault', async () => {
    const v = createTokenVault({ runId: 'r8', persist: async () => {} });
    v.merge({ '[person_1]': 'Ada' });
    await v.flush();
    v.merge({ '[person_1]': 'Ada' });
    assert.strictEqual(v.dirty, false);
});
