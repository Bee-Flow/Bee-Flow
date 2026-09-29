'use strict';
/**
 * The old terms as types and back (migrate.js), and what the runtime makes of
 * a stored row (resolve.js): lazy migration, the licence clamp, the category
 * lists, and a stored row that is never mutated.
 *
 * Run: cd server && node --test core/privacy/customTypes/resolve.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrateLegacyTerms, buildLegacyMirror } = require('./migrate');
const { applyCustomTypes, deriveCustomState, hasCustomDataFeature } = require('./resolve');
const { legacyTypeId } = require('./ids');
const registry = require('./registry');
const { ALL_PII_CATEGORY_IDS } = require('../piiDetection/categories');
const tiers = require('../../../license/tiers');

const TERMS = [
    { id: 't1', label: 'Projectnaam', pattern: 'Aurora', type: 'literal', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'u1' },
    { id: 't2', label: 'Klantcode', pattern: 'KC-\\d{4}', type: 'regex', caseSensitive: true },
    { id: 't3', label: 'Lookahead', pattern: 'X(?=1)', type: 'regex' },
    { id: 't4', label: 'Broken', pattern: '([x', type: 'regex' },
    { id: 't5', label: '', pattern: 'nolabel', type: 'literal' },
    'Bare',
];

const lic = (tier) => ({ tiers, resolveTier: async () => tier, hasFeature: async (scope, f) => tiers.tierHasFeature(tier, f) });

test.beforeEach(() => registry._resetRegistry());

test('migration: deterministic ids, old semantics, bad terms kept red', () => {
    const types = migrateLegacyTerms('org1', TERMS);
    assert.deepEqual(types.map(t => t.id), ['t1', 't2', 't3', 't4', 'Bare'].map(k => legacyTypeId('org1', typeof k === 'string' && k !== 'Bare' ? { id: k } : k)));
    assert.deepEqual(migrateLegacyTerms('org1', TERMS), types, 'same input, same types');
    const [lit, re, v8, broken, bare] = types;
    assert.deepEqual(lit.words, { values: ['Aurora'], caseSensitive: false, wholeWord: false });
    assert.equal(lit.tokenKey, 'customterm');
    assert.equal(lit.legacy, true);
    assert.equal(lit.origin, 'migrated');
    assert.equal(lit.createdBy, 'u1');
    assert.deepEqual(re.pattern, { source: 'KC-\\d{4}', caseSensitive: true, engine: 're2' });
    assert.equal(v8.pattern.engine, 'v8-legacy');
    assert.equal(broken.status, 'invalid');
    assert.equal(bare.words.values[0], 'Bare');
});

test('the mirror: enforced words and V8-valid patterns, with the old term ids', () => {
    const types = migrateLegacyTerms('org1', TERMS);
    const created = { id: 'cdt_00000000a1', name: 'Many', method: 'words', words: { values: ['a', 'b'], caseSensitive: true } };
    const ai = { id: 'cdt_00000000b2', name: 'AI', method: 'ai', ai: { prompt: 'p', floor: 0.5 } };
    const re2only = { id: 'cdt_00000000c3', name: 'RE2', method: 'pattern', pattern: { source: '(?P<x>a)' } };
    const mirror = buildLegacyMirror([...types, created, ai, re2only]);
    assert.deepEqual(mirror.map(t => t.id), ['t1', 't2', 't3', legacyTypeId('org1', 'Bare'), 'cdt_00000000a1_0', 'cdt_00000000a1_1']);
    assert.deepEqual(mirror[0], { id: 't1', label: 'Projectnaam', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'u1', pattern: 'Aurora', caseSensitive: false, type: 'literal' });
});

test('lazy migration: a row without customDataTypes still hides its old terms from the AI', async () => {
    const stored = { enabled: true, piiDetectionCategories: [], customSensitiveTerms: TERMS.slice(0, 2) };
    const frozen = JSON.stringify(stored);
    const resolved = { piiDetectionCategories: stored.piiDetectionCategories, toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } } };
    await applyCustomTypes(resolved, stored, 'org1', { lic: lic('community') });
    const ids = migrateLegacyTerms('org1', TERMS.slice(0, 2)).map(t => t.id);
    assert.deepEqual(resolved.piiDetectionCategories, [...ALL_PII_CATEGORY_IDS, ...ids], 'empty still means every built-in');
    assert.deepEqual(resolved.toolPiiPolicy.external.blockCategories, [], 'tools stay off for migrated terms');
    assert.equal(resolved.customDataTypes.length, 2);
    assert.match(resolved.customTypesDigest, /^[0-9a-f]{16}$/);
    assert.equal(registry.displayNameFor(ids[0]), 'Projectnaam');
    assert.equal(JSON.stringify(stored), frozen, 'the cached row is never mutated');
    assert.equal(deriveCustomState(stored, 'org1'), deriveCustomState(stored, 'org1'), 'memoised per stored row');
});

test('Community keeps only migrated types enforced; Enterprise all of them; invalid ones never', async () => {
    const created = { id: 'cdt_00000000a1', name: 'New', method: 'words', tokenKey: 'new_word', words: { values: ['Osprey'], wholeWord: true } };
    const red = { id: 'cdt_00000000b2', name: 'Red', method: 'words', tokenKey: 'red', status: 'invalid', words: { values: [] } };
    const legacy = migrateLegacyTerms('org1', TERMS.slice(0, 1))[0];
    const stored = {
        customDataTypes: [legacy, created, red],
        piiDetectionCategories: ['Email', legacy.id, created.id, red.id],
        toolPiiPolicy: { external: { blockCategories: [created.id] }, internal: { blockCategories: [] } },
    };
    const build = () => ({ piiDetectionCategories: stored.piiDetectionCategories, toolPiiPolicy: stored.toolPiiPolicy, webSearchGuardPiiCategories: [created.id] });

    const community = await applyCustomTypes(build(), stored, 'org1', { lic: lic('community'), featureCacheMs: 0 });
    assert.deepEqual(community.customDataTypes.map(t => t.id), [legacy.id]);
    assert.deepEqual(community.piiDetectionCategories, ['Email', legacy.id]);
    assert.deepEqual(community.toolPiiPolicy.external.blockCategories, []);
    assert.deepEqual(community.webSearchGuardPiiCategories, []);
    assert.equal(registry.lookup(created.id), null);

    const enterprise = await applyCustomTypes(build(), stored, 'org1', { lic: lic('enterprise'), featureCacheMs: 0 });
    assert.deepEqual(enterprise.customDataTypes.map(t => t.id), [legacy.id, created.id]);
    assert.deepEqual(enterprise.piiDetectionCategories, ['Email', legacy.id, created.id]);
    assert.deepEqual(enterprise.toolPiiPolicy.external.blockCategories, [created.id]);
    assert.equal(registry.displayNameFor(created.id), 'New');
});

test('a row without any custom data resolves byte-for-byte as before', async () => {
    const lists = ['Email', 'Person'];
    const policy = { external: { blockCategories: ['Email'] }, internal: { blockCategories: [] } };
    const r = await applyCustomTypes({ piiDetectionCategories: lists, toolPiiPolicy: policy }, { piiDetectionCategories: lists }, 'org2', { lic: lic('community') });
    assert.equal(r.piiDetectionCategories, lists);
    assert.equal(r.toolPiiPolicy, policy);
    assert.deepEqual(r.customDataTypes, []);
    assert.equal(r.customTypesDigest, '');
});

test('the runtime remembers the licence answer per org for a minute; the save route asks fresh', async () => {
    let calls = 0;
    const counting = { tiers, hasFeature: async () => { calls += 1; return true; } };
    await hasCustomDataFeature('orgM', counting, { cacheMs: 60_000 });
    await hasCustomDataFeature('orgM', counting, { cacheMs: 60_000 });
    assert.equal(calls, 1);
    await hasCustomDataFeature('orgM', counting);
    assert.equal(calls, 2, 'no cacheMs: always asked');
});

test('the licence is the target org\'s, and a resolver error fails closed', async () => {
    const calls = [];
    const spy = { tiers, hasFeature: async (scope, f) => { calls.push([scope, f]); return true; } };
    assert.equal(await hasCustomDataFeature('orgX', spy), true);
    assert.deepEqual(calls, [[{ organizationId: 'orgX' }, 'custom_data_types']], 'no userId: a personal licence does not unlock an org');
    assert.equal(await hasCustomDataFeature('orgX', { hasFeature: async () => { throw new Error('db down'); } }), false);
    assert.equal(await hasCustomDataFeature('orgX', { tiers, resolveTier: async () => 'enterprise' }), true, 'tier fallback');
});
