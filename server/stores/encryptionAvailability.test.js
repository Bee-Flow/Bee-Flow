const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

process.env.NODE_ENV = 'test';

// Stand in for the licence layer so entitlement can be driven from the test.
let entitledOrgs = new Set();
require.cache[require.resolve(path.join(__dirname, '..', 'license'))] = {
    id: 'lic-mock', filename: 'lic-mock', loaded: true,
    exports: {
        async hasFeature(scope, feature) {
            if (feature !== 'encryption') return false;
            const orgId = typeof scope === 'string' ? scope : scope?.organizationId;
            return entitledOrgs.has(orgId);
        },
    },
};

// Stand in for the organizations table so the org's CHOSEN tier can be driven
// from the test. resolvePolicy reads exactly these two columns, lazily, so the
// cache entry only has to exist before the first call.
let orgTiers = new Map(); // orgId -> encryption_tier
require.cache[require.resolve(path.join(__dirname, '..', 'db'))] = {
    id: 'db-mock', filename: 'db-mock', loaded: true,
    exports: {
        async getOne(_sql, params) {
            const orgId = params && params[0];
            if (!orgTiers.has(orgId)) return null;
            return { encryption_tier: orgTiers.get(orgId), encryption_scope: null };
        },
    },
};

const {
    isOrgEntitled, tierReadiness, getEncryptionAvailability, NOT_ENTITLED_REASON,
} = require('./encryptionAvailability');
const { invalidatePolicyCache } = require('./encryptionPolicy');

// Awaits fn before restoring — a sync try/finally would put the environment
// back the moment an async fn hit its first await, which silently defeats the
// whole point of the helper.
async function withEnv(vars, fn) {
    const prev = {};
    for (const [k, v] of Object.entries(vars)) {
        prev[k] = process.env[k];
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { return await fn(); } finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

test.beforeEach(() => {
    entitledOrgs = new Set();
    orgTiers = new Map();
    // resolvePolicy memoises per org for 30s, which would carry one case's
    // tier into the next.
    invalidatePolicyCache();
});

// ── Entitlement ─────────────────────────────────────────────────────────────

test('an org with no id is never entitled', async () => {
    assert.strictEqual(await isOrgEntitled(null), false);
    assert.strictEqual(await isOrgEntitled(''), false);
});

test('entitlement follows the licence layer', async () => {
    assert.strictEqual(await isOrgEntitled('org-a'), false);
    entitledOrgs.add('org-a');
    assert.strictEqual(await isOrgEntitled('org-a'), true);
    assert.strictEqual(await isOrgEntitled('org-b'), false, 'entitlement must not leak across orgs');
});

// ── Readiness (pure environment) ────────────────────────────────────────────

test("'none' is always ready", async () => {
    await withEnv({ MASTER_ENCRYPTION_KEY: undefined, OPAQUE_SERVER_SETUP: undefined }, () => {
        assert.strictEqual(tierReadiness().none.ready, true);
    });
});

test("'managed' is not ready without a master key, and says which one", async () => {
    await withEnv({ MASTER_ENCRYPTION_KEY: undefined }, () => {
        const r = tierReadiness().managed;
        assert.strictEqual(r.ready, false);
        assert.deepStrictEqual(r.missing, ['MASTER_ENCRYPTION_KEY']);
        assert.match(r.reason, /master key/i);
    });
});

test("'managed' is ready with a master key", async () => {
    await withEnv({ MASTER_ENCRYPTION_KEY: 'x'.repeat(32) }, () => {
        const r = tierReadiness().managed;
        assert.strictEqual(r.ready, true);
        assert.deepStrictEqual(r.missing, []);
    });
});

test("'zk' does NOT require OPAQUE — it warns instead", async () => {
    // zk derives the DEK through the legacy Argon2 login path; OPAQUE is a
    // separate, stronger login mode. Blocking on it would be wrong.
    await withEnv({ OPAQUE_SERVER_SETUP: undefined }, () => {
        const r = tierReadiness().zk;
        assert.strictEqual(r.ready, true, 'zk must remain selectable without OPAQUE');
        assert.deepStrictEqual(r.missing, []);
        assert.deepStrictEqual(r.warnings, ['OPAQUE_SERVER_SETUP']);
        assert.match(r.warningReason, /restart/i);
    });
});

test("'zk' carries no warning once OPAQUE is configured", async () => {
    await withEnv({ OPAQUE_SERVER_SETUP: 'y'.repeat(171) }, () => {
        const r = tierReadiness().zk;
        assert.deepStrictEqual(r.warnings, []);
        assert.strictEqual(r.warningReason, null);
    });
});

// The boot check in auth/opaqueSetup.js caches whether the OPAQUE library can
// read the configured value. A stand-in library keeps this file WASM-free; the
// real-library verdicts are pinned in auth/opaqueSetup.test.js.
const opaqueSetup = require('../auth/opaqueSetup');
const quiet = { error() {} };
const fakeOpaque = (readable) => ({
    ready: Promise.resolve(),
    client: { startRegistration: () => ({ registrationRequest: 'req' }) },
    server: {
        createRegistrationResponse: () => {
            if (!readable) throw new Error('opaque protocol error at "deserialize serverSetup"');
            return { registrationResponse: 'resp' };
        },
    },
});

test("'zk' warns, in its own words, when OPAQUE_SERVER_SETUP is set but unreadable", async () => {
    opaqueSetup._resetForTests();
    try {
        await withEnv({ OPAQUE_SERVER_SETUP: 'A'.repeat(192) }, async () => {
            await opaqueSetup.validateServerSetup({ opaqueLib: fakeOpaque(false), log: quiet });
            const r = tierReadiness().zk;
            // Still ready: zk runs on the legacy Argon2 path and the SPA falls
            // back to it, and a blocker would start new orgs on 'none'.
            assert.strictEqual(r.ready, true);
            assert.deepStrictEqual(r.missing, []);
            assert.deepStrictEqual(r.warnings, ['OPAQUE_SERVER_SETUP']);
            assert.match(r.warningReason, /set but cannot be read/);
            assert.ok(!r.warningReason.includes('AAAA'), 'the value never reaches the UI');
        });
    } finally {
        opaqueSetup._resetForTests();
    }
});

test("'zk' carries no warning once the configured setup has been read successfully", async () => {
    opaqueSetup._resetForTests();
    try {
        await withEnv({ OPAQUE_SERVER_SETUP: 'y'.repeat(171) }, async () => {
            await opaqueSetup.validateServerSetup({ opaqueLib: fakeOpaque(true), log: quiet });
            const r = tierReadiness().zk;
            assert.deepStrictEqual(r.warnings, []);
            assert.strictEqual(r.warningReason, null);
        });
    } finally {
        opaqueSetup._resetForTests();
    }
});

test('a verdict on one OPAQUE value is never applied to another', async () => {
    opaqueSetup._resetForTests();
    try {
        await withEnv({ OPAQUE_SERVER_SETUP: 'A'.repeat(192) }, async () => {
            await opaqueSetup.validateServerSetup({ opaqueLib: fakeOpaque(false), log: quiet });
        });
        await withEnv({ OPAQUE_SERVER_SETUP: 'z'.repeat(171) }, () => {
            assert.deepStrictEqual(tierReadiness().zk.warnings, [], 'an unjudged value falls back to presence');
        });
    } finally {
        opaqueSetup._resetForTests();
    }
});

// ── Combined availability ───────────────────────────────────────────────────

test('an unentitled org can only select none', async () => {
    await withEnv({ MASTER_ENCRYPTION_KEY: 'x'.repeat(32) }, async () => {
        const a = await getEncryptionAvailability('org-a');
        assert.strictEqual(a.entitled, false);
        assert.deepStrictEqual(a.allowedTiers, ['none']);
        const managed = a.tiers.find(t => t.tier === 'managed');
        assert.strictEqual(managed.selectable, false);
        assert.strictEqual(managed.blockedBy, 'entitlement', 'a billing block, so the UI shows an upgrade path');
        assert.strictEqual(managed.reason, NOT_ENTITLED_REASON);
    });
});

test('an entitled org on a configured server can select every tier', async () => {
    entitledOrgs.add('org-a');
    await withEnv({ MASTER_ENCRYPTION_KEY: 'x'.repeat(32), OPAQUE_SERVER_SETUP: 'y'.repeat(171) }, async () => {
        const a = await getEncryptionAvailability('org-a');
        assert.strictEqual(a.entitled, true);
        assert.deepStrictEqual(a.allowedTiers.sort(), ['managed', 'none', 'zk']);
    });
});

test('an entitled org cannot select managed when the server has no master key', async () => {
    entitledOrgs.add('org-a');
    await withEnv({ MASTER_ENCRYPTION_KEY: undefined }, async () => {
        const a = await getEncryptionAvailability('org-a');
        const managed = a.tiers.find(t => t.tier === 'managed');
        assert.strictEqual(managed.selectable, false);
        assert.strictEqual(managed.blockedBy, 'readiness', 'a config block, so the UI shows an ops note, not an upsell');
        assert.deepStrictEqual(managed.missing, ['MASTER_ENCRYPTION_KEY']);
        assert.ok(!a.allowedTiers.includes('managed'));
    });
});

test("'none' stays selectable even for an unentitled org", async () => {
    // A lapsed plan must never strand an org on a tier it can no longer manage.
    await withEnv({ MASTER_ENCRYPTION_KEY: undefined }, async () => {
        const a = await getEncryptionAvailability('org-lapsed');
        const none = a.tiers.find(t => t.tier === 'none');
        assert.strictEqual(none.selectable, true);
        assert.strictEqual(none.blockedBy, null);
        assert.ok(a.allowedTiers.includes('none'));
    });
});

test('every tier is reported, not just the selectable ones', async () => {
    // Hiding a locked tier is the failure mode the Privacy Shield comments warn
    // about — the UI needs all three so it can disable and explain.
    const a = await getEncryptionAvailability('org-a');
    assert.deepStrictEqual(a.tiers.map(t => t.tier), ['none', 'managed', 'zk']);
    for (const t of a.tiers) {
        if (!t.selectable) assert.ok(t.reason, `${t.tier} must explain why it is not selectable`);
    }
});

// ── The login gate ──────────────────────────────────────────────────────────
// It answers "derive this person a key now?", and gets there through BOTH
// halves: the plan must include encryption AND the org must have switched it
// on. Each half has its own live bug behind it.
//
// ENTITLEMENT: bee-flow was entitled through its enterprise LICENCE (not
// through plan allowed_features), so the admin gate allowed 'zk' while the
// login gate read allowed_features alone, returned false, and derived no DEK.
// zk has no escrow, so every message was written in plaintext with only a
// console.error.
//
// TIER: the mirror image. 'none' is the default for every org, so entitlement
// alone made this true for any Enterprise org that had simply never turned
// encryption on — and its SSO users were shown "Set Up Data Encryption" and
// asked for a PIN protecting nothing.

/** Run fn with userStore mocked to resolve `users`. */
async function withUsers(users, fn) {
    const usPath = require.resolve(path.join(__dirname, 'userStore'));
    const prev = require.cache[usPath];
    require.cache[usPath] = {
        id: 'us-mock', filename: 'us-mock', loaded: true,
        exports: { async getUser(id) { return users[id] || null; } },
    };
    try { return await fn(); } finally {
        if (prev) require.cache[usPath] = prev; else delete require.cache[usPath];
    }
}

const IN_ORG = { 'u-in-org': { id: 'u-in-org', organizationId: 'org-a' } };

test('the login gate uses the same entitlement source as the admin gate', async () => {
    await withUsers(IN_ORG, async () => {
        const { isEncryptionEnabledForUser } = require('./encryptionAvailability');
        orgTiers.set('org-a', 'zk');

        assert.strictEqual(await isEncryptionEnabledForUser('u-in-org'), false, 'unentitled org');

        // Entitle the org the way a LICENCE TIER does — note this never touches
        // allowed_features, which is exactly the case the old gate missed.
        entitledOrgs.add('org-a');
        assert.strictEqual(
            await isEncryptionEnabledForUser('u-in-org'), true,
            'an org entitled by licence tier must derive a DEK at login, or zk silently writes plaintext',
        );
    });
});

test("the login gate is false while the org's tier is 'none', however entitled", async () => {
    // The reported bug: an entitled org that never switched encryption on had
    // its SSO users asked to choose an encryption PIN.
    await withUsers(IN_ORG, async () => {
        const { isEncryptionEnabledForUser } = require('./encryptionAvailability');
        entitledOrgs.add('org-a');

        orgTiers.set('org-a', 'none');
        assert.strictEqual(await isEncryptionEnabledForUser('u-in-org'), false, "tier 'none'");

        // An org row that does not exist, or a column that predates the
        // migration, reads as 'none' too — and must not prompt either.
        orgTiers.delete('org-a');
        invalidatePolicyCache();
        assert.strictEqual(await isEncryptionEnabledForUser('u-in-org'), false, 'no org row');
    });
});

test('the login gate follows the tier the org actually chose', async () => {
    await withUsers(IN_ORG, async () => {
        const { isEncryptionEnabledForUser } = require('./encryptionAvailability');
        entitledOrgs.add('org-a');
        for (const [tier, expected] of [['none', false], ['managed', true], ['zk', true]]) {
            orgTiers.set('org-a', tier);
            invalidatePolicyCache();
            assert.strictEqual(await isEncryptionEnabledForUser('u-in-org'), expected, `tier '${tier}'`);
        }
    });
});

test('entitlement is checked first, so a lapsed org stops deriving keys', async () => {
    // Its tier column still says zk — an org keeps whatever it selected — but
    // the plan no longer includes encryption, so no new key may be minted.
    await withUsers(IN_ORG, async () => {
        const { isEncryptionEnabledForUser } = require('./encryptionAvailability');
        orgTiers.set('org-a', 'zk');
        assert.strictEqual(await isEncryptionEnabledForUser('u-in-org'), false);
    });
});

test('the login gate is false for an unknown user or a user with no org', async () => {
    await withUsers({ 'orphan': { id: 'orphan', organizationId: '' } }, async () => {
        const { isEncryptionEnabledForUser } = require('./encryptionAvailability');
        assert.strictEqual(await isEncryptionEnabledForUser('nobody'), false);
        assert.strictEqual(await isEncryptionEnabledForUser('orphan'), false);
    });
});

test('a licence lookup failure fails closed', async () => {
    const lic = require.cache[require.resolve(path.join(__dirname, '..', 'license'))].exports;
    const original = lic.hasFeature;
    lic.hasFeature = async () => { throw new Error('licence server unreachable'); };
    try {
        assert.strictEqual(await isOrgEntitled('org-a'), false, 'must not hand out a paid feature on error');
        const a = await getEncryptionAvailability('org-a');
        assert.deepStrictEqual(a.allowedTiers, ['none']);
    } finally {
        lic.hasFeature = original;
    }
});
