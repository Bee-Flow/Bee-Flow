/**
 * Every path that installs a login credential must date it — enforced.
 *
 * `password_changed_at` is stamped in exactly one place: isNewCredential in
 * stores/user/users.js, which createUser, createUserWithSeatCheck and updateUser
 * all consult. That design is only worth anything as long as no route grows its
 * own way of storing a password, so this test pins the shape of the tree rather
 * than the behaviour (users.accountFields.test.js covers the behaviour):
 *
 *   1. every file that hashes a password is declared here, with what it is;
 *   2. every declared count matches, so a SECOND hash in a known file is red too;
 *   3. every credential-writing file reaches the database through a choke-point
 *      function, never a hand-written INSERT/UPDATE that would bypass the stamp;
 *   4. the two places that copy an EXISTING hash into the users table still say
 *      `credentialUnchanged: true`, and the SSO encryption PIN still does not
 *      pretend to be a password change;
 *   5. nothing outside the store and the documented OPAQUE exception sets the
 *      date by hand.
 *
 * A new password route that lands in none of these lists is a RED TEST with a
 * pointer, not a field that quietly stays empty on somebody's security screen.
 *
 * Static and DB-free on purpose, like organizations.configKeys.test.js.
 *
 * Run: cd server && node --test --test-force-exit auth/passwordChangedAt.paths.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'vendor', 'uploads', 'data', 'logs']);

/** The three store functions that consult isNewCredential. */
const CHOKE_POINTS = /\b(createUserWithSeatCheck|createUser|updateUser)\s*\(/;

/**
 * Every `bcrypt.hash(` in the tree, declared.
 *
 * `kind: 'credential'` — this becomes somebody's login secret, so the write has
 * to travel through a choke point and gets dated.
 * `kind: 'not-a-credential'` — it is a hash, but not one anybody signs in with;
 * dating it would be a lie. The reason is the entry.
 */
const HASH_SITES = new Map([
    ['auth/login/signupRoutes.js', {
        count: 1, kind: 'credential',
        why: 'public registration and invite accept — the only signup write path.',
    }],
    ['auth/admin/userRoutes.js', {
        count: 3, kind: 'credential',
        why: 'admin creates an account; admin edits a password (self-change with '
            + 'oldPassword, destructive reset without); self-service change-password.',
    }],
    ['auth/login/passwordResetRoutes.js', {
        count: 1, kind: 'credential',
        why: 'the e-mailed reset link — the mailbox owner sets a new password.',
    }],
    ['auth/login/setupRoutes.js', {
        count: 1, kind: 'credential',
        why: 'first-run setup of the built-in admin (cost 12), stored in config AND '
            + 'in the users row.',
    }],
    ['boot-init.js', {
        count: 1, kind: 'credential',
        why: 'ADMIN_PASSWORD bootstrap on a fresh install; only when no hash exists yet.',
    }],
    ['auth/login/passwordLoginRoutes.js', {
        count: 1, kind: 'not-a-credential',
        why: 'a throwaway hash compared against on unknown usernames so that login '
            + 'timing does not leak whether an account exists. It is never stored.',
    }],
    ['auth/mfa.js', {
        count: 1, kind: 'not-a-credential',
        why: 'MFA recovery codes. A second factor is not a password, and burning one '
            + 'must not read as "you changed your password".',
    }],
]);

/**
 * Password-equivalents that are not bcrypt at all.
 *
 * An opaque_v1 account signs in with its `opaqueRecord`; there is no hash for the
 * store rule to see, so that one route dates itself and says why.
 */
const OPAQUE_ROUTES = 'auth/opaqueRoutes.js';

/**
 * The writes that touch `passwordHash` without changing anybody's credential.
 * Each must keep saying so at the call site.
 */
const CREDENTIAL_UNCHANGED = [
    ['auth/login/finalizeLogin.js', 'materialises the built-in admin row at login from the config hash'],
    ['auth/mfaRoutes.js', 'materialises the same row when enrolling the built-in admin in MFA'],
];

/** Files allowed to name the date field directly. */
const MAY_SET_THE_DATE = new Set([
    'stores/user/users.js',   // the choke point itself
    OPAQUE_ROUTES,            // the documented exception: its credential is not a hash
]);

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walk(path.join(dir, entry.name), out);
        } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}

const sources = new Map(
    walk(SERVER_ROOT).map(f => [path.relative(SERVER_ROOT, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')]),
);

function countOf(src, re) {
    return (src.match(re) || []).length;
}

test('every file that hashes a password is declared, and no declaration is stale', () => {
    const found = [...sources].filter(([, src]) => /bcrypt\.hash\s*\(/.test(src)).map(([rel]) => rel).sort();
    const declared = [...HASH_SITES.keys()].sort();

    const undeclared = found.filter(f => !HASH_SITES.has(f));
    assert.deepEqual(undeclared, [],
        'A new password path. Add it to HASH_SITES and say what it is: a real '
        + 'credential (then it must reach the store through createUser/updateUser, '
        + 'which dates it) or not one (then say why dating it would be wrong).');

    const gone = declared.filter(f => !found.includes(f));
    assert.deepEqual(gone, [], 'these files no longer hash anything — drop the entry');
});

test('the number of hashes per file is pinned, so a second one cannot slip in', () => {
    for (const [rel, decl] of HASH_SITES) {
        const actual = countOf(sources.get(rel), /bcrypt\.hash\s*\(/g);
        assert.equal(actual, decl.count,
            `${rel} hashes ${actual}× but is declared as ${decl.count}×. A new site in a `
            + 'known file needs the same decision as a new file.');
    }
});

test('every declaration carries a reason worth reading', () => {
    for (const [rel, decl] of HASH_SITES) {
        assert.ok(decl.why && decl.why.length > 30, `${rel}: an empty reason is as good as no entry`);
        assert.ok(['credential', 'not-a-credential'].includes(decl.kind), `${rel}: unknown kind`);
    }
});

test('credential writes reach the database through a choke point, never around it', () => {
    for (const [rel, decl] of HASH_SITES) {
        if (decl.kind !== 'credential') continue;
        const src = sources.get(rel);
        assert.match(src, CHOKE_POINTS,
            `${rel} hashes a password but never calls createUser/createUserWithSeatCheck/`
            + 'updateUser. A hand-written INSERT or UPDATE bypasses isNewCredential and '
            + 'leaves the account with no password date.');
        // Hand-written SQL against `users` is fine in itself (clearing an
        // avatar, say); a hand-written write of the hash COLUMN is not, because
        // that is the one that would skip the stamp. The column is always
        // quoted in SQL — it is camelCase legacy.
        for (const m of src.matchAll(/(?:INSERT\s+INTO\s+users|UPDATE\s+users\s+SET)/gi)) {
            const statement = src.slice(m.index, m.index + 400);
            assert.ok(!statement.includes('"passwordHash"'),
                `${rel} writes "passwordHash" with its own SQL, around:\n  ${statement.split('\n')[0]}\n`
                + 'That bypasses isNewCredential and leaves the account with no password date.');
        }
    }
});

test('a hash that is never stored stays out of the store', () => {
    const login = sources.get('auth/login/passwordLoginRoutes.js');
    assert.ok(!/updateUser\s*\([^)]*passwordHash/.test(login),
        'the timing-equalising dummy hash must never be written to a user row');
});

test('copying an existing hash into the users row does not claim a password change', () => {
    for (const [rel, what] of CREDENTIAL_UNCHANGED) {
        const src = sources.get(rel);
        assert.ok(src, `${rel} is gone — has ${what} moved?`);
        assert.match(src, /createUser\s*\(/, `${rel}: ${what}`);
        assert.match(src, /credentialUnchanged:\s*true/,
            `${rel} ${what}. Without credentialUnchanged the store dates it, and the security `
            + 'screen would report a months-old password as changed today.');
        assert.ok(!/bcrypt\.hash\s*\(/.test(src),
            `${rel} must keep copying the config hash rather than making a new one`);
    }
});

test('the OPAQUE account registration dates itself; the SSO encryption PIN does not', () => {
    const src = sources.get(OPAQUE_ROUTES);
    const pinAt = src.indexOf("'/pin/register/finish'");
    assert.ok(pinAt > 0, 'the PIN registration route moved — recheck this split');

    const beforePin = src.slice(0, pinAt);
    const fromPin = src.slice(pinAt);

    assert.match(beforePin, /passwordChangedAt/,
        '/opaque/register/finish writes the credential an opaque_v1 account signs in with, '
        + 'so it has to date it — there is no bcrypt hash for the store rule to notice.');
    assert.ok(!/passwordChangedAt/.test(fromPin),
        'the SSO encryption PIN is not a login password; dating it would put "password '
        + 'changed today" on the screen of somebody who has never had one.');
});

test('nothing outside the store and that one exception sets the date by hand', () => {
    const offenders = [...sources]
        .filter(([rel, src]) => !MAY_SET_THE_DATE.has(rel) && /passwordChangedAt|password_changed_at/.test(src))
        // The schema declares the column; that is not a write.
        .filter(([rel]) => rel !== 'stores/user/schema.js')
        .map(([rel]) => rel);

    assert.deepEqual(offenders, [],
        'The date is decided in one place so that adding a password route cannot forget it. '
        + 'If a new path genuinely has no hash for the rule to see (as OPAQUE does not), add it '
        + 'to MAY_SET_THE_DATE with the reason at the call site.');
});
