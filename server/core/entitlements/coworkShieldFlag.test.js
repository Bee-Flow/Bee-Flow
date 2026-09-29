/**
 * CW-10 cowork-shield flag — default OFF, and provably so.
 *
 * The claims-on-screen rule for this release: every privacy claim must have a
 * test that shows the claim absent/off under the no-configuration state.
 * These tests pin exactly that for the flag that will back the "Privacy
 * shield on" pill on non-agent runs:
 *   - MISSING config ⇒ { enabled:false, configured:false } — an existing org
 *     (and its scheduled Routines, which share this path) keeps today's
 *     behaviour and no pill can claim protection;
 *   - only an explicit true enables it;
 *   - a config-store failure reads as OFF without throwing — no claim while
 *     the flag is unreadable (the shield's own fail-CLOSED rules apply only
 *     once the flag is on; that enforcement lands with the consumer).
 *
 * Run: cd server && node --test --test-force-exit core/entitlements/coworkShieldFlag.test.js
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
    resolveCoworkShieldFlag,
    isCoworkShieldEnabled,
    invalidateCoworkShieldFlag,
    normalizeCoworkShieldFlag,
    coworkShieldConfigKey,
    CONFIG_KEY_PREFIX,
} = require('./coworkShieldFlag');

const ORG = 'org_cw10';

beforeEach(() => {
    for (const k of Object.keys(blobs)) delete blobs[k];
    throwOnRead = false;
    reads = 0;
    invalidateCoworkShieldFlag(ORG);
});

test('missing config resolves OFF and unconfigured — the no-configuration state claims nothing', async () => {
    assert.deepStrictEqual(await resolveCoworkShieldFlag(ORG), { enabled: false, configured: false });
    assert.strictEqual(await isCoworkShieldEnabled(ORG), false);
    assert.deepStrictEqual(await resolveCoworkShieldFlag(null), { enabled: false, configured: false },
        'personal accounts: no org, no shield claim');
});

test('only an explicit true enables; everything else is off', () => {
    assert.strictEqual(normalizeCoworkShieldFlag(true).enabled, true);
    assert.strictEqual(normalizeCoworkShieldFlag({ enabled: true }).enabled, true);
    for (const v of [null, undefined, false, 0, 'true', 'on', {}, { enabled: 'yes' }, { enabled: 1 }, { required: true }, []]) {
        assert.strictEqual(normalizeCoworkShieldFlag(v).enabled, false, `expected off for ${JSON.stringify(v)}`);
    }
});

test('configured distinguishes "explicitly off" from "never set"', () => {
    assert.deepStrictEqual(normalizeCoworkShieldFlag({ enabled: false }), { enabled: false, configured: true });
    assert.deepStrictEqual(normalizeCoworkShieldFlag(null), { enabled: false, configured: false });
});

test('an enabled row resolves on', async () => {
    blobs[coworkShieldConfigKey(ORG)] = { enabled: true, updatedBy: 'admin' };
    assert.deepStrictEqual(await resolveCoworkShieldFlag(ORG), { enabled: true, configured: true });
    assert.strictEqual(await isCoworkShieldEnabled(ORG), true);
});

test('a config-store failure reads as OFF and does not throw', async () => {
    throwOnRead = true;
    const flag = await resolveCoworkShieldFlag(ORG);
    assert.strictEqual(flag.enabled, false,
        'an unreadable flag must never surface as an active shield claim');
});

test('resolution is memoised and invalidate busts it', async () => {
    assert.strictEqual((await resolveCoworkShieldFlag(ORG)).enabled, false);
    const after = reads;
    blobs[coworkShieldConfigKey(ORG)] = { enabled: true };
    assert.strictEqual((await resolveCoworkShieldFlag(ORG)).enabled, false, 'within the TTL the memo answers');
    assert.strictEqual(reads, after, 'no store read on a memo hit');
    invalidateCoworkShieldFlag(ORG);
    assert.strictEqual((await resolveCoworkShieldFlag(ORG)).enabled, true);
});

test('the key prefix is the documented one', () => {
    assert.strictEqual(CONFIG_KEY_PREFIX, 'org_cowork_shield_');
    assert.strictEqual(coworkShieldConfigKey('x'), 'org_cowork_shield_x');
});
