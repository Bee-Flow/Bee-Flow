'use strict';
/**
 * resolveOrgShield and "Your own data": the resolved shield carries the
 * org's types (migrated from the old terms when the row predates them),
 * clamped to the TARGET org's licence, with normalised category lists, and
 * the registry synced so a scan can resolve the ids. The self-check counts
 * the migrated patterns that fell back to the V8 worker.
 *
 * Seams: orgShield._deps (configStore, getAIConfig, license), swapped per
 * test; no module-system interception.
 *
 * Run: cd server && node --test core/privacy/orgShield.customTypes.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const orgShield = require('./orgShield');
const registry = require('./customTypes/registry');
const { migrateLegacyTerms } = require('./customTypes/migrate');
const { ALL_PII_CATEGORY_IDS } = require('./piiDetection/categories');
const tiers = require('../../license/tiers');
const log = require('../../telemetry/log');

const rows = {};
let tier = 'community';
const original = { ...orgShield._deps };
test.before(() => {
    orgShield._deps.configStore = {
        getConfig: async (k) => (rows[k] === undefined ? null : rows[k]),
        getAllConfig: async () => ({ ...rows }),
    };
    orgShield._deps.getAIConfig = async () => ({});
    orgShield._deps.license = () => ({ tiers, resolveTier: async () => tier, hasFeature: async (s, f) => tiers.tierHasFeature(tier, f) });
});
test.after(() => Object.assign(orgShield._deps, original));
test.beforeEach(() => {
    registry._resetRegistry();
    require('./customTypes/resolve')._resetFeatureMemo();
    for (const k of Object.keys(rows)) delete rows[k];
    tier = 'community';
});

const TERMS = [
    { id: 't1', label: 'Projectnaam', pattern: 'Aurora', type: 'literal' },
    { id: 't2', label: 'Vooruit', pattern: 'KC-(?=\\d{4})\\d{4}', type: 'regex' },
];
const NEW = { id: 'cdt_00000000a1', name: 'Customer numbers', method: 'pattern', tokenKey: 'customer_number', pattern: { source: 'KL-\\d{5}', engine: 're2' }, origin: 'created' };

test('an old row: its terms become types, hidden from the AI, and scans can resolve them', async () => {
    rows.org_privacy_shield_org1 = { enabled: true, piiDetectionCategories: [], customSensitiveTerms: TERMS };
    const ids = migrateLegacyTerms('org1', TERMS).map(t => t.id);
    const r = await orgShield.resolveOrgShield('org1');
    assert.deepEqual(r.customDataTypes.map(t => t.id), ids);
    assert.deepEqual(r.piiDetectionCategories, [...ALL_PII_CATEGORY_IDS, ...ids]);
    assert.equal(r.customSensitiveTerms, rows.org_privacy_shield_org1.customSensitiveTerms, 'the mirror field still passes through');
    assert.match(r.customTypesDigest, /^[0-9a-f]{16}$/);
    assert.equal(registry.displayNameFor(ids[0]), 'Projectnaam');
    assert.equal(rows.org_privacy_shield_org1.customDataTypes, undefined, 'the cached row is not written to');
});

test('Community enforces only migrated types; Enterprise all', async () => {
    const legacy = migrateLegacyTerms('org1', TERMS.slice(0, 1));
    rows.org_privacy_shield_org1 = {
        enabled: true, customDataTypes: [...legacy, NEW],
        piiDetectionCategories: ['Email', legacy[0].id, NEW.id],
        toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [NEW.id] } },
    };
    let r = await orgShield.resolveOrgShield('org1');
    assert.deepEqual(r.customDataTypes.map(t => t.id), [legacy[0].id]);
    assert.deepEqual(r.piiDetectionCategories, ['Email', legacy[0].id]);
    assert.deepEqual(r.toolPiiPolicy.internal.blockCategories, []);
    tier = 'enterprise';
    require('./customTypes/resolve')._resetFeatureMemo(); // the runtime remembers the answer for a minute
    r = await orgShield.resolveOrgShield('org1');
    assert.deepEqual(r.customDataTypes.map(t => t.id), [legacy[0].id, NEW.id]);
    assert.deepEqual(r.toolPiiPolicy.internal.blockCategories, [NEW.id]);
    assert.equal(registry.displayNameFor(NEW.id), 'Customer numbers');
});

test('an org without custom data resolves as before, plus two empty fields', async () => {
    rows.org_privacy_shield_org2 = { enabled: true, piiDetectionCategories: ['Email'] };
    const r = await orgShield.resolveOrgShield('org2');
    assert.deepEqual(r.piiDetectionCategories, ['Email']);
    assert.deepEqual(r.customDataTypes, []);
    assert.equal(r.customTypesDigest, '');
    const user = await orgShield.resolveUserShield('u1', { allowImplicitDefault: true });
    assert.deepEqual([user.customDataTypes, user.customTypesDigest], [[], '']);
});

test('the self-check counts V8 fallbacks and red types by id, never by name', async () => {
    rows.org_privacy_shield_org1 = { enabled: true, customSensitiveTerms: [...TERMS, { id: 't3', label: 'Geheim-label', pattern: '([', type: 'regex' }] };
    const lines = [];
    const saved = { info: log.info, warn: log.warn };
    log.info = (...a) => lines.push(a.join(' '));
    log.warn = (...a) => lines.push(a.join(' '));
    try { await orgShield.selfCheckOrgShields(); } finally { Object.assign(log, saved); }
    const summary = lines.find(l => l.includes('shield(s) scanned'));
    assert.match(summary, /customTypes=2, re2Fallbacks=1/);
    assert.ok(lines.some(l => /data type cdt_[0-9a-f]{10} is invalid/.test(l)));
    assert.ok(!lines.some(l => l.includes('Geheim-label') || l.includes('Projectnaam')), 'names stay out of the log');
});
