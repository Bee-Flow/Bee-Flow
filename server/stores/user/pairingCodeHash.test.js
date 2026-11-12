/**
 * Pairing codes kept as a hash (pairingCodeHash.mts, ncBindings.js), against
 * a real Postgres (@electric-sql/pglite behind db.js, testUtils/pglitePool.js)
 * with the real schema; nothing mocked.
 *
 *   - the row holds the hash, never the code; the code is handed back once;
 *   - the code finds its row, in any case and with surrounding blanks;
 *   - a code written before hashing still works until it runs out;
 *   - the active-code list shows no code.
 *
 * Run: cd server && node --test stores/user/pairingCodeHash.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { initDB } = require('./schema');
const nc = require('./ncBindings');
const { hashPairingCode, isHashedPairingCode } = require('./pairingCodeHash.mts');

const ORG = 'org-pair-hash';
before(async () => {
    await initDB();
    await pg.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [ORG, ORG]);
});
after(close);

test('the row keeps the hash; the code is handed back once and finds its row', async () => {
    const minted = await nc.createOrgPairingCode(ORG, { mintedByUserId: 'u1' });
    assert.match(minted.pairingCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const stored = (await pg.query(`SELECT pairing_code FROM pending_nc_bindings WHERE id = $1`, [minted.id])).rows[0].pairing_code;
    assert.ok(isHashedPairingCode(stored));
    assert.ok(!stored.includes(minted.pairingCode));
    assert.equal(stored, await hashPairingCode(minted.pairingCode));

    const found = await nc.getPendingBindingByPairingCode(`  ${minted.pairingCode.toLowerCase()} `);
    assert.equal(found.id, minted.id);
    assert.equal(found.pairingCode, null);
    assert.equal(found.hasPairingCode, true);
    assert.equal(await nc.getPendingBindingByPairingCode('WXYZ-2345'), null);

    const listed = await nc.getActivePairingCodesForOrg(ORG);
    assert.ok(listed.some((c) => c.id === minted.id && c.pairingCode === null));
});

test('a code written before hashing is still accepted while it lives', async () => {
    const expires = new Date(Date.now() + 60_000).toISOString();
    await pg.query(`INSERT INTO pending_nc_bindings (id, org_id, pairing_code, expires_at) VALUES ('legacy-pc', $1, 'ABCD-EFGH', $2)`, [ORG, expires]);
    const found = await nc.getPendingBindingByPairingCode('abcd-efgh');
    assert.equal(found.id, 'legacy-pc');
    assert.equal(await nc.consumePairingCode('legacy-pc', { ncInstanceId: 'inst-legacy' }), true);
    assert.equal(await nc.getPendingBindingByPairingCode('ABCD-EFGH'), null, 'used once');
});
