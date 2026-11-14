// @typecheck
/**
 * An organisation id has a maximum length, and `createOrganization` is the
 * backstop that enforces it, against a real Postgres (PGlite behind db.js's
 * pool, testUtils/pglitePool.js, with the user store's own schema).
 *
 * An org id is a slug of the organisation NAME (auth/accountProvisioning
 * .slugifyOrgId), not a UUID. It is concatenated into Postgres identifiers,
 * config keys and cache keys all over the codebase, and Postgres truncates
 * every identifier to 63 bytes: two organisations whose ids share a long
 * prefix would address the SAME schema, config row and cache entry.
 *
 * Run: cd server && node --test stores/user/organizations.orgId.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
// Self-hosted: no default subscription is seeded, so creation stays within the organisations table.
process.env.DEPLOYMENT_MODE = 'self-hosted';

const assert = require('assert');
const { test, before, after } = require('node:test');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { initDB } = require('./schema');
const organizations = require('./organizations');

before(async () => {
    await initDB();
    // Initialised here, under PGlite: otherwise a lazy first call lands after the pool is restored.
    await require('../configStore').initDB();
});
// createOrganization pre-generates the webhook signing key on a later tick; let it land on PGlite.
const drain = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
after(async () => { await drain(); await close(); });

const stored = async (id) => (await pg.query('SELECT id, name FROM organizations WHERE id = $1', [id])).rows;

test('an over-long id is REFUSED, never silently truncated', async () => {
    // Truncating would store an id the caller does not have, and the caller
    // attaches the founding user to it: they would land in an organisation that does not exist.
    const tooLong = 'x'.repeat(organizations.MAX_ORG_ID_LENGTH + 1);
    await assert.rejects(
        () => organizations.createOrganization({ id: tooLong, name: 'Too long' }),
        (/** @type {any} */ e) => /at most 48 characters/.test(e.message),
    );
    assert.deepStrictEqual(await stored(tooLong), [], 'a refusal that had already inserted is no refusal');
    assert.deepStrictEqual(await stored(tooLong.slice(0, organizations.MAX_ORG_ID_LENGTH)), [], 'nor a truncated copy');
});

test('an id exactly at the cap is accepted and stored as given', async () => {
    const atCap = 'a'.repeat(organizations.MAX_ORG_ID_LENGTH);
    const out = await organizations.createOrganization({ id: atCap, name: 'Just fits' }, { autoGrantTrial: false });
    assert.notStrictEqual(out, false);
    assert.deepStrictEqual(await stored(atCap), [{ id: atCap, name: 'Just fits' }]);
    assert.strictEqual(await organizations.createOrganization({ id: atCap, name: 'Again' }, { autoGrantTrial: false }), false, 'an existing id is not created twice');
});

test('the cap matches the one the mint site applies', () => {
    // Duplicated rather than imported (accountProvisioning requires userStore,
    // and the import would be a cycle). A store that refuses what the signup
    // flow mints is a 500 on registration.
    const { MAX_ORG_ID_LENGTH } = require('../../auth/accountProvisioning');
    assert.strictEqual(organizations.MAX_ORG_ID_LENGTH, MAX_ORG_ID_LENGTH);
});

test("the cap leaves room under Postgres's 63-byte identifier limit", () => {
    assert.ok(organizations.MAX_ORG_ID_LENGTH <= 48);
    assert.ok(63 - organizations.MAX_ORG_ID_LENGTH >= 15);
});
