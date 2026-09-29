/**
 * A3 org-MFA duty — the flag that must NEVER read missing as true.
 *
 * The contract these tests pin:
 *   - a MISSING or malformed value is FALSE (the platform flag reads missing
 *     as true; copying that `?? true` here would force MFA onto every org on
 *     deploy — the exact "silently gains something" failure U10 exists to
 *     prevent);
 *   - only an explicit true / {required:true} enables the duty;
 *   - a config-store failure degrades to false (platform flag stays the
 *     backstop) and never throws into /auth/user.
 *
 * The read side in currentUserRoutes — the OR with the platform flag and the
 * SSO exemption that follows it — is covered end to end in
 * auth/login/currentUserRoutes.mfa.test.js, which drives GET /auth/user with
 * the real flag module behind stubbed stores. It used to be restated here as
 * regexes over that file; every one of those claims is a case over there.
 *
 * Run: cd server && node --test --test-force-exit core/entitlements/orgMfaRequired.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// ── configStore stub via the require.cache seam (house pattern) ────────────
const blobs = {};
let throwOnRead = false;
let reads = 0;
const configStoreStub = {
    async getConfig(key) {
        reads++;
        if (throwOnRead) throw new Error('boom');
        return blobs[key] !== undefined ? blobs[key] : null;
    },
};
const csPath = require.resolve('../../stores/configStore');
require.cache[csPath] = { id: csPath, filename: csPath, loaded: true, exports: configStoreStub };

const {
    resolveOrgMfaRequired,
    invalidateOrgMfaRequired,
    normalizeOrgMfaRequired,
    orgMfaConfigKey,
    CONFIG_KEY_PREFIX,
} = require('./orgMfaRequired');

const ORG = 'org_a3';

beforeEach(() => {
    for (const k of Object.keys(blobs)) delete blobs[k];
    throwOnRead = false;
    reads = 0;
    invalidateOrgMfaRequired(ORG);
});

test('every absent-ish stored value reads as FALSE — never `?? true`', async () => {
    assert.strictEqual(await resolveOrgMfaRequired(ORG), false,
        'an org that never configured the duty must behave exactly as before this release');

    // The `?? true` this module must not copy from the platform flag would
    // only show on a store that answers with a nullish value, so drive the
    // real resolution once per shape a store can hand back.
    for (const stored of [null, undefined, false, 0, '', 'true', {}, { required: false }, { required: 'yes' }, { enabled: true }, []]) {
        invalidateOrgMfaRequired(ORG);
        blobs[orgMfaConfigKey(ORG)] = stored;
        assert.strictEqual(await resolveOrgMfaRequired(ORG), false,
            `a stored ${JSON.stringify(stored) ?? 'undefined'} must not enable the duty`);
    }
});

test('only an explicit true enables the duty', async () => {
    assert.strictEqual(normalizeOrgMfaRequired(true), true);
    assert.strictEqual(normalizeOrgMfaRequired({ required: true }), true);
    // Everything that is not an explicit true is false — strictness is the
    // security property here, in BOTH directions (no accidental enforcement,
    // no accidental exemption of the platform flag, which is OR'd anyway).
    for (const v of [null, undefined, false, 0, 1, 'true', 'on', {}, { required: 'yes' }, { required: 1 }, { enabled: true }, []]) {
        assert.strictEqual(normalizeOrgMfaRequired(v), false, `expected false for ${JSON.stringify(v)}`);
    }
});

test('a stored {required:true} row resolves true; no org resolves false', async () => {
    blobs[orgMfaConfigKey(ORG)] = { required: true };
    assert.strictEqual(await resolveOrgMfaRequired(ORG), true);
    assert.strictEqual(await resolveOrgMfaRequired(null), false, 'consumer accounts have no org duty');
    assert.strictEqual(await resolveOrgMfaRequired(''), false);
});

test('a config-store failure degrades to false and does not throw', async () => {
    throwOnRead = true;
    assert.strictEqual(await resolveOrgMfaRequired(ORG), false,
        'the platform flag (missing⇒ON) remains the backstop; the org flag only ever ADDS the duty');
});

test('resolution is memoised and invalidate busts it', async () => {
    assert.strictEqual(await resolveOrgMfaRequired(ORG), false);
    const after = reads;
    blobs[orgMfaConfigKey(ORG)] = { required: true };
    assert.strictEqual(await resolveOrgMfaRequired(ORG), false, 'within the TTL the memo answers');
    assert.strictEqual(reads, after, 'no store read on a memo hit');
    invalidateOrgMfaRequired(ORG);
    assert.strictEqual(await resolveOrgMfaRequired(ORG), true, 'after invalidate the new value applies');
});

test('the key prefix is the documented one', () => {
    assert.strictEqual(CONFIG_KEY_PREFIX, 'org_mfa_required_');
    assert.strictEqual(orgMfaConfigKey('x'), 'org_mfa_required_x');
});
