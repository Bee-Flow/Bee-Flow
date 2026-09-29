/**
 * The store side of F5: the three account fields the security and admin screens
 * are built on — `mfa_enabled`, `last_seen_at` and `password_changed_at`.
 *
 * Two of them are only as good as the single place that decides about them:
 *
 *   - `password_changed_at` is stamped by isNewCredential, which every writer
 *     passes through. That is the same reasoning as sanitizeUserNames: seven
 *     routes hash a password today, and the eighth one is the one that forgets.
 *     So the tests below drive the store with the payload each of those routes
 *     actually builds, INCLUDING the three writes that touch `passwordHash`
 *     without changing anybody's credential — an empty hash from Azure
 *     provisioning, and the built-in admin row being materialised at login and
 *     at MFA enrolment. Those must stay NULL: "changed today" about a password
 *     from months ago is worse than no date at all.
 *
 *   - `last_seen_at` is written by touchLastSeen, which is deliberately one
 *     UPDATE and nothing else, because it runs from the request path.
 *
 * No real DB: `../../db` is redirected to an in-memory double that records every
 * statement, the same pattern as organizations.datatables.test.js.
 *
 * Run: cd server && node --test --test-force-exit stores/user/users.accountFields.test.js
 */

process.env.NODE_ENV = 'test';   // must precede every require

const assert = require('node:assert/strict');
const { test, after, beforeEach } = require('node:test');
const { installResolveStub } = require('../../testUtils/stubRequire');

const runCalls = [];       // every db.run(...)
const getAllCalls = [];    // every db.getAll(...)
const clientQueries = [];  // every query inside the seat-cap transaction

let getOneImpl = () => null;
let getAllImpl = () => [];
let runThrows = null;

const dbStub = {
    pool: {},
    run: async (sql, params) => {
        runCalls.push({ sql, params });
        if (runThrows) throw new Error(runThrows);
        return { rowCount: 1 };
    },
    getOne: async (sql, params) => getOneImpl(sql, params),
    getAll: async (sql, params) => { getAllCalls.push({ sql, params }); return getAllImpl(sql, params); },
    exec: async () => {},
    getClient: async () => ({
        query: async (sql, params) => {
            clientQueries.push({ sql, params });
            if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ n: 0 }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        },
        release() {},
    }),
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
    getRedis: () => null,
    redisHealthy: () => false,
};

const restore = installResolveStub({
    '../../db': dbStub,
    // initDB is a boot side effect; the schema is not what these tests are about.
    './schema': { initDB: async () => {} },
    './subscriptions': { getEffectiveLimits: async () => ({ max_users: null }) },
    // Pulled in lazily by sanitizeUserNames — the real one loads JSDOM.
    '../../utils/htmlSanitizer': { sanitizePlainText: (v) => (typeof v === 'string' ? v : v ?? null) },
    '../../services/stripeService': { syncSeatQuantityForOrg: async () => {} },
    '../../license': {},
});
after(restore);

const users = require('./users');

beforeEach(() => {
    runCalls.length = 0;
    getAllCalls.length = 0;
    clientQueries.length = 0;
    runThrows = null;
    getOneImpl = () => null;
    getAllImpl = () => [];
});

/** The INSERT that createUser emits, with its column list split out. */
function lastInsert() {
    const hit = [...runCalls].reverse().find(c => /INSERT INTO users/i.test(c.sql));
    assert.ok(hit, 'expected an INSERT INTO users');
    const cols = hit.sql.match(/INSERT INTO users \(([^)]*)\)/i)[1]
        .split(',').map(s => s.trim().replace(/"/g, ''));
    return { ...hit, cols, valueOf: (col) => hit.params[cols.indexOf(col)] };
}

/** The UPDATE that updateUser emits, as a column → value map. */
function lastUpdate() {
    const hit = [...runCalls].reverse().find(c => /^UPDATE users SET/i.test(c.sql.trim()));
    assert.ok(hit, 'expected an UPDATE users');
    const cols = [...hit.sql.matchAll(/"([^"]+)" = \$(\d+)/g)].map(m => [m[1], hit.params[Number(m[2]) - 1]]);
    return { ...hit, set: new Map(cols) };
}

function existingUser(extra = {}) {
    getOneImpl = (sql) => (/FROM users WHERE id/i.test(sql) ? { id: 'u1', organizationId: '', status: 'active', ...extra } : null);
}

// ── getAllUsers: what the admin list may and may not carry ───────────────────

test('the admin user list carries mfa_enabled and last_seen_at, mapped to camelCase', async () => {
    getAllImpl = () => ([{
        id: 'u1', username: 'u1', groups: '[]',
        mfa_enabled: true, last_seen_at: '2026-09-01T10:00:00.000Z',
    }]);

    const rows = await users.getAllUsers();

    const sql = getAllCalls.at(-1).sql;
    assert.match(sql, /\bmfa_enabled\b/, 'A2 needs the 2FA column in the list query');
    assert.match(sql, /\blast_seen_at\b/, 'A4 needs the last-seen column in the list query');

    assert.equal(rows[0].mfaEnabled, true);
    assert.equal(rows[0].lastSeenAt, '2026-09-01T10:00:00.000Z');
    assert.deepEqual(rows[0].groups, []);
});

test('an account that has never been seen reports null, not a stand-in date', async () => {
    getAllImpl = () => ([{ id: 'u1', username: 'u1', groups: '[]', mfa_enabled: null, last_seen_at: null }]);
    const rows = await users.getAllUsers();
    assert.equal(rows[0].lastSeenAt, null, 'null means "unknown" and has to survive to the client');
    assert.equal(rows[0].mfaEnabled, false, 'no row value is "no second factor", never undefined');
});

test('the admin user list still hands out no key material, and no password age', async () => {
    getAllImpl = () => [];
    await users.getAllUsers();
    const sql = getAllCalls.at(-1).sql;
    for (const field of ['masterWrappedDEK', 'wrappedDEK', 'kekSalt', 'recoverySalt', 'recoveryWrappedDEK']) {
        assert.ok(!sql.includes(field), `${field} must never travel with a user list`);
    }
    assert.ok(!/password_changed_at/.test(sql),
        'password age is for a person\'s own security screen (/auth/user), not a per-colleague report');
});

// ── password_changed_at: the paths that DO stamp ─────────────────────────────
//
// One entry per place in the product that installs a new login credential. A
// new password route that is not represented here is a bug, not an omission.

const CREATING_PATHS = [
    ['auth/login/signupRoutes.js:96 — public signup / invite accept',
        { id: 'u1', username: 'u1', passwordHash: '$2b$10$signup', role: 'user', organizationId: '' }],
    ['auth/admin/userRoutes.js:340 — admin creates an account',
        { id: 'u2', username: 'u2', passwordHash: '$2b$10$adminmade', role: 'user', organizationId: '' }],
    ['auth/login/setupRoutes.js:119 — first-run setup of the built-in admin',
        { id: 'admin', username: 'admin', passwordHash: '$2b$12$firstrun', role: 'admin', groups: [] }],
    ['boot-init.js:81 — ADMIN_PASSWORD bootstrap',
        { id: 'admin', username: 'admin', passwordHash: '$2b$12$bootstrap', role: 'admin', groups: [] }],
];

for (const [label, payload] of CREATING_PATHS) {
    test(`createUser dates the credential — ${label}`, async () => {
        assert.equal(await users.createUser(payload), true);
        const ins = lastInsert();
        assert.ok(ins.cols.includes('password_changed_at'), 'the column must be in the INSERT at all');
        assert.ok(ins.valueOf('password_changed_at') instanceof Date,
            'an account created with a password had its password set now');
    });
}

test('createUserWithSeatCheck dates the credential on the org path too', async () => {
    const r = await users.createUserWithSeatCheck({
        id: 'u3', username: 'u3', passwordHash: '$2b$10$viaSeatCheck', organizationId: 'orgA',
    }, { strict: true });
    assert.equal(r.created, true);

    const insert = clientQueries.find(q => /INSERT INTO users/i.test(q.sql));
    assert.ok(insert, 'the seat-capped path inserts inside its transaction');
    const cols = insert.sql.match(/INSERT INTO users \(([^)]*)\)/i)[1].split(',').map(s => s.trim().replace(/"/g, ''));
    assert.equal(cols.length, insert.params.length, 'column list and parameter list must stay in step');
    assert.ok(insert.params[cols.indexOf('password_changed_at')] instanceof Date);
});

test('an admin password change through the edit form is dated', async () => {
    existingUser();
    assert.equal(await users.updateUser('u1', { passwordHash: '$2b$10$edited' }), true);
    assert.ok(lastUpdate().set.get('password_changed_at') instanceof Date,
        'auth/admin/userRoutes.js:522 — both meanings of that branch are a new password');
});

test('self-service change-password and the e-mailed reset are dated', async () => {
    existingUser();
    await users.updateUser('u1', { passwordHash: '$2b$10$selfservice' });
    assert.ok(lastUpdate().set.get('password_changed_at') instanceof Date, 'auth/admin/userRoutes.js:783');

    runCalls.length = 0;
    await users.updateUser('u1', {
        passwordHash: '$2b$10$viaresetlink',
        passwordResetTokenHash: null, passwordResetExpiresAt: null, passwordResetRequired: 0,
    });
    const set = lastUpdate().set;
    assert.ok(set.get('password_changed_at') instanceof Date, 'auth/login/passwordResetRoutes.js:83');
    assert.ok(set.has('password_reset_token_hash'), 'the reset token is still cleared on the same write');
});

test('OPAQUE registration dates itself explicitly — its credential is not a hash', async () => {
    existingUser();
    const stamped = new Date('2026-09-06T08:00:00.000Z');
    await users.updateUser('u1', {
        opaqueRecord: 'record', kdfMode: 'opaque_v1', wrappedDEK: '{}', passwordChangedAt: stamped,
    });
    const set = lastUpdate().set;
    assert.equal(set.get('password_changed_at'), stamped,
        'auth/opaqueRoutes.js — the caller knows better than the hash rule, and is left alone');
});

// ── password_changed_at: the writes that only LOOK like a credential change ──

test('an SSO account provisioned with an empty hash is never dated', async () => {
    // integrations/azureGroupSync.js:407 and :501 — `passwordHash: ''`.
    await users.createUser({ id: 'az1', username: 'az1', passwordHash: '', azureUserId: 'a-1' });
    assert.equal(lastInsert().valueOf('password_changed_at'), null,
        'an empty string is not a credential');
});

test('an account provisioned without a password at all is never dated', async () => {
    // The OAuth / Nextcloud / connector paths pass no passwordHash whatsoever.
    await users.createUser({ id: 'nc1', username: 'nc1', provider: 'nextcloud_connector', autoProvisioned: true });
    assert.equal(lastInsert().valueOf('password_changed_at'), null);
});

test('materialising the built-in admin row does not claim a password change', async () => {
    // auth/login/finalizeLogin.js and auth/mfaRoutes.js copy the hash that has
    // been in the config since setup into the users table.
    await users.createUser({
        id: 'admin', username: 'admin', displayName: 'Administrator',
        passwordHash: '$2b$12$fromconfig', role: 'admin', groups: [],
        credentialUnchanged: true,
    });
    assert.equal(lastInsert().valueOf('password_changed_at'), null,
        'the row is new; the credential is months old');
});

test('the SSO encryption PIN is not a password change', async () => {
    existingUser();
    // auth/opaqueRoutes.js /opaque/pin/register/finish — same field, different meaning.
    await users.updateUser('u1', {
        opaqueRecord: 'pin-record', kdfMode: 'opaque_v1', wrappedDEK: '{}', ssoEncryptionSetup: 1,
    });
    assert.equal(lastUpdate().set.has('password_changed_at'), false,
        'these accounts have no password to have changed');
});

test('an ordinary profile update leaves the password date alone', async () => {
    existingUser();
    await users.updateUser('u1', { displayName: 'New Name', preferredLocale: 'nl' });
    assert.equal(lastUpdate().set.has('password_changed_at'), false);
});

test('isNewCredential is the single decision, and says so for each shape', () => {
    assert.equal(users.isNewCredential({ passwordHash: '$2b$10$x' }), true);
    assert.equal(users.isNewCredential({ passwordHash: '' }), false);
    assert.equal(users.isNewCredential({}), false);
    assert.equal(users.isNewCredential({ passwordHash: '$2b$10$x', credentialUnchanged: true }), false);
    assert.equal(users.isNewCredential(null), false);
});

// ── last_seen_at ─────────────────────────────────────────────────────────────

test('touchLastSeen is one narrow UPDATE on the database clock', async () => {
    assert.equal(await users.touchLastSeen('u1'), true);
    assert.equal(runCalls.length, 1, 'it runs from the request path — one statement, no read');
    assert.equal(runCalls[0].sql.replace(/\s+/g, ' ').trim(),
        'UPDATE users SET last_seen_at = NOW() WHERE id = $1');
    assert.deepEqual(runCalls[0].params, ['u1']);
});

test('touchLastSeen swallows a database failure instead of breaking the request', async () => {
    runThrows = 'connection terminated';
    let result;
    await assert.doesNotReject(async () => { result = await users.touchLastSeen('u1'); });
    assert.equal(result, false, 'bookkeeping, not a gatekeeper');
});

test('touchLastSeen writes nothing without a user id', async () => {
    assert.equal(await users.touchLastSeen(null), false);
    assert.equal(await users.touchLastSeen(''), false);
    assert.equal(runCalls.length, 0);
});

test('updateUser can write both new columns — no key silently dropped', async () => {
    // dynamicUpdate ignores keys that are missing from colMap without a word;
    // that is how recoveryUnwrapFailures stayed dead code for a year.
    existingUser();
    const seen = new Date('2026-09-06T09:00:00.000Z');
    await users.updateUser('u1', { lastSeenAt: seen, passwordChangedAt: seen });
    const set = lastUpdate().set;
    assert.equal(set.get('last_seen_at'), seen);
    assert.equal(set.get('password_changed_at'), seen);
});
