/**
 * ncScope — storage, sanitization and org∩user composition for the
 * per-user Nextcloud access scope.
 *
 * The invariants that matter:
 *   - absent doc / absent id ⇒ 'all' (shipping the feature changes nothing)
 *   - composition is most-restrictive-wins (off > selected > all,
 *     selected∩selected intersects) — a user can only NARROW
 *   - 'selected' on an unscopable integration degrades to 'off', never to
 *     'all' (fail-closed)
 *   - revokeAll ≠ reset: explicit all-off vs delete-back-to-default
 *   - folder paths are normalised and traversal-proof
 *
 * Fake configStore injected into require.cache — no Postgres.
 *
 * Run: node --test server/core/integrations/ncScope.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const store = new Map();
const audits = [];

function inject(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
inject('../../stores/configStore.js', {
    getConfig: async (k) => store.get(k) ?? null,
    setConfig: async (k, v) => { store.set(k, v); },
    deleteConfig: async (k) => { store.delete(k); },
    getSecret: async () => null,
});
inject('../../stores/guardrailEventStore.js', {
    logGuardrailEvent: async (e) => { audits.push(e); },
});

const ncScope = require('./ncScope');
const { NC_INTEGRATION_IDS } = require('./ncIntegrationCatalog');

const USER = 'u-1';
const ORG = 'org-1';

beforeEach(() => { store.clear(); audits.length = 0; });

test('absent doc resolves every catalog id to all', async () => {
    const scope = await ncScope.resolveNcScope({ userId: USER, orgId: ORG });
    assert.deepEqual(Object.keys(scope).sort(), [...NC_INTEGRATION_IDS].sort());
    for (const id of NC_INTEGRATION_IDS) {
        assert.equal(scope[id].mode, 'all', `${id} must default to all`);
        assert.equal(scope[id].selected, null);
    }
});

test('user narrowing: selected folders resolve as a Set; off is off', async () => {
    await ncScope.saveUserScope(USER, {
        integrations: {
            'nextcloud': { mode: 'selected', selected: ['/Projects/Bee Flow', 'Documents/'] },
            'nextcloud-mail': { mode: 'off' },
        },
    });
    const scope = await ncScope.resolveNcScope({ userId: USER });
    assert.equal(scope['nextcloud'].mode, 'selected');
    assert.deepEqual([...scope['nextcloud'].selected].sort(), ['/Documents', '/Projects/Bee Flow']);
    assert.equal(scope['nextcloud-mail'].mode, 'off');
    assert.equal(scope['nextcloud-calendar'].mode, 'all');
});

test('composition: org off beats user all; org selected ∩ user selected intersects', async () => {
    store.set(ncScope._orgKey(ORG), {
        v: 1,
        integrations: {
            'nextcloud-talk': { mode: 'off' },
            'nextcloud-calendar': { mode: 'selected', selected: ['work', 'personal'] },
        },
    });
    await ncScope.saveUserScope(USER, {
        integrations: {
            'nextcloud-calendar': { mode: 'selected', selected: ['personal', 'family'] },
        },
    });
    const scope = await ncScope.resolveNcScope({ userId: USER, orgId: ORG });
    assert.equal(scope['nextcloud-talk'].mode, 'off', 'org off must beat the user default');
    assert.equal(scope['nextcloud-calendar'].mode, 'selected');
    assert.deepEqual([...scope['nextcloud-calendar'].selected], ['personal'],
        'two selections intersect — the user cannot re-widen past the org ceiling');
});

test('org selected + user all stays org-selected (user cannot widen)', async () => {
    store.set(ncScope._orgKey(ORG), {
        v: 1, integrations: { 'nextcloud-deck': { mode: 'selected', selected: ['7'] } },
    });
    const scope = await ncScope.resolveNcScope({ userId: USER, orgId: ORG });
    assert.equal(scope['nextcloud-deck'].mode, 'selected');
    assert.deepEqual([...scope['nextcloud-deck'].selected], ['7']);
});

test('sanitization: traversal, unknown ids, junk modes and oversize entries are dropped', () => {
    const clean = ncScope.sanitizeIntegrations({
        'nextcloud': { mode: 'selected', selected: ['/ok', '/../etc', '../up', '/a/./b', '', null, '/dup', '/dup', 'x'.repeat(600)] },
        'not-a-catalog-id': { mode: 'off' },
        'nextcloud-talk': { mode: 'sideways' },
        'nextcloud-mail': 'off',
    });
    assert.deepEqual(Object.keys(clean), ['nextcloud']);
    assert.deepEqual(clean['nextcloud'].selected, ['/ok', '/dup']);
});

test("'selected' on an unscopable integration degrades to off, never all", () => {
    const clean = ncScope.sanitizeIntegrations({
        'nextcloud-status': { mode: 'selected', selected: ['whatever'] },
    });
    assert.equal(clean['nextcloud-status'].mode, 'off',
        'the user asked for less-than-everything on a surface that cannot narrow — nothing is the safe reading');
});

test('normalizeFolderPath: rooted, collapsed, traversal-proof', () => {
    assert.equal(ncScope.normalizeFolderPath('Projects//Bee Flow/'), '/Projects/Bee Flow');
    assert.equal(ncScope.normalizeFolderPath('/'), '/');
    assert.equal(ncScope.normalizeFolderPath('/a/../b'), null);
    assert.equal(ncScope.normalizeFolderPath('  '), null);
    assert.equal(ncScope.normalizeFolderPath(42), null);
});

test('saveUserScope: mode all removes the override (absent-means-default stays true)', async () => {
    await ncScope.saveUserScope(USER, { integrations: { 'nextcloud-forms': { mode: 'off' } } });
    await ncScope.saveUserScope(USER, { integrations: { 'nextcloud-forms': { mode: 'all' } } });
    const doc = await ncScope.getUserScopeDoc(USER);
    assert.ok(!('nextcloud-forms' in doc.integrations),
        'choosing "Everything" must store as absence, not as an explicit all entry');
});

test('revokeAll writes every id off explicitly; reset deletes the doc', async () => {
    await ncScope.revokeAll(USER, { orgId: ORG });
    let scope = await ncScope.resolveNcScope({ userId: USER });
    for (const id of NC_INTEGRATION_IDS) assert.equal(scope[id].mode, 'off', `${id} must be off after revoke-all`);

    await ncScope.resetToDefault(USER, { orgId: ORG });
    assert.equal(await ncScope.getUserScopeDoc(USER), null);
    scope = await ncScope.resolveNcScope({ userId: USER });
    for (const id of NC_INTEGRATION_IDS) assert.equal(scope[id].mode, 'all', `${id} must be all after reset`);
});

test('every write is audited with a per-integration diff', async () => {
    await ncScope.saveUserScope(USER, { integrations: { 'nextcloud': { mode: 'selected', selected: ['/x'] } } }, { orgId: ORG });
    await ncScope.revokeAll(USER, { orgId: ORG });
    await ncScope.resetToDefault(USER, { orgId: ORG });
    assert.equal(audits.length, 3);
    for (const a of audits) {
        assert.equal(a.violation_categories, 'nc_scope:user');
        assert.equal(a.user_id, USER);
        assert.equal(a.organization_id, ORG);
    }
    assert.match(audits[0].action_taken, /nextcloud: all→selected\(1\)/);
    assert.match(audits[1].action_taken, /revoke-all/);
    assert.match(audits[2].action_taken, /reset-to-default/);
});
