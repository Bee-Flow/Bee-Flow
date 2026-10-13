/**
 * What /admin-login accepts, and what it says when it refuses
 * (auth/login/passwordLoginRoutes.js).
 *
 * The hand-written check here ran AFTER loadConfig() and after the SSO-only
 * decision, and answered one generic sentence. The schema runs before any of
 * that, so a malformed request costs no config read and no throttle entry, and
 * `details` names the field that is wrong. What this file pins:
 *
 *   - the 400 NAMES the field (`body.password`), not just "invalid request";
 *   - the message stays ONE sentence for both fields — it must not tell a
 *     caller which half of the credentials it recognised;
 *   - the identifier is NOT trimmed: it is the throttle's key and the
 *     operator-name comparison, so " admin" must stay a different string;
 *   - the store and the throttle are never reached, so a refused request
 *     leaves no failure counted against anybody.
 *
 * And, at the bottom, the argon2id migration (auth/passwordHash.js,
 * auth/login/passwordRehash.js) with real hashing over in-memory stores:
 * an old bcrypt hash still signs in and is upgraded through the
 * compare-and-swap helpers (never updateUser, so no new password date), the
 * built-in admin's config hash likewise, a wrong password changes nothing,
 * an unknown name spends one compare against an argon2id dummy with the
 * parameters of a real hash, and a failing upgrade does not fail the sign-in.
 *
 * Run: cd server && node --test --test-force-exit auth/login/passwordLoginRoutes.validation.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';
// The migration tests below exercise the argon2id write path, which is opt-in
// (auth/passwordHash.js ROLLOUT); the default bcrypt path is covered in
// auth/passwordHash.rollout.test.js.
process.env.PASSWORD_HASH_ALGORITHM = 'argon2id';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const bcrypt = require('bcryptjs');

// Every store and side-effect call lands in `touched`. A refused request must
// leave it empty.
const touched = [];
const pass = (req, res, next) => next();
const hit = (what) => (...args) => { touched.push({ what, args }); };

// ── State for the argon2id-migration tests at the bottom of this file ──
// Real hashing (auth/passwordHash.js) and the real upgrade logic
// (auth/login/passwordRehash.js) over in-memory stores. Absolute paths on
// purpose: Node caches a relative require per directory, and the route under
// test lives in this directory and requires these same strings.
const realPasswords = require(path.join(__dirname, '..', 'passwordHash.js'));
const { createPasswordRehash } = require(path.join(__dirname, 'passwordRehash.js'));
/** Every hash that verify() was asked to compare against. */
const verifiedAgainst = [];
const users = new Map();
const config = { admin: { username: 'admin', passwordHash: null }, oauth: {} };
const writes = { rows: [], admin: [], updateUser: 0 };
let failRowWrite = false;
const finalized = [];
const silent = { info() {}, warn() {}, error() {}, debug() {} };

const userStoreDouble = {
    getUser: async (id) => { touched.push({ what: 'getUser', args: [id] }); return users.get(id) || null; },
    getUserByEmail: async (e) => { touched.push({ what: 'getUserByEmail', args: [e] }); return null; },
    listSecurityKeys: async () => [],
    updateUser: async () => { writes.updateUser++; return true; },
    replacePasswordHash: async (id, expected, next) => {
        if (failRowWrite) throw new Error('db down');
        const row = users.get(id);
        if (!row || row.passwordHash !== expected) return false;
        row.passwordHash = next;
        writes.rows.push({ id, next });
        return true;
    },
};
const authConfigDouble = {
    replaceAdminPasswordHash: async (expected, next) => {
        if (config.admin.passwordHash !== expected) return false;
        config.admin.passwordHash = next;
        writes.admin.push(next);
        return true;
    },
};

const MOCKS = {
    '../../stores/userStore': userStoreDouble,
    '../permissions': { loadConfig: async () => JSON.parse(JSON.stringify(config)) },
    '../../telemetry/metrics': { recordAuthEvent() {} },
    '../loginThrottle': {
        checkLoginAllowed: async (req, id) => { touched.push({ what: 'checkLoginAllowed', args: [id] }); return { allowed: true }; },
        recordLoginFailure: async (req, id) => { touched.push({ what: 'recordLoginFailure', args: [id] }); return { delayMs: 0, locked: false }; },
        recordLoginSuccess: hit('recordLoginSuccess'),
        denyLogin: (res) => res.status(429).json({ error: 'too many' }),
        padFailureResponse: async () => {},
        sleep: async () => {},
    },
    '../loginAudit': { auditLoginFailure: async () => {}, auditLoginBlocked: async () => {} },
    '../authRateLimits': { loginIpLimiter: pass },
    './finalizeLogin': {
        finalizeLogin: async (req, res, args) => { finalized.push(args); return res.json({ success: true, user: args.user }); },
    },
    '../../telemetry/log': silent,
    '../passwordHash': {
        ...realPasswords,
        verify: async (pw, stored) => { verifiedAgainst.push(stored); return realPasswords.verify(pw, stored); },
    },
    './passwordRehash': createPasswordRehash({
        passwords: realPasswords, userStore: userStoreDouble, authConfigStore: authConfigDouble, log: silent,
    }),
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:password-login-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /login[\\/]passwordLoginRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./passwordLoginRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../testUtils/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: null, save: (cb) => cb() }) });

test.beforeEach(() => { touched.length = 0; });

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

test('a sign-in with no password is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/admin-login', body: { username: 'bob' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Username and password are required');
    assert.ok(res.body.details.some((d) => d.path === 'body.password'));
    assert.deepStrictEqual(touched, []);
});

test('a missing username is refused with the SAME sentence as a missing password', async () => {
    // The wording must not separate "you left out a field" from "no such
    // account"; only `details` says which field, which is about the request.
    const a = await dispatch({ method: 'POST', url: '/admin-login', body: { password: 'x' } });
    const b = await dispatch({ method: 'POST', url: '/admin-login', body: { username: 'bob' } });
    assert.strictEqual(a.body.error, b.body.error);
});

test('a numeric username is refused by name instead of throwing on .includes', async () => {
    await refuses({ method: 'POST', url: '/admin-login', body: { username: 42, password: 'x' } }, 'body.username');
});

test('a misspelled key is refused rather than read as a missing credential', async () => {
    await refuses({ method: 'POST', url: '/admin-login', body: { username: 'bob', passsword: 'x' } }, 'body');
});

test('the identifier reaches the throttle exactly as it was typed', async () => {
    // Trimming here would give " admin" its own failure counter and its own
    // way around the lockout on `admin`.
    await dispatch({ method: 'POST', url: '/admin-login', body: { username: ' admin ', password: 'x' } });
    const gate = touched.find((t) => t.what === 'checkLoginAllowed');
    assert.strictEqual(gate.args[0], ' admin ');
});

// ── argon2id migration ─────────────────────────────────────────────────────────

const login = (username, password) => dispatch({ method: 'POST', url: '/admin-login', body: { username, password } });

test.beforeEach(() => {
    users.clear();
    config.admin.passwordHash = null;
    writes.rows.length = 0;
    writes.admin.length = 0;
    writes.updateUser = 0;
    failRowWrite = false;
    finalized.length = 0;
    verifiedAgainst.length = 0;
});

test('an old bcrypt hash signs in and is replaced by an argon2id hash of the same password', async () => {
    const old = bcrypt.hashSync('Old-Bcrypt-1', 10);
    users.set('anna', { id: 'anna', displayName: 'Anna', role: 'user', passwordHash: old });

    const res = await login('anna', 'Old-Bcrypt-1');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(finalized.length, 1);
    assert.equal(finalized[0].password, 'Old-Bcrypt-1', 'finalizeLogin still gets the password for the DEK');

    assert.equal(writes.rows.length, 1);
    const stored = users.get('anna').passwordHash;
    assert.match(stored, /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    assert.equal(await realPasswords.verify('Old-Bcrypt-1', stored), true);
    assert.equal(writes.updateUser, 0, 'no updateUser: the password date must not move');

    // The next sign-in verifies against argon2id and writes nothing.
    const again = await login('anna', 'Old-Bcrypt-1');
    assert.equal(again.statusCode, 200);
    assert.equal(writes.rows.length, 1);
});

test('the built-in admin\'s bcrypt config hash (cost 12) is upgraded with its users row copy', async () => {
    const old = bcrypt.hashSync('Admin-Pass-123', 12);
    config.admin.passwordHash = old;
    users.set('admin', { id: 'admin', role: 'admin', passwordHash: old });

    const res = await login('admin', 'Admin-Pass-123');
    assert.equal(res.statusCode, 200);
    assert.equal(writes.admin.length, 1);
    assert.match(config.admin.passwordHash, /^\$argon2id\$/);
    assert.equal(users.get('admin').passwordHash, config.admin.passwordHash, 'the row follows the config');
    assert.equal(await realPasswords.verify('Admin-Pass-123', config.admin.passwordHash), true);
});

test('a wrong password answers the same 401 and stores nothing', async () => {
    const old = bcrypt.hashSync('Right-Pass-1', 10);
    users.set('bob', { id: 'bob', role: 'user', passwordHash: old });
    const res = await login('bob', 'Wrong-Pass-1');
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Invalid credentials' });
    assert.equal(users.get('bob').passwordHash, old);
    assert.equal(writes.rows.length, 0);
});

test('an argon2id hash signs in and is left as it is', async () => {
    const current = await realPasswords.hash('New-Argon-1');
    users.set('cleo', { id: 'cleo', role: 'user', passwordHash: current });
    const res = await login('cleo', 'New-Argon-1');
    assert.equal(res.statusCode, 200);
    assert.equal(users.get('cleo').passwordHash, current);
    assert.equal(writes.rows.length, 0);
    const wrong = await login('cleo', 'nope');
    assert.equal(wrong.statusCode, 401);
});

test('an unknown name spends a compare against an argon2id dummy with the same parameters', async () => {
    const res = await login('nobody-here', 'Whatever-1');
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Invalid credentials' });
    assert.equal(verifiedAgainst.length, 1, 'exactly one compare, as for a real account');
    const dummy = verifiedAgainst[0];
    assert.match(dummy, /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    assert.equal(realPasswords.needsRehash(dummy), false, 'same parameters as a stored hash');

    // A real (argon2id) account with a wrong password costs one compare too,
    // with the same parameters.
    users.set('dora', { id: 'dora', role: 'user', passwordHash: await realPasswords.hash('Dora-Pass-1') });
    verifiedAgainst.length = 0;
    const known = await login('dora', 'Whatever-1');
    assert.deepEqual([known.statusCode, known.body], [res.statusCode, res.body]);
    assert.equal(verifiedAgainst.length, 1);
    assert.equal(verifiedAgainst[0].split('$').slice(0, 4).join('$'), dummy.split('$').slice(0, 4).join('$'));
});

test('a failing upgrade write does not fail the sign-in', async () => {
    const old = bcrypt.hashSync('Still-Works-1', 10);
    users.set('eva', { id: 'eva', role: 'user', passwordHash: old });
    failRowWrite = true;
    const res = await login('eva', 'Still-Works-1');
    assert.equal(res.statusCode, 200);
    assert.equal(users.get('eva').passwordHash, old);
});

test('a hash changed in between is not overwritten by the upgrade', async () => {
    const old = bcrypt.hashSync('Race-Pass-1', 10);
    const row = { id: 'finn', role: 'user', passwordHash: old };
    users.set('finn', row);
    // The stored row moves on (a reset) after the login read it.
    const realGet = userStoreDouble.getUser;
    userStoreDouble.getUser = async (id) => {
        const snapshot = { ...(await realGet(id)) };
        row.passwordHash = 'NEWER-HASH-FROM-A-RESET';
        return snapshot;
    };
    try {
        const res = await login('finn', 'Race-Pass-1');
        assert.equal(res.statusCode, 200);
        assert.equal(row.passwordHash, 'NEWER-HASH-FROM-A-RESET');
    } finally {
        userStoreDouble.getUser = realGet;
    }
});
