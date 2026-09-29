/**
 * Every way into a session asks the account-status gate.
 *
 * This is the test the defect needed. Suspending an account did nothing,
 * because the status check lived on ONE of four login-completion paths and
 * nothing said the other three were missing it. A unit test on the gate would
 * have passed the whole time — the gate was never the problem, its absence was.
 *
 * So this file tests the SET of call sites, not the logic:
 *
 *   1. the four known paths each consult the gate before writing a session;
 *   2. a FIFTH path cannot appear unnoticed — every file that calls
 *      establishSession() as part of signing someone in must be on the list
 *      below, and the list is checked against the tree;
 *   3. the gate itself has no exemption argument, so no caller can opt out.
 *
 * (2) is the part that keeps working after everyone here has forgotten this
 * bug: add a new SSO provider, forget the gate, and this goes red naming your
 * file.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// This file lives in server/auth/, and every path below is relative to it.
const AUTH = __dirname;
const REPO = path.resolve(AUTH, '../..');
const read = (rel) => fs.readFileSync(path.join(AUTH, rel), 'utf8');

/**
 * The four paths that complete a sign-in, each with the reason it counts.
 * Adding a path here without adding the gate fails the first test; adding one
 * to the tree without listing it here fails the second.
 */
const LOGIN_COMPLETION_PATHS = [
    ['login/finalizeLogin.js', 'password and MFA'],
    ['opaqueRoutes.js', 'OPAQUE (zero-knowledge password)'],
    ['oauth/providerCallbackRoutes.js', 'OAuth / SSO callback'],
    ['oauth/nextcloudLegacyRoutes.js', 'Nextcloud legacy callback'],
];

/**
 * Files that call establishSession() but are NOT completing a login, with the
 * reason. Kept explicit so the sweep below stays honest: an entry here is a
 * decision somebody wrote down, not a file that quietly fell out of the regex.
 */
const NOT_A_LOGIN = new Map([
    ['establishSession.js', 'the helper itself'],
    ['login/signupRoutes.js', 'account creation — a brand-new row cannot already be suspended'],
]);

test('every login-completion path consults the account-status gate', () => {
    for (const [rel, why] of LOGIN_COMPLETION_PATHS) {
        const src = read(rel);
        assert.match(
            src,
            /isLoginBlockedAccount\(/,
            `${rel} (${why}) completes a sign-in without asking the account-status gate. `
            + 'That is exactly how suspending an account stopped meaning anything.',
        );
        assert.match(
            src,
            /require\('\.{1,2}\/?(\.\.\/)?accountStatusGate'\)/,
            `${rel} references the gate but does not require the shared module — a second copy `
            + 'of an access-control rule is how three of them go out of date.',
        );
    }
});

test('no fifth path establishes a session without being accounted for', () => {
    // git grep, so the sweep sees the tracked tree rather than whatever happens
    // to be on disk.
    const out = execFileSync(
        'git',
        ['grep', '-l', 'establishSession(', '--', 'server/auth/'],
        { cwd: REPO, encoding: 'utf8' },
    );
    const files = out.split('\n').filter(Boolean)
        .map((f) => f.replace(/^server\/auth\//, ''))
        .filter((f) => !f.includes('.test.'));

    const known = new Set([...LOGIN_COMPLETION_PATHS.map(([f]) => f), ...NOT_A_LOGIN.keys()]);
    const unaccounted = files.filter((f) => !known.has(f));

    assert.deepStrictEqual(
        unaccounted,
        [],
        'these files establish a session and are on neither list. If one of them completes a '
        + 'sign-in it needs the account-status gate; if it does not, say so in NOT_A_LOGIN with '
        + 'the reason:\n' + unaccounted.join('\n'),
    );
});

test('the gate takes no argument that could weaken it', () => {
    const { isLoginBlockedAccount } = require('./accountStatusGate');
    assert.strictEqual(
        isLoginBlockedAccount.length,
        1,
        'isLoginBlockedAccount grew a second parameter. The other status gates carry founder and '
        + 'admin exemptions because they gate people on the way IN; suspended is a decision about '
        + 'somebody who already had access, and an exemption there means "you may suspend anyone '
        + 'except the people most worth suspending".',
    );
});

test('a suspended row is blocked, and the ordinary ones are not', () => {
    const { isLoginBlockedAccount } = require('./accountStatusGate');
    assert.strictEqual(isLoginBlockedAccount({ status: 'suspended' }), true);
    assert.strictEqual(isLoginBlockedAccount({ status: 'active' }), false);
    assert.strictEqual(isLoginBlockedAccount({ status: 'pending' }), false, 'pending has its own gate with its own exemptions');
    // A row from before the column existed is active — the same reading
    // orgAdminGuards.isActiveUserStatus uses.
    assert.strictEqual(isLoginBlockedAccount({}), false);
    // And a missing row is not a blocked account: "no such user" is the
    // caller's business, and answering true here would turn an absent row into
    // a *specific* refusal shape.
    assert.strictEqual(isLoginBlockedAccount(null), false);
    assert.strictEqual(isLoginBlockedAccount(undefined), false);
});

test('the suspended refusal is shaped like a wrong password', () => {
    const { REFUSAL } = require('./accountStatusGate');
    assert.strictEqual(REFUSAL.status, 401);
    assert.deepStrictEqual(REFUSAL.body, { error: 'Invalid credentials' });
    // Anything more specific tells a caller holding a working password that
    // this account exists and was singled out.
    assert.ok(
        !/suspend/i.test(JSON.stringify(REFUSAL)),
        'the refusal names the reason, which confirms the account exists',
    );
});

test('the password path pads the refusal to the failure floor', () => {
    // Without this a suspended account answers instantly while a wrong password
    // takes 450ms, and the difference is readable from outside.
    const src = read('login/finalizeLogin.js');
    const gateAt = src.indexOf('isLoginBlockedAccount(');
    const padAt = src.indexOf('padFailureResponse(', gateAt);
    const returnAt = src.indexOf('REFUSAL.body', gateAt);
    assert.ok(gateAt > -1, 'no gate in finalizeLogin');
    assert.ok(padAt > -1 && padAt < returnAt, 'the refusal returns without waiting for the floor');
    assert.match(
        src,
        /startedAt = Date\.now\(\)/,
        'finalizeLogin no longer accepts the caller\'s start timestamp, so the floor it applies is '
        + 'measured from the wrong moment',
    );
});
