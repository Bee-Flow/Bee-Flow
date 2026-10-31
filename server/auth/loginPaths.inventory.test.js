'use strict';

/**
 * Every login path says what it does about a second factor.
 *
 * auth/loginPaths.js finds each call of establishSession in the source;
 * auth/loginPaths.inventory.json lists them with `mfa: enforced`,
 * `not-applicable:<why>` or `pending`. A call site the inventory does not know
 * is red: a new login path cannot land without saying where its MFA step is.
 * An entry whose call site is gone is red too, so the list stays true. The
 * number of `pending` entries is pinned by `pendingAllowed`, which equals that
 * number and may only go down.
 *
 * Run: cd server && node --test auth/loginPaths.inventory.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { scanLoginPaths, callSitesIn } = require('./loginPaths');
const inventory = require('./loginPaths.inventory.json');

const sites = scanLoginPaths();
const listed = Object.keys(inventory.paths);

test('the scan sees the login code', () => {
    assert.ok(sites.length >= 8, `suspiciously few establishSession call sites (${sites.length})`);
    assert.ok(sites.some((s) => s.file === 'auth/login/finalizeLogin.js'), 'the password login is missing from the scan');
});

test('every establishSession call site is in the inventory', () => {
    const unknown = sites.filter((s) => !inventory.paths[s.key]).map((s) => `${s.key} (line ${s.line})`);
    assert.deepEqual(unknown, [],
        `login paths not in auth/loginPaths.inventory.json:\n  ${unknown.join('\n  ')}\n` +
        'Add the entry with mfa: "enforced" (and say where the second-factor step runs), ' +
        '"not-applicable:<why there is no second factor here>", or, for a known gap, "pending" (and raise pendingAllowed in the same commit, with the reason).');
});

test('every inventory entry still has its call site', () => {
    const present = new Set(sites.map((s) => s.key));
    const stale = listed.filter((k) => !present.has(k));
    assert.deepEqual(stale, [], `inventory entries whose call site is gone or renamed: ${stale.join(', ')}`);
});

test('every entry says what it does about MFA, in one of the three shapes', () => {
    for (const [key, entry] of Object.entries(inventory.paths)) {
        const ok = entry.mfa === 'enforced' || entry.mfa === 'pending'
            || (entry.mfa.startsWith('not-applicable:') && entry.mfa.length >= 'not-applicable:'.length + 30);
        assert.ok(ok, `${key}: mfa must be "enforced", "pending" or "not-applicable:<a reason of at least 30 characters>", got ${JSON.stringify(entry.mfa)}`);
        assert.ok(typeof entry.note === 'string' && entry.note.length >= 15, `${key}: note is too thin`);
    }
});

test('the pending count is pinned and only goes down', () => {
    const pending = listed.filter((k) => inventory.paths[k].mfa === 'pending');
    assert.equal(pending.length, inventory.pendingAllowed,
        `pendingAllowed is ${inventory.pendingAllowed} but ${pending.length} entries are pending (${pending.join(', ')}): ` +
        'set pendingAllowed to the real number; a closed gap lowers it, a new one is a deliberate commit that raises it with a reason');
});

test('synthetic: a call site is keyed by audit method and extra keys, and a second identical one gets a suffix', () => {
    const src = `
        async function a(req) {
            await establishSession(req, { user, isAdmin, extra: { encryptionKey: k, pendingApproval: true }, audit: { method: 'password' } });
            await establishSession(req, { user, audit: { method: 'password' } });
            await establishSession(req, { user, audit: { method: 'password' } });
            await auth.establishSession(req, { user, audit: { method: provider } });
            await establishSession(req, { user, audit: { method: \`oauth:\${provider}\` } });
            await establishSession(req, { user });
        }`;
    assert.deepEqual(callSitesIn(src, 'x.js').map((s) => s.key), [
        'x.js#password{encryptionKey,pendingApproval}',
        'x.js#password{}',
        'x.js#password{}#2',
        'x.js#$provider{}',
        'x.js#oauth:${}{}',
        'x.js#unknown{}',
    ]);
});
