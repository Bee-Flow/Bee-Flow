/**
 * An organisation id has a maximum length, and `createOrganization` is the
 * backstop that enforces it.
 *
 * An org id is a slug of the organisation NAME (auth/accountProvisioning
 * .slugifyOrgId), not a UUID, and nothing capped it. It is then concatenated
 * into Postgres identifiers, config keys and cache keys all over the codebase —
 * and Postgres truncates every identifier to 63 bytes, quoted or not. Two
 * organisations whose ids share a long prefix then address the SAME schema, the
 * same config row and the same cache entry.
 *
 * The datatable schema name is HASHED so it can never depend on this again;
 * every other concatenation site is protected by the cap alone, which is why it
 * lives at the store as well as at the mint site.
 *
 * No real DB: `db` is redirected to an in-memory double under every specifier
 * depth, the same way organizations.datatables.test.js does — see the notes at
 * the top of stores/userStore.credentialCleanup.test.js for why all four.
 *
 * Run: cd server && node --test --test-force-exit stores/user/organizations.orgId.test.js
 */

process.env.NODE_ENV = 'test';   // must precede every require

const assert = require('assert');
const { test, after } = require('node:test');
const { installResolveStub } = require('../../testUtils/stubRequire');

const inserted = [];
const dbStub = {
    pool: {},
    run: async (sql, params) => { inserted.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return { rowCount: 1 }; },
    getOne: async () => null,          // no organisation with this id yet
    getAll: async () => [],
    exec: async () => {},
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
    getRedis: () => null,
    redisHealthy: () => false,
    disconnectRedis: async () => {},
    getPoolStats: () => ({}),
};

const restore = installResolveStub({
    './db': dbStub,
    '../db': dbStub,
    '../../db': dbStub,
    '../../../db': dbStub,
    './notificationStore': { deleteNotificationsForUser: async () => {} },
    '../notificationStore': { deleteNotificationsForUser: async () => {} },
    '../services/planEntitlements': { applyPlanToOrg: async () => {} },
    '../../services/planEntitlements': { applyPlanToOrg: async () => {} },
    './usageStore': { invalidatePaygCache: () => {} },
    '../usageStore': { invalidatePaygCache: () => {} },
    // Non-unref'd 5-minute sweep installed at require time; without this the
    // runner hangs after the last assertion.
    '../../auth/decryptAudit': { trackDecrypt: () => {}, getDecryptStats: () => null },
});
after(restore);

const organizations = require('./organizations');

test('an over-long id is REFUSED, never silently truncated', async () => {
    // Truncating here would store an id the caller does not have, and the
    // caller is the thing that attaches the founding user to it — they would
    // land in an organisation that does not exist.
    const tooLong = 'x'.repeat(organizations.MAX_ORG_ID_LENGTH + 1);
    inserted.length = 0;
    await assert.rejects(
        () => organizations.createOrganization({ id: tooLong, name: 'Too long' }),
        (e) => /at most 48 characters/.test(e.message),
    );
    assert.deepStrictEqual(inserted.filter(c => /INSERT INTO organizations/i.test(c.sql)), [],
        'a refusal that had already inserted is no refusal');
});

test('an id exactly at the cap is accepted', async () => {
    const atCap = 'a'.repeat(organizations.MAX_ORG_ID_LENGTH);
    inserted.length = 0;
    const out = await organizations.createOrganization({ id: atCap, name: 'Just fits' });
    assert.notStrictEqual(out, false);
    assert.ok(inserted.some(c => /INSERT INTO organizations/i.test(c.sql)));
});

test('the cap matches the one the mint site applies', () => {
    // Duplicated rather than imported (accountProvisioning requires userStore,
    // and the import would be a cycle), so the two can drift apart in silence.
    // A store that refuses what the signup flow mints is a 500 on registration.
    const { MAX_ORG_ID_LENGTH } = require('../../auth/accountProvisioning');
    assert.strictEqual(organizations.MAX_ORG_ID_LENGTH, MAX_ORG_ID_LENGTH);
});

test('the cap leaves room under Postgres\'s 63-byte identifier limit', () => {
    // The margin is the point: `dtorg_` was 6 bytes and that was already enough
    // to collide. 15 bytes of headroom covers every other prefix or suffix the
    // codebase concatenates onto an org id.
    assert.ok(organizations.MAX_ORG_ID_LENGTH <= 48);
    assert.ok(63 - organizations.MAX_ORG_ID_LENGTH >= 15);
});
