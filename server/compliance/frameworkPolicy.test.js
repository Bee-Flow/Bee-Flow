/**
 * frameworkPolicy — enabled × licensed per org. The store and the entitlement
 * resolver are doubles shaped like the real ones (a snapshot with `_sets`,
 * `registry.getCapability`, `snapshotHas`), so the lock reasons are computed
 * by the module under test and not by the fake.
 *
 * Run: node --test --test-force-exit server/compliance/frameworkPolicy.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

// Short memo so the expiry case runs quickly; read once at module load.
process.env.COMPLIANCE_POLICY_MEMO_MS = '60';

// ── doubles ──────────────────────────────────────────────────────────────

// Per-org settings row, as complianceStore.getSettings returns it.
const settingsByOrg = new Map();
const saved = [];
const fakeStore = {
    getSettings: async (orgId) => settingsByOrg.get(orgId) || null,
    saveSettings: async (orgId, patch) => {
        saved.push({ orgId, patch });
        settingsByOrg.set(orgId, { ...(settingsByOrg.get(orgId) || {}), ...patch });
        return settingsByOrg.get(orgId);
    },
};

// Licence state: which capability ids are effective, which are merely in the
// plan ceiling, and which the registry knows at all.
const lic = { known: new Set(), effective: new Set(), ceiling: new Set(), tier: 'enterprise', degraded: false, resolves: 0 };
const fakeEnt = {
    registry: {
        getCapability: (id) => (lic.known.has(id) ? { id, kind: 'core', licenseFeature: id } : null),
    },
    snapshotHas: (snap, id) => snap._sets.effective.core.has(id),
    resolveEntitlements: async () => {
        lic.resolves++;
        return {
            tier: lic.tier,
            degraded: lic.degraded,
            _sets: { ceiling: { core: new Set(lic.ceiling) }, effective: { core: new Set(lic.effective) } },
            ceiling: { core: [...lic.ceiling] },
        };
    },
};

const emitted = [];
const fakeEvents = { emit: (name, payload) => emitted.push({ name, payload }) };

const restore = installResolveStub({
    '../stores/complianceStore': fakeStore,
    '../core/entitlements/entitlements': fakeEnt,
    './events': fakeEvents,
    // requireCapability's tier lookup — keep the 403 body's `required` stable.
    '../license/middleware': { findRequiredTierForFeature: () => 'enterprise' },
});
const policy = require('./frameworkPolicy');
const frameworks = require('./frameworks');
after(restore);

const ALL_CAPS = frameworks.listBuiltin().map(f => f.capability).concat('compliance_hub_custom');

beforeEach(() => {
    settingsByOrg.clear();
    saved.length = 0;
    emitted.length = 0;
    lic.known = new Set(ALL_CAPS);
    lic.effective = new Set(['compliance_hub_gdpr', 'compliance_hub_aia', 'compliance_hub_iso27001', 'compliance_hub_nis2']);
    lic.ceiling = new Set([...lic.effective, 'compliance_hub_cra']);
    lic.tier = 'enterprise';
    lic.degraded = false;
    lic.resolves = 0;
    policy.invalidate();
});

const byId = (entries, id) => entries.find(e => e.id === id);

// ── resolve ──────────────────────────────────────────────────────────────

test('resolve: core frameworks are enabled regardless of settings; opt-in ones follow enabled_frameworks', async () => {
    settingsByOrg.set('o1', { enabled_frameworks: ['nis2'] });
    const entries = await policy.resolve('o1');
    assert.strictEqual(entries.length, frameworks.listBuiltin().length);
    for (const id of frameworks.CORE_IDS) {
        assert.strictEqual(byId(entries, id).enabled, true, `${id} is core`);
        assert.strictEqual(byId(entries, id).core, true);
    }
    assert.strictEqual(byId(entries, 'nis2').enabled, true);
    assert.strictEqual(byId(entries, 'cra').enabled, false);
    assert.strictEqual(byId(entries, 'dora').enabled, false);
});

test('resolve: lock reasons — null when effective, not_granted when in the ceiling, ceiling when outside the plan', async () => {
    const entries = await policy.resolve('o1');
    const nis2 = byId(entries, 'nis2');
    assert.strictEqual(nis2.locked, null);
    assert.strictEqual(nis2.lock, null);

    const cra = byId(entries, 'cra');
    assert.strictEqual(cra.locked, 'not_granted');
    assert.deepStrictEqual(cra.lock, { feature: 'compliance_hub_cra', required: 'enterprise', current: 'enterprise', upgrade_url: cra.lock.upgrade_url });

    const dora = byId(entries, 'dora');
    assert.strictEqual(dora.locked, 'ceiling');
    assert.strictEqual(dora.lock.feature, 'compliance_hub_dora');
    assert.match(dora.lock.upgrade_url, /^https?:\/\//);
});

test('resolve: a core framework is locked honestly when its capability is missing', async () => {
    lic.effective.delete('compliance_hub_iso27001');
    lic.ceiling.delete('compliance_hub_iso27001');
    const entries = await policy.resolve('o1');
    const iso = byId(entries, 'iso27001');
    assert.strictEqual(iso.enabled, true, 'still a core framework');
    assert.strictEqual(iso.locked, 'ceiling');
});

test('resolve: a capability no tier declares reads as ceiling', async () => {
    lic.known.delete('compliance_hub_machinery');
    const entries = await policy.resolve('o1');
    assert.strictEqual(byId(entries, 'machinery').locked, 'ceiling');
});

test('resolve: relevance defaults — gated frameworks unknown, others relevant; stored values win', async () => {
    settingsByOrg.set('o1', { framework_relevance: { dora: 'relevant', nis2: 'not_relevant', machinery: 'garbage' } });
    const entries = await policy.resolve('o1');
    assert.strictEqual(byId(entries, 'dora').relevance, 'relevant');
    assert.strictEqual(byId(entries, 'machinery').relevance, 'unknown', 'an invalid stored value falls back to unknown');
    assert.strictEqual(byId(entries, 'nis2').relevance, 'not_relevant');
    assert.strictEqual(byId(entries, 'gdpr').relevance, 'relevant');
});

test('resolve: tolerates a missing settings row and JSON-string columns', async () => {
    settingsByOrg.set('o2', { enabled_frameworks: '["cra","nis2"]', framework_relevance: '{"dora":"not_relevant"}' });
    const entries = await policy.resolve('o2');
    assert.strictEqual(byId(entries, 'nis2').enabled, true);
    assert.strictEqual(byId(entries, 'cra').enabled, true);
    assert.strictEqual(byId(entries, 'dora').relevance, 'not_relevant');

    const none = await policy.resolve('o-without-row');
    assert.strictEqual(byId(none, 'nis2').enabled, false);
});

test('resolve: a degraded licence answer throws instead of reading as "nothing licensed"', async () => {
    lic.degraded = true;
    await assert.rejects(() => policy.resolve('o1'), (e) => e instanceof policy.EntitlementsUnavailableError && e.status === 503);
    // Never memoised: the next call asks again.
    lic.degraded = false;
    const entries = await policy.resolve('o1');
    assert.strictEqual(byId(entries, 'gdpr').locked, null);
});

// ── activeRegulations ────────────────────────────────────────────────────

test('activeRegulations: enabled AND unlocked, plus CUSTOM when the org holds the custom capability', async () => {
    settingsByOrg.set('o1', { enabled_frameworks: ['nis2', 'cra', 'dora'] });
    // nis2 effective → active; cra in ceiling only → locked; dora outside → locked.
    let active = await policy.activeRegulations('o1');
    assert.deepStrictEqual([...active].sort(), ['AIA', 'GDPR', 'ISO27001', 'NIS2']);

    lic.effective.add('compliance_hub_custom');
    policy.invalidate('o1');
    active = await policy.activeRegulations('o1');
    assert.ok(active.has('CUSTOM'));
});

test('activeRegulations: an enabled framework that lost its licence drops out', async () => {
    settingsByOrg.set('o1', { enabled_frameworks: ['nis2'] });
    assert.ok((await policy.activeRegulations('o1')).has('NIS2'));
    lic.effective.delete('compliance_hub_nis2');
    policy.invalidate('o1');
    assert.ok(!(await policy.activeRegulations('o1')).has('NIS2'));
});

// ── memo ─────────────────────────────────────────────────────────────────

test('memo: one licence resolution per org within the TTL; invalidate(orgId) and expiry re-read', async () => {
    await policy.resolve('o1');
    await policy.resolve('o1');
    await policy.activeRegulations('o1');
    assert.strictEqual(lic.resolves, 1, 'memoised per org');

    await policy.resolve('o2');
    assert.strictEqual(lic.resolves, 2, 'a different org is its own entry');

    policy.invalidate('o1');
    await policy.resolve('o1');
    assert.strictEqual(lic.resolves, 3, 'invalidate(orgId) drops that org only');
    await policy.resolve('o2');
    assert.strictEqual(lic.resolves, 3);

    await new Promise(r => setTimeout(r, policy.MEMO_TTL_MS + 20));
    await policy.resolve('o2');
    assert.strictEqual(lic.resolves, 4, 'expired after MEMO_TTL_MS');
});

test('memo: settings changes are visible after invalidate, stale within the TTL', async () => {
    assert.strictEqual(byId(await policy.resolve('o1'), 'nis2').enabled, false);
    settingsByOrg.set('o1', { enabled_frameworks: ['nis2'] });
    assert.strictEqual(byId(await policy.resolve('o1'), 'nis2').enabled, false, 'memo still serves the old row');
    policy.invalidate('o1');
    assert.strictEqual(byId(await policy.resolve('o1'), 'nis2').enabled, true);
});

test('resolve with req resolves the licence for the caller but memoises the org settings', async () => {
    const req = { session: { user: { id: 'u1' } } };
    await policy.resolve('o1', { req });
    await policy.resolve('o1', { req });
    // org-level snapshot once (memo) + one per request-scoped call
    assert.strictEqual(lic.resolves, 3);
});

// ── setEnabled ───────────────────────────────────────────────────────────

test('setEnabled: enabling an unlocked framework persists enabled_frameworks, busts the memo and emits', async () => {
    const entry = await policy.setEnabled('o1', 'nis2', true, 'admin-1');
    assert.strictEqual(entry.id, 'nis2');
    assert.strictEqual(entry.enabled, true);
    assert.deepStrictEqual(saved, [{ orgId: 'o1', patch: { enabled_frameworks: ['nis2'] } }]);
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].name, policy.POLICY_EVENTS.FRAMEWORK_ENABLED);
    assert.strictEqual(emitted[0].payload.orgId, 'o1');
    assert.strictEqual(emitted[0].payload.frameworkId, 'nis2');
    assert.strictEqual(emitted[0].payload.regulation, 'NIS2');
    assert.strictEqual(emitted[0].payload.actorId, 'admin-1');
    // Visible right away — no stale memo.
    assert.ok((await policy.activeRegulations('o1')).has('NIS2'));
});

test('setEnabled: disabling persists and emits; a no-op change writes but does not emit', async () => {
    settingsByOrg.set('o1', { enabled_frameworks: ['nis2', 'cra'] });
    const entry = await policy.setEnabled('o1', 'nis2', false, 'admin-1');
    assert.strictEqual(entry.enabled, false);
    assert.deepStrictEqual(saved.at(-1).patch, { enabled_frameworks: ['cra'] });
    assert.strictEqual(emitted.at(-1).name, policy.POLICY_EVENTS.FRAMEWORK_DISABLED);

    emitted.length = 0;
    await policy.setEnabled('o1', 'nis2', false, 'admin-1');
    assert.strictEqual(emitted.length, 0, 'disabling an already-disabled framework is not an event');
});

test('setEnabled: a core framework cannot be disabled; enabling it is a no-op', async () => {
    for (const id of frameworks.CORE_IDS) {
        await assert.rejects(() => policy.setEnabled('o1', id, false, 'a'), (e) => e instanceof policy.FrameworkCoreError && e.status === 400 && e.body.error === 'framework_core');
    }
    const entry = await policy.setEnabled('o1', 'gdpr', true, 'a');
    assert.strictEqual(entry.enabled, true);
    assert.strictEqual(saved.length, 0, 'nothing written for a core framework');
});

test('setEnabled: enabling a locked framework throws with the requireCapability 403 body', async () => {
    // cra: in ceiling, not granted → feature_disabled
    await assert.rejects(() => policy.setEnabled('o1', 'cra', true, 'a'), (e) => {
        assert.ok(e instanceof policy.FrameworkLockedError);
        assert.strictEqual(e.status, 403);
        assert.strictEqual(e.reason, 'not_granted');
        assert.deepStrictEqual(e.body, { error: 'feature_disabled', feature: 'compliance_hub_cra' });
        return true;
    });
    // dora: outside the plan → feature_locked with the upgrade CTA
    await assert.rejects(() => policy.setEnabled('o1', 'dora', true, 'a'), (e) => {
        assert.strictEqual(e.reason, 'ceiling');
        assert.strictEqual(e.body.error, 'feature_locked');
        assert.strictEqual(e.body.feature, 'compliance_hub_dora');
        assert.strictEqual(e.body.required, 'enterprise');
        assert.strictEqual(e.body.current, 'enterprise');
        assert.ok(e.body.upgrade_url);
        return true;
    });
    assert.strictEqual(saved.length, 0);
    assert.strictEqual(emitted.length, 0);
});

test('setEnabled: disabling a locked framework is allowed (an org may switch off what it can no longer use)', async () => {
    settingsByOrg.set('o1', { enabled_frameworks: ['dora'] });
    const entry = await policy.setEnabled('o1', 'dora', false, 'a');
    assert.strictEqual(entry.enabled, false);
    assert.deepStrictEqual(saved.at(-1).patch, { enabled_frameworks: [] });
});

test('setEnabled: unknown framework id → UnknownFrameworkError (custom ids are not toggled here)', async () => {
    await assert.rejects(() => policy.setEnabled('o1', 'gdpr2', true, 'a'), (e) => e instanceof policy.UnknownFrameworkError && e.status === 400);
    await assert.rejects(() => policy.setEnabled('o1', 'custom:abc', true, 'a'), policy.UnknownFrameworkError);
});

// ── setRelevance ─────────────────────────────────────────────────────────

test('setRelevance: roundtrip through the settings row with who/when/why', async () => {
    const entry = await policy.setRelevance('o1', 'dora', 'not_relevant', 'admin-1', 'No financial customers');
    assert.strictEqual(entry.relevance, 'not_relevant');
    const row = settingsByOrg.get('o1').framework_relevance;
    assert.strictEqual(row.dora, 'not_relevant');
    assert.strictEqual(row.meta.dora.set_by, 'admin-1');
    assert.strictEqual(row.meta.dora.note, 'No financial customers');
    assert.ok(Date.parse(row.meta.dora.set_at) > 0);
    assert.strictEqual(emitted.at(-1).name, policy.POLICY_EVENTS.FRAMEWORK_RELEVANCE_CHANGED);
    assert.strictEqual(emitted.at(-1).payload.relevance, 'not_relevant');

    // Read back through resolve (memo was busted).
    assert.strictEqual(byId(await policy.resolve('o1'), 'dora').relevance, 'not_relevant');

    // Flip back; the other keys survive.
    await policy.setRelevance('o1', 'machinery', 'relevant', 'admin-2');
    const row2 = settingsByOrg.get('o1').framework_relevance;
    assert.strictEqual(row2.dora, 'not_relevant');
    assert.strictEqual(row2.machinery, 'relevant');
    assert.strictEqual(row2.meta.dora.set_by, 'admin-1');
    assert.strictEqual(row2.meta.machinery.set_by, 'admin-2');
});

test('setRelevance: rejects an unknown value or framework', async () => {
    await assert.rejects(() => policy.setRelevance('o1', 'dora', 'maybe', 'a'), (e) => e instanceof policy.InvalidRelevanceError && e.status === 400);
    await assert.rejects(() => policy.setRelevance('o1', 'nope', 'relevant', 'a'), policy.UnknownFrameworkError);
    assert.strictEqual(saved.length, 0);
});
