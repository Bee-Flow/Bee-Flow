const { test } = require('node:test');
const assert = require('node:assert');
const { applyDefaultEncryptionTier } = require('./initialTier');

/** An availability answer shaped like getEncryptionAvailability's. */
function availability(tierStates) {
    return {
        entitled: true,
        allowedTiers: Object.entries(tierStates).filter(([, v]) => v.selectable).map(([k]) => k),
        readiness: {},
        tiers: Object.entries(tierStates).map(([tier, v]) => ({
            tier, selectable: !!v.selectable, reason: v.reason || null,
            missing: [], warnings: [], warningReason: null,
            blockedBy: v.selectable ? null : (v.blockedBy || 'readiness'),
        })),
    };
}

function store() {
    const calls = { updates: [], audits: [] };
    return {
        calls,
        async updateOrganization(id, updates) { calls.updates.push([id, updates]); return true; },
        async logAccessAudit(...args) { calls.audits.push(args); },
    };
}

test('applies the configured tier when it is selectable', async () => {
    const s = store();
    const out = await applyDefaultEncryptionTier('acme', {
        defaultTier: () => 'managed',
        getEncryptionAvailability: async () => availability({ none: { selectable: true }, managed: { selectable: true } }),
        userStore: s,
    });
    assert.deepStrictEqual(out, { tier: 'managed', applied: true, reason: 'applied' });
    assert.deepStrictEqual(s.calls.updates, [['acme', { encryptionTier: 'managed' }]]);
});

test("writes nothing at all when the default is 'none'", async () => {
    const s = store();
    const out = await applyDefaultEncryptionTier('acme', {
        defaultTier: () => 'none',
        getEncryptionAvailability: async () => { throw new Error('must not be consulted'); },
        userStore: s,
    });
    assert.strictEqual(out.applied, false);
    assert.strictEqual(out.reason, 'default_is_none');
    // An audit row per org creation for a change that did not happen would make
    // the trail useless exactly where it matters.
    assert.strictEqual(s.calls.updates.length, 0);
    assert.strictEqual(s.calls.audits.length, 0);
});

test('narrows to none when the tier is blocked by entitlement', async () => {
    const s = store();
    const out = await applyDefaultEncryptionTier('acme', {
        defaultTier: () => 'zk',
        getEncryptionAvailability: async () => availability({
            none: { selectable: true },
            zk: { selectable: false, blockedBy: 'entitlement', reason: 'plan does not include encryption' },
        }),
        userStore: s,
    });
    assert.strictEqual(out.tier, 'none');
    assert.strictEqual(out.applied, false);
    assert.strictEqual(out.reason, 'not_selectable_entitlement');
    assert.strictEqual(s.calls.updates.length, 0);
});

test('narrows to none when the server is not ready for the tier', async () => {
    const s = store();
    const out = await applyDefaultEncryptionTier('acme', {
        defaultTier: () => 'managed',
        getEncryptionAvailability: async () => availability({
            none: { selectable: true },
            managed: { selectable: false, blockedBy: 'readiness', reason: 'MASTER_ENCRYPTION_KEY missing' },
        }),
        userStore: s,
    });
    assert.strictEqual(out.reason, 'not_selectable_readiness');
    assert.strictEqual(s.calls.updates.length, 0);
});

test('narrows to none when the availability check throws', async () => {
    const s = store();
    const out = await applyDefaultEncryptionTier('acme', {
        defaultTier: () => 'managed',
        getEncryptionAvailability: async () => { throw new Error('db down'); },
        userStore: s,
    });
    assert.strictEqual(out.tier, 'none');
    assert.strictEqual(out.reason, 'availability_threw');
    assert.strictEqual(s.calls.updates.length, 0);
});

test('narrows to none when the tier is absent from the availability answer', async () => {
    const s = store();
    const out = await applyDefaultEncryptionTier('acme', {
        defaultTier: () => 'managed',
        getEncryptionAvailability: async () => availability({ none: { selectable: true } }),
        userStore: s,
    });
    assert.strictEqual(out.reason, 'not_selectable_unknown_tier');
    assert.strictEqual(s.calls.updates.length, 0);
});

test('reports failure when the store returns false rather than throwing', async () => {
    // updateOrganization signals a DB error with `false`. Treating that as
    // success would leave the org on 'none' while the caller believed the tier
    // was stored.
    const s = store();
    s.updateOrganization = async () => false;
    const out = await applyDefaultEncryptionTier('acme', {
        defaultTier: () => 'managed',
        getEncryptionAvailability: async () => availability({ none: { selectable: true }, managed: { selectable: true } }),
        userStore: s,
    });
    assert.strictEqual(out.applied, false);
    assert.strictEqual(out.reason, 'update_returned_false');
    // and nothing was written to the audit trail claiming the change happened
    assert.strictEqual(s.calls.audits.length, 0);
});

test('reports failure when the store throws', async () => {
    const s = store();
    s.updateOrganization = async () => { throw new Error('constraint'); };
    const out = await applyDefaultEncryptionTier('acme', {
        defaultTier: () => 'managed',
        getEncryptionAvailability: async () => availability({ none: { selectable: true }, managed: { selectable: true } }),
        userStore: s,
    });
    assert.strictEqual(out.applied, false);
    assert.strictEqual(out.reason, 'update_threw');
});

test('a failing audit write does not undo an applied tier', async () => {
    // The tier is stored before the trail is written. If the trail fails, the
    // org is still encrypted — reporting otherwise would send an operator
    // looking for a problem that is not there.
    const s = store();
    s.logAccessAudit = async () => { throw new Error('audit table gone'); };
    const out = await applyDefaultEncryptionTier('acme', {
        defaultTier: () => 'managed',
        getEncryptionAvailability: async () => availability({ none: { selectable: true }, managed: { selectable: true } }),
        userStore: s,
    });
    assert.deepStrictEqual(out, { tier: 'managed', applied: true, reason: 'applied' });
});

test('narrows to none without an org id', async () => {
    for (const bad of [null, undefined, '', 0, {}]) {
        const out = await applyDefaultEncryptionTier(bad, {
            defaultTier: () => 'managed',
            getEncryptionAvailability: async () => { throw new Error('must not be consulted'); },
            userStore: store(),
        });
        assert.strictEqual(out.reason, 'no_org_id', `for ${JSON.stringify(bad)}`);
    }
});

test('narrows to none when defaultTier itself throws', async () => {
    const out = await applyDefaultEncryptionTier('acme', {
        defaultTier: () => { throw new Error('bad env'); },
        getEncryptionAvailability: async () => { throw new Error('must not be consulted'); },
        userStore: store(),
    });
    assert.strictEqual(out.reason, 'default_tier_threw');
});

test('the audit trail names the env var as the source', async () => {
    const s = store();
    await applyDefaultEncryptionTier('acme', {
        defaultTier: () => 'managed',
        getEncryptionAvailability: async () => availability({ none: { selectable: true }, managed: { selectable: true } }),
        userStore: s,
    });
    assert.strictEqual(s.calls.audits.length, 1);
    const [action, targetType, targetId, actor, oldV, newV, orgId] = s.calls.audits[0];
    assert.strictEqual(action, 'org.encryption.update');
    assert.strictEqual(targetType, 'organization');
    assert.strictEqual(targetId, 'acme');
    assert.strictEqual(actor, 'system');
    assert.deepStrictEqual(oldV, { tier: 'none', scope: null });
    assert.strictEqual(newV.tier, 'managed');
    assert.strictEqual(newV.source, 'BEEFLOW_DEFAULT_ENCRYPTION_TIER');
    assert.strictEqual(orgId, 'acme');
});
