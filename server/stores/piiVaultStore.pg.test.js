'use strict';

/**
 * stores/piiVaultStore.js against a real Postgres (PGlite): the two
 * guarantees the vault rests on are unique indexes the store creates itself,
 * so they are only visible where the SQL really runs.
 *
 *   - the first write creates the tables: no caller has to initialise the vault
 *   - one token per value: the same value under a second token is a sighting
 *     of the first, not a second row
 *   - one value per token: a token that already stands for another value is
 *     neither stored nor counted as a sighting
 *   - a lookup without candidates answers nothing and asks nothing
 *
 * The key comes from a stand-in for the escrow, on the object the store calls
 * it through.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test stores/piiVaultStore.pg.test.js
 */

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { usePglitePool } = require('../testUtils/pglitePool');
const { makeSwaps } = require('../testUtils/swaps');

const { pg, close } = usePglitePool();
const messageCrypto = require('./agent/messageCrypto');
const vault = require('./piiVaultStore');

const DEK = crypto.createHash('sha256').update('vault-pg-test-dek').digest();
const { swap, restore } = makeSwaps();
before(() => { swap(messageCrypto, '_escrowKey', async () => DEK); });
after(async () => { restore(); await close(); });

const rows = async (/** @type {string} */ userId) => (await pg.query('SELECT token, use_count FROM pii_vault_entries WHERE user_id = $1 ORDER BY token', [userId])).rows;

test('the first write creates the vault tables itself', async () => {
    assert.deepEqual(await vault.recordTokens('u-first', { '[person_1]': 'Alice' }), { stored: 1, bumped: 0 });
    assert.deepEqual(await rows('u-first'), [{ token: '[person_1]', use_count: 1 }]);
});

test('one token per value: the same value under a second token is a sighting of the first', async () => {
    await vault.recordTokens('u-value', { '[person_1]': 'Alice' });
    assert.deepEqual(await vault.recordTokens('u-value', { '[person_2]': 'Alice' }), { stored: 0, bumped: 1 });
    assert.deepEqual(await rows('u-value'), [{ token: '[person_1]', use_count: 2 }]);
});

test('one value per token: a token that stands for another value is neither stored nor a sighting', async () => {
    await vault.recordTokens('u-token', { '[person_1]': 'Alice' });
    assert.deepEqual(await vault.recordTokens('u-token', { '[person_1]': 'Bob' }), { stored: 0, bumped: 0 });
    assert.deepEqual(await rows('u-token'), [{ token: '[person_1]', use_count: 1 }]);
    const found = await vault.lookupTokens('u-token', [{ category: 'person', value: 'Alice' }, { category: 'person', value: 'Bob' }]);
    assert.deepEqual([...found.values()], [{ token: '[person_1]', value: 'Alice' }]);
});

test('a seed for entities that carry no text is the conversation\'s own map, with no counter floors', async () => {
    const own = { '[person_1]': 'Alice' };
    assert.deepEqual(await vault.buildSeed('u-token', [{ type: 'person' }, { type: 'email', text: '' }], own), { tokenMap: own, counterFloors: {} });
    assert.deepEqual(await vault.buildSeed('u-token', [], own), { tokenMap: own, counterFloors: {} });
});

test('a lookup without candidates, or with something that is no list, answers an empty map', async () => {
    assert.deepEqual(await vault.lookupTokens('u-token', []), new Map());
    assert.deepEqual(await vault.lookupTokens('u-token', /** @type {any} */ (null)), new Map());
    assert.deepEqual(await vault.lookupTokens('', [{ category: 'person', value: 'Alice' }]), new Map());
});
