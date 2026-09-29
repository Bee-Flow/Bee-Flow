'use strict';
/**
 * The process registry (id → type), the scan plan built from a category
 * list, and the list helpers.
 *
 * Run: cd server && node --test core/privacy/customTypes/registry.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// An unknown id makes planScan re-read every org shield; answer that from an
// empty database instead of a real one.
require('../../http/routeHarness').recordDb();

const registry = require('./registry');
const { planScan, hasCustomIds, withBuiltinDefault, scanCategoriesFor } = require('./plan');
const { ALL_PII_CATEGORY_IDS } = require('../piiDetection/categories');

const W = (id, name, tokenKey, values = ['x']) => ({ id, name, method: 'words', tokenKey, words: { values, caseSensitive: false, wholeWord: true } });
const A = 'cdt_000000000a';
const B = 'cdt_000000000b';

test.beforeEach(() => registry._resetRegistry());

test('sync, look up, and name a type by its id', () => {
    assert.equal(registry.syncOrg('org1', [W(A, 'Projects', 'project_code')]), true);
    assert.equal(registry.syncOrg('org1', [W(A, 'Projects', 'project_code')]), false, 'an unchanged list is a no-op');
    assert.equal(registry.tokenKeyFor(A), 'project_code');
    assert.equal(registry.displayNameFor(A), 'Projects');
    assert.equal(registry.ownerOf(A), 'org1');
    assert.equal(registry.isCustomTokenKey('projectcode'), true);
    // Unknown ids get the reserved fallbacks, never another type's.
    assert.equal(registry.tokenKeyFor(B), 'custom');
    assert.equal(registry.displayNameFor(B), 'Custom data');
});

test('a removed type stays resolvable for its tombstone, then is gone', (t) => {
    registry.syncOrg('org1', [W(A, 'Projects', 'project_code')]);
    registry.syncOrg('org1', []);
    assert.ok(registry.lookup(A), 'in-flight scans and fresh tokens still resolve');
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + registry.TOMBSTONE_MS + 1 });
    assert.equal(registry.lookup(A), null);
    t.mock.timers.reset();
});

test('two orgs listing one id: it resolves to nothing, then heals', () => {
    registry.syncOrg('org1', [W(A, 'Projects', 'project_code')]);
    registry.syncOrg('org2', [W(A, 'Stolen', 'other_key')]);
    assert.equal(registry.lookup(A), null, 'neither org gets the other one\'s matcher');
    assert.equal(registry.displayNameFor(A), 'Custom data');
    // org2 drops it: org1 owns it again.
    registry.syncOrg('org2', []);
    assert.equal(registry.displayNameFor(A), 'Projects');
    // org1 drops it and org2 takes it: org1's tombstone does not stand in.
    registry.syncOrg('org1', []);
    registry.syncOrg('org2', [W(A, 'Stolen', 'other_key')]);
    assert.equal(registry.displayNameFor(A), 'Stolen');
});

test('the digest of a list changes when a type does, and names unknown ids', () => {
    registry.syncOrg('org1', [W(A, 'Projects', 'project_code', ['Falcon'])]);
    const before = registry.digestFor(['Person', A]);
    registry.syncOrg('org1', [W(A, 'Projects', 'project_code', ['Falcon', 'Heron'])]);
    assert.notEqual(registry.digestFor(['Person', A]), before);
    assert.equal(registry.digestFor(['Person']), '', 'no custom ids, no digest');
});

test('list helpers: empty built-in part means every built-in', () => {
    assert.equal(hasCustomIds(['Person']), false);
    assert.equal(hasCustomIds([A]), true);
    const same = ['Person', 'Email'];
    assert.equal(withBuiltinDefault(same), same, 'untouched without custom ids');
    assert.deepEqual(withBuiltinDefault([A]), [...ALL_PII_CATEGORY_IDS, A]);
    assert.deepEqual(withBuiltinDefault(['Email', A]), ['Email', A]);

    const shield = {
        piiDetectionCategories: ['Email', A],
        toolPiiPolicy: { external: { blockCategories: [B] }, internal: { blockCategories: [] } },
    };
    assert.deepEqual(scanCategoriesFor(shield, 'internal'), [...ALL_PII_CATEGORY_IDS, A]);
    assert.deepEqual(scanCategoriesFor(shield, 'external'), [...ALL_PII_CATEGORY_IDS, A, B]);
    assert.equal(scanCategoriesFor({ piiDetectionCategories: ['Email'] }, 'external'), null, 'no custom types: today\'s null');
});

test('planScan: split, unknown ids after one refresh, types given directly', async () => {
    assert.equal(await planScan(['Person', 'Email']), null, 'a list without custom ids keeps today\'s path');
    registry.syncOrg('org1', [W(A, 'Projects', 'project_code', ['Falcon']),
        { id: B, name: 'Codes', method: 'ai', tokenKey: 'code', ai: { prompt: 'code name', floor: 0.5 } }]);
    const plan = await planScan(['Person', A, B, 'cdt_00000000cc']);
    assert.deepEqual(plan.builtIns, ['Person']);
    assert.deepEqual(plan.nodeTypes.map(t => t.id), [A]);
    assert.deepEqual(plan.aiTypes.map(t => t.id), [B]);
    assert.deepEqual(plan.unknown, ['cdt_00000000cc']);
    assert.equal(plan.labelFor(A), 'Projects');
    assert.ok(plan.orderFor(A) < plan.orderFor(B));

    const given = await planScan([A], { customTypes: [W(A, 'Bench draft', 'draft', ['Osprey'])] });
    assert.equal(given.labelFor(A), 'Bench draft', 'types passed in win over the registry');
    assert.notEqual(given.digest, plan.digest);
    const invalid = await planScan([A], { customTypes: [{ ...W(A, 'Red', 'red'), status: 'invalid' }] });
    assert.deepEqual([invalid.nodeTypes.length, invalid.unknown.length], [0, 0], 'a red type is known and switched off');
});
