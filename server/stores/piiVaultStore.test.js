/**
 * Tokenization vault store.
 *
 * Two properties carry the security of this table and neither is visible from
 * the outside:
 *
 *   1. `norm_key` is a KEYED blind index, not a digest. A plain hash of the
 *      value would let anyone holding a dump confirm a guess — "is
 *      tomsmit@beeflow.nl in this vault?" — offline and instantly, for every
 *      row, which is exactly the leak the vault exists to prevent.
 *   2. `value_enc` is an envelope, never the raw string.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = 'piivault-unit-test-master-key-32ch!!';

const SERVER = path.join(__dirname, '..');

// ── In-memory DB ────────────────────────────────────────────────────────────

let dbShouldFail = false;
const entries = [];   // rows of pii_vault_entries
const counters = new Map(); // `${user}|${cat}` -> high_water

function mockModule(absPath, exports) {
    require.cache[require.resolve(absPath)] = { id: absPath, filename: absPath, loaded: true, exports };
}

mockModule(path.join(SERVER, 'db'), {
    async exec() {},
    async getOne(sql, params) {
        if (/COUNT\(\*\)/i.test(sql)) {
            return { n: entries.filter(e => e.user_id === params[0]).length };
        }
        return null;
    },
    async getAll(sql, params) {
        if (/FROM pii_vault_counters/i.test(sql)) {
            return [...counters.entries()]
                .filter(([k]) => k.startsWith(`${params[0]}|`))
                .map(([k, v]) => ({ category: k.split('|')[1], high_water: v }));
        }
        if (/norm_key = ANY/i.test(sql)) {
            const [userId, keys] = params;
            return entries.filter(e => e.user_id === userId && keys.includes(e.norm_key));
        }
        if (/FROM pii_vault_entries/i.test(sql)) {
            return entries
                .filter(e => e.user_id === params[0])
                .sort((a, b) => b.last_used_at - a.last_used_at);
        }
        return [];
    },
    async run(sql, params) {
        // The store destructures `run` at module load, so a test cannot swap it
        // out afterwards — the failure has to be injectable from inside.
        if (dbShouldFail) throw new Error('connection reset');
        if (/DELETE FROM pii_vault_counters/i.test(sql)) {
            for (const k of [...counters.keys()]) {
                if (k.startsWith(`${params[0]}|`)) counters.delete(k);
            }
            return { rowCount: 1 };
        }
        if (/INSERT INTO pii_vault_entries/i.test(sql)) {
            const [id, user_id, category, token, norm_key, value_enc] = params;
            // Honour BOTH unique indexes — they are the design, not decoration.
            const dupValue = entries.some(e => e.user_id === user_id && e.category === category && e.norm_key === norm_key);
            const dupToken = entries.some(e => e.user_id === user_id && e.token === token);
            if (dupValue || dupToken) return { rowCount: 0 };
            entries.push({
                id, user_id, category, token, norm_key, value_enc,
                first_seen_at: new Date(), last_used_at: new Date(), use_count: 1,
            });
            return { rowCount: 1 };
        }
        if (/UPDATE pii_vault_entries/i.test(sql)) {
            const [userId, category, normKey] = params;
            const row = entries.find(e => e.user_id === userId && e.category === category && e.norm_key === normKey);
            if (!row) return { rowCount: 0 };
            row.use_count++;
            row.last_used_at = new Date(Date.now() + row.use_count);
            return { rowCount: 1 };
        }
        if (/INSERT INTO pii_vault_counters/i.test(sql)) {
            const [userId, category, value] = params;
            const k = `${userId}|${category}`;
            counters.set(k, Math.max(counters.get(k) || 0, value));
            return { rowCount: 1 };
        }
        if (/DELETE FROM pii_vault_entries/i.test(sql)) {
            const before = entries.length;
            if (/id = \$1 AND user_id = \$2/i.test(sql)) {
                const i = entries.findIndex(e => e.id === params[0] && e.user_id === params[1]);
                if (i >= 0) entries.splice(i, 1);
            } else if (/ORDER BY last_used_at ASC/i.test(sql)) {
                const doomed = entries.filter(e => e.user_id === params[0])
                    .sort((a, b) => a.last_used_at - b.last_used_at)
                    .slice(0, params[1]);
                for (const d of doomed) entries.splice(entries.indexOf(d), 1);
            } else {
                for (let i = entries.length - 1; i >= 0; i--) {
                    if (entries[i].user_id === params[0]) entries.splice(i, 1);
                }
            }
            return { rowCount: before - entries.length };
        }
        return { rowCount: 0 };
    },
});

// A stable per-user DEK, standing in for the org escrow.
const DEK = crypto.createHash('sha256').update('vault-test-dek').digest();
mockModule(path.join(SERVER, 'stores', 'agent', 'messageCrypto'), {
    async _escrowKey() { return DEK; },
});

const vault = require('./piiVaultStore');
const { isEnvelope } = require('./lib/fieldEnvelope');

function reset() { entries.length = 0; counters.clear(); }
test.beforeEach(() => { dbShouldFail = false; reset(); });

// ── The blind index ─────────────────────────────────────────────────────────

test('norm_key is NOT a plain digest of the value', async () => {
    await vault.recordTokens('u-1', { '[email_1]': 'tomsmit@beeflow.nl' });
    const stored = entries[0].norm_key;

    // What an attacker holding the dump would compute to test a guess.
    const naive = crypto.createHash('sha256')
        .update(`email|${vault.normaliseValue('tomsmit@beeflow.nl')}`).digest('hex');
    assert.notStrictEqual(stored, naive,
        'an unkeyed hash makes every entry guess-confirmable offline');
});

test('the blind index is stable for one key and differs across keys', () => {
    const keysA = { index: Buffer.alloc(32, 1), value: Buffer.alloc(32, 2) };
    const keysB = { index: Buffer.alloc(32, 9), value: Buffer.alloc(32, 8) };
    const a1 = vault.blindIndex('person', 'Alice', keysA);
    const a2 = vault.blindIndex('person', 'alice', keysA);
    const b1 = vault.blindIndex('person', 'Alice', keysB);
    assert.strictEqual(a1, a2, 'normalisation happens before hashing');
    assert.notStrictEqual(a1, b1, 'a different user cannot be correlated with the same value');
});

test('the stored value is an envelope, not the raw string', async () => {
    await vault.recordTokens('u-1', { '[person_1]': 'Theodorus van der Brug' });
    assert.ok(isEnvelope(entries[0].value_enc), 'value must be encrypted at rest');
    assert.ok(!JSON.stringify(entries[0]).includes('Theodorus'),
        'the plaintext must not appear anywhere on the row');
});

// ── Stability: the feature's promise ────────────────────────────────────────

test('the same value resolves to the same token on a later lookup', async () => {
    await vault.recordTokens('u-1', { '[person_1]': 'Theodorus van der Brug' });
    const hits = await vault.lookupTokens('u-1', [{ category: 'person', value: 'Theodorus van der Brug' }]);
    const hit = hits.get(`person|${vault.normaliseValue('Theodorus van der Brug')}`);
    assert.ok(hit, 'a stored value must be found again');
    assert.strictEqual(hit.token, '[person_1]');
    assert.strictEqual(hit.value, 'Theodorus van der Brug', 'and decrypt back to itself');
});

test('lookup matches across spelling variants', async () => {
    await vault.recordTokens('u-1', { '[organization_1]': 'Beheer-IT' });
    const hits = await vault.lookupTokens('u-1', [{ category: 'organization', value: 'beheer it' }]);
    assert.strictEqual(hits.size, 1, 'punctuation and case must not split one company in two');
});

test('one user cannot see another user\'s entries', async () => {
    await vault.recordTokens('u-1', { '[email_1]': 'a@b.test' });
    const hits = await vault.lookupTokens('u-2', [{ category: 'email', value: 'a@b.test' }]);
    assert.strictEqual(hits.size, 0);
});

test('re-recording a known value bumps usage instead of duplicating', async () => {
    await vault.recordTokens('u-1', { '[person_1]': 'Alice' });
    const second = await vault.recordTokens('u-1', { '[person_1]': 'Alice' });
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(second.bumped, 1);
    assert.strictEqual(entries[0].use_count, 2);
});

test('a token already assigned to another value is not stolen', async () => {
    await vault.recordTokens('u-1', { '[person_1]': 'Alice' });
    await vault.recordTokens('u-1', { '[person_1]': 'Bob' });
    const alice = entries.find(e => e.token === '[person_1]');
    const stored = await vault.listForUser('u-1');
    assert.ok(alice, '[person_1] still exists');
    assert.strictEqual(stored.entries.find(e => e.token === '[person_1]').value, 'Alice',
        'the first claimant keeps the token');
});

// ── Counters ────────────────────────────────────────────────────────────────

test('high-water marks record the highest token number seen', async () => {
    await vault.recordTokens('u-1', { '[person_3]': 'Alice', '[email_1]': 'a@b.test' });
    const floors = await vault.getCounterFloors('u-1');
    assert.deepStrictEqual(floors, { person: 3, email: 1 });
});

test('a high-water mark never decreases', async () => {
    await vault.recordTokens('u-1', { '[person_9]': 'Alice' });
    await vault.recordTokens('u-1', { '[person_2]': 'Bob' });
    const floors = await vault.getCounterFloors('u-1');
    assert.strictEqual(floors.person, 9, 'a lower sighting must not lower the ceiling');
});

test('deleting an entry does NOT free its token number for reuse', async () => {
    await vault.recordTokens('u-1', { '[person_7]': 'Alice' });
    const { entries: listed } = await vault.listForUser('u-1');
    await vault.deleteEntry('u-1', listed[0].id);

    const floors = await vault.getCounterFloors('u-1');
    assert.strictEqual(floors.person, 7,
        'reissuing [person_7] would re-point a token still sitting in saved messages');
});

test('clearing the vault keeps the counters for the same reason', async () => {
    await vault.recordTokens('u-1', { '[person_4]': 'Alice' });
    await vault.clearForUser('u-1');
    assert.strictEqual(entries.length, 0);
    assert.strictEqual((await vault.getCounterFloors('u-1')).person, 4);
});

test('purging a user drops entries AND counters', async () => {
    await vault.recordTokens('u-1', { '[person_4]': 'Alice' });
    await vault.purgeUser('u-1');
    assert.strictEqual(entries.length, 0);
    assert.deepStrictEqual(await vault.getCounterFloors('u-1'), {},
        'no message survives the user, so no token can be re-pointed');
});

// ── Robustness ──────────────────────────────────────────────────────────────

test('a malformed token is ignored rather than stored', async () => {
    await vault.recordTokens('u-1', { 'not-a-token': 'Alice', '': 'Bob' });
    assert.strictEqual(entries.length, 0);
});

test('recordTokens never throws, even when the DB fails', async () => {
    dbShouldFail = true;
    try {
        const res = await vault.recordTokens('u-1', { '[person_1]': 'Alice' });
        assert.deepStrictEqual(res, { stored: 0, bumped: 0 }, 'a vault failure must not fail the chat turn');
    } finally {
        dbShouldFail = false;
    }
});

test('listForUser marks an entry it can no longer open', async () => {
    await vault.recordTokens('u-1', { '[person_1]': 'Alice' });
    entries[0].value_enc = JSON.stringify({ _bfenc: 1, alg: 'A256GCM', iv: 'aa', tag: 'bb', ct: 'cc' });
    const { entries: listed } = await vault.listForUser('u-1');
    assert.strictEqual(listed[0].unreadable, true);
    assert.strictEqual(listed[0].value, null);
});

test('search filters on the decrypted value, not on ciphertext', async () => {
    await vault.recordTokens('u-1', { '[person_1]': 'Alice Jansen', '[person_2]': 'Bob de Vries' });
    const { entries: hits } = await vault.listForUser('u-1', { search: 'jansen' });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].value, 'Alice Jansen');
});

// ── buildSeed: precedence between the vault and the conversation ────────────
// The vault makes a value's token stable across conversations. The danger runs
// the other way: a conversation's stored messages already contain [person_1],
// and its meaning is fixed by that conversation's own map. If a vault entry
// could override it, every saved message would silently re-point.

test('buildSeed adopts a vault hit the conversation has nothing for', async () => {
    await vault.recordTokens('u-1', { '[person_3]': 'Theodorus van der Brug' });
    const { tokenMap } = await vault.buildSeed('u-1', [{ category: 'Person', text: 'Theodorus van der Brug' }], {});
    assert.strictEqual(tokenMap['[person_3]'], 'Theodorus van der Brug');
});

test('buildSeed DISCARDS a vault token this conversation already spent', async () => {
    await vault.recordTokens('u-1', { '[person_3]': 'Alice' });
    const { tokenMap } = await vault.buildSeed(
        'u-1', [{ category: 'Person', text: 'Alice' }], { '[person_3]': 'Bob' },
    );
    assert.deepStrictEqual(tokenMap, { '[person_3]': 'Bob' },
        'Bob keeps the token — stored messages in this conversation say so');
});

test('buildSeed DISCARDS a vault value this conversation already tokenised', async () => {
    await vault.recordTokens('u-1', { '[person_7]': 'Alice' });
    const { tokenMap } = await vault.buildSeed(
        'u-1', [{ category: 'Person', text: 'Alice' }], { '[person_1]': 'Alice' },
    );
    assert.deepStrictEqual(tokenMap, { '[person_1]': 'Alice' },
        'inside this conversation Alice stays [person_1]');
});

test('buildSeed puts the conversation FIRST in insertion order', async () => {
    await vault.recordTokens('u-1', { '[person_5]': 'Bob' });
    const { tokenMap } = await vault.buildSeed(
        'u-1', [{ category: 'Person', text: 'Bob' }], { '[person_1]': 'Alice' },
    );
    assert.deepStrictEqual(Object.keys(tokenMap), ['[person_1]', '[person_5]'],
        'tokenizeText indexes value→token first-wins, so order is load-bearing');
});

test('buildSeed accepts a Map as well as an object', async () => {
    const { tokenMap } = await vault.buildSeed('u-1', [], new Map([['[email_1]', 'a@b.test']]));
    assert.deepStrictEqual(tokenMap, { '[email_1]': 'a@b.test' });
});

test('buildSeed returns the conversation map untouched without a user', async () => {
    const conv = { '[person_1]': 'Alice' };
    const { tokenMap, counterFloors } = await vault.buildSeed(null, [{ category: 'Person', text: 'Alice' }], conv);
    assert.deepStrictEqual(tokenMap, conv);
    assert.deepStrictEqual(counterFloors, {});
});

test('buildSeed returns the vault high-water marks as counter floors', async () => {
    await vault.recordTokens('u-1', { '[person_6]': 'Alice' });
    const { counterFloors } = await vault.buildSeed('u-1', [{ category: 'Person', text: 'Someone New' }], {});
    assert.strictEqual(counterFloors.person, 6,
        'a fresh mint must continue above every token the vault has issued');
});

test('buildSeed survives a vault outage without failing the turn', async () => {
    dbShouldFail = true;
    try {
        const conv = { '[person_1]': 'Alice' };
        const { tokenMap } = await vault.buildSeed('u-1', [{ category: 'Person', text: 'Bob' }], conv);
        assert.deepStrictEqual(tokenMap, conv, 'falls back to pre-vault behaviour');
    } finally {
        dbShouldFail = false;
    }
});
