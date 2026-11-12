'use strict';

/**
 * The starting encryption tier on a real database (PGlite): a NEW organisation
 * starts on the default tier (managed unless BEEFLOW_DEFAULT_ENCRYPTION_TIER
 * says otherwise), and an organisation that already exists keeps the tier it
 * has, through a restart (the boot migrations run again) and through ordinary
 * settings edits.
 *
 * Run: cd server && node --test stores/initialTier.pg.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'initial-tier-test-session-secret-0123456789';
process.env.MASTER_ENCRYPTION_KEY ??= 'ci-master-encryption-key-for-tests-only!!';

const { usePglitePool } = require('../testUtils/pglitePool');
const { query, close: closePg } = usePglitePool();

// Encryption is a licence feature; these orgs are entitled, so readiness and the default decide.
const license = require('../license/index');
const originalHasFeature = license.hasFeature;
license.hasFeature = async (_ctx, feature) => feature === 'encryption' || originalHasFeature(_ctx, feature);

const userStore = require('./userStore');
const { invalidatePolicyCache } = require('./encryptionPolicy');

const prevDefault = process.env.BEEFLOW_DEFAULT_ENCRYPTION_TIER;
/** @param {string | undefined} value */
function setDefault(value) {
    if (value === undefined) delete process.env.BEEFLOW_DEFAULT_ENCRYPTION_TIER;
    else process.env.BEEFLOW_DEFAULT_ENCRYPTION_TIER = value;
}

/** @param {string} orgId */
async function tierOf(orgId) {
    const r = await query('SELECT encryption_tier FROM organizations WHERE id = $1', [orgId]);
    return r.rows[0] ? r.rows[0].encryption_tier : null;
}

test.before(async () => { await userStore.initDB(); }, { timeout: 120_000 });

test.after(async () => {
    license.hasFeature = originalHasFeature;
    setDefault(prevDefault);
    await closePg();
});

test('a new organisation starts on managed when nothing is configured', async () => {
    setDefault(undefined);
    await userStore.createOrganization({ id: 'org-tier-new', name: 'New org' }, { autoGrantTrial: false });
    assert.equal(await tierOf('org-tier-new'), 'managed');
});

test('BEEFLOW_DEFAULT_ENCRYPTION_TIER=off keeps a new organisation unencrypted', async () => {
    setDefault('off');
    await userStore.createOrganization({ id: 'org-tier-off', name: 'Off org' }, { autoGrantTrial: false });
    assert.equal(await tierOf('org-tier-off'), 'none');
});

test('an organisation that is off stays off: after a restart and after a settings edit', async () => {
    setDefault('off');
    await userStore.createOrganization({ id: 'org-tier-kept', name: 'Existing org' }, { autoGrantTrial: false });
    assert.equal(await tierOf('org-tier-kept'), 'none');

    // The server is upgraded and starts with the new built-in default.
    setDefault(undefined);
    await userStore.initDB();
    invalidatePolicyCache('org-tier-kept');
    assert.equal(await tierOf('org-tier-kept'), 'none', 'the boot migrations leave an existing tier alone');

    assert.notEqual(await userStore.updateOrganization('org-tier-kept', { description: 'edited' }), false);
    assert.equal(await tierOf('org-tier-kept'), 'none', 'a settings edit leaves the tier alone');
});
