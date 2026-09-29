'use strict';
/**
 * The Privacy Shield document and "Your own data" over HTTP
 * (routes/orgPrivacyShield.js GET/PUT /:orgId).
 *
 *   - Enterprise: types validated per type (`typeErrors`), switches kept only
 *     for the org's own types, the mirror written to customSensitiveTerms, the
 *     test sets stored in their own encrypted row and never in the shield
 *     row, a forged `legacy` flag refused, the registry synced by the save;
 *   - Community: migrated types still shown, the one accepted change is
 *     removing them, anything else frozen with `clamped_fields`;
 *   - the licence that counts is the TARGET org's (the caller's own tier is
 *     never asked);
 *   - `customDataTests` only for org admins of an org with the feature.
 *
 * A real router behind a real app (core/http/routeHarness.js); the database
 * is an in-memory `config` table behind the recorded pool.
 *
 * Run: cd server && node --test routes/orgPrivacyShield.customTypes.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY ??= 'ci-master-encryption-key-for-tests-only!!';
process.env.SESSION_SECRET ??= 'ci-session-secret-value-at-least-32-chars-long';

const h = require('../core/http/routeHarness');

// ── an in-memory `config` table ─────────────────────────────────────────
const table = new Map();
h.recordDb((sql, params) => {
    if (/INSERT INTO config/i.test(sql)) { table.set(params[0], params[1]); return { rows: [], rowCount: 1 }; }
    if (/DELETE FROM config WHERE key = \$1/i.test(sql)) { const had = table.delete(params[0]); return { rows: [], rowCount: had ? 1 : 0 }; }
    if (/SELECT value FROM config WHERE key = \$1/i.test(sql)) {
        return table.has(params[0]) ? { rows: [{ value: table.get(params[0]) }] } : { rows: [] };
    }
    if (/SELECT key FROM config WHERE key LIKE/i.test(sql)) {
        const prefix = String(params[0]).replace(/%$/, '').replace(/\\([\\%_])/g, '$1');
        return { rows: [...table.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) };
    }
    if (/SELECT key, value FROM config WHERE key = ANY/i.test(sql)) {
        return { rows: params[0].filter(k => table.has(k)).map(key => ({ key, value: table.get(key) })) };
    }
    return undefined;
});
h.openGates({
    isOrgAdminForOrg: async (req, orgId) => req.session.user.orgAdmin === true && orgId === 'org1',
    resolveUserOrgIds: async () => new Set(['org1']),
});

// ── licence: per TARGET org, recorded ───────────────────────────────────
const tiers = require('../license/tiers');
const license = require('../license');
const tierOf = { org1: 'enterprise' };
const licenceCalls = [];
license.resolveTier = async (scope) => tierOf[scope?.organizationId] || 'community';
license.hasFeature = async (scope, f) => {
    if (f === 'custom_data_types') licenceCalls.push(scope);
    return tiers.tierHasFeature(tierOf[scope?.organizationId] || 'community', f);
};

const orgShield = require('../core/privacy/orgShield');
orgShield._deps.getAIConfig = async () => ({});

const configStore = require('../stores/configStore');
const registry = require('../core/privacy/customTypes/registry');
const { migrateLegacyTerms } = require('../core/privacy/customTypes/migrate');

const router = require('./orgPrivacyShield');
const api = h.serve('/api/org-privacy-shield', router);
test.after(api.close);

const ADMIN = { id: 'u1', organizationId: 'org1', role: 'user', orgAdmin: true };
const MEMBER = { id: 'u2', organizationId: 'org1', role: 'user', orgAdmin: false };
const KEY = 'org_privacy_shield_org1';
const TESTS_KEY = 'org_org1_custom_data_tests';
const TERMS = [{ id: 't1', label: 'Projectnaam', pattern: 'Aurora', type: 'literal', caseSensitive: false }];
const LEGACY = migrateLegacyTerms('org1', TERMS);
const NEW = { id: 'cdt_00000000a1', name: 'Customer numbers', description: 'KL numbers', method: 'pattern', tokenKey: 'customer_number', pattern: { source: 'KL-\\d{5}', caseSensitive: false } };

const stored = () => JSON.parse(table.get(KEY));
async function seed(row) {
    table.clear();
    table.set(KEY, JSON.stringify(row));
    await configStore.setConfig(KEY, row); // also busts the process cache
}
function body(over = {}) {
    const doc = stored();
    delete doc.updatedAt; delete doc.updatedBy;
    return { ...doc, ...over };
}

test.beforeEach(async () => {
    registry._resetRegistry();
    tierOf.org1 = 'enterprise';
    licenceCalls.length = 0;
    await seed({ enabled: true, piiDetectionCategories: ['Email'], customSensitiveTerms: TERMS });
});

test('GET: an old row shows its terms as migrated types, switched on; tests only for an admin', async () => {
    const res = await api.call('GET', '/api/org-privacy-shield/org1', { user: ADMIN });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.customDataTypes.map(t => [t.id, t.method, t.legacy, t.tokenKey]), [[LEGACY[0].id, 'words', true, 'customterm']]);
    assert.deepEqual(res.body.piiDetectionCategories, ['Email', LEGACY[0].id]);
    assert.deepEqual(res.body.customDataTests, {});
    const member = await api.call('GET', '/api/org-privacy-shield/org1', { user: MEMBER });
    assert.equal('customDataTests' in member.body, false);
    assert.ok(licenceCalls.length > 0);
    assert.ok(licenceCalls.every(s => s.organizationId === 'org1' && !s.userId), 'the target org\'s licence, never the caller\'s');
});

test('PUT (Enterprise): types, switches, mirror, tests apart, registry synced', async () => {
    const res = await api.call('PUT', '/api/org-privacy-shield/org1', {
        user: ADMIN,
        body: body({
            customDataTypes: [...LEGACY, NEW],
            piiDetectionCategories: ['Email', LEGACY[0].id, NEW.id, 'cdt_00000000ff'],
            toolPiiPolicy: { external: { blockCategories: ['Email', NEW.id] }, internal: { blockCategories: [] } },
            customDataTests: { [NEW.id]: { examples: ['KL-12345'], sentences: [{ id: 's1', text: 'ref KL-12345', gold: [{ start: 4, end: 12 }], origin: 'own' }] } },
        }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.typeErrors.map(e => e.code), ['unknown_type']);
    const row = stored();
    assert.deepEqual(row.customDataTypes.map(t => t.id), [LEGACY[0].id, NEW.id]);
    assert.equal(row.customDataTypes[1].createdBy, 'u1');
    assert.deepEqual(row.piiDetectionCategories, ['Email', LEGACY[0].id, NEW.id]);
    assert.deepEqual(row.toolPiiPolicy.external.blockCategories, ['Email', NEW.id]);
    assert.deepEqual(row.customSensitiveTerms.map(t => [t.id, t.type]), [['t1', 'literal'], [NEW.id, 'regex']], 'the rollback mirror');
    assert.equal('customDataTests' in row, false, 'test sentences never enter the shield row');
    assert.ok(!table.get(KEY).includes('KL-12345'), 'no example value anywhere in the shield row');
    assert.ok(table.has(TESTS_KEY), 'the tests have their own row');
    assert.ok(!table.get(TESTS_KEY).includes('KL-12345'), 'and it is encrypted');
    assert.deepEqual(res.body.config.customDataTests[NEW.id].examples, ['KL-12345']);
    assert.equal(registry.displayNameFor(NEW.id), 'Customer numbers', 'the save route fills the registry');

    const get = await api.call('GET', '/api/org-privacy-shield/org1', { user: ADMIN });
    assert.deepEqual(get.body.customDataTests[NEW.id].sentences[0].gold, [{ start: 4, end: 12 }]);
});

test('PUT: a type with a bad pattern is kept red; a forged legacy flag is refused', async () => {
    const res = await api.call('PUT', '/api/org-privacy-shield/org1', {
        user: ADMIN,
        body: body({
            customDataTypes: [
                ...LEGACY,
                { ...NEW, pattern: { source: 'KC-(?=\\d{4})' } },
                { ...NEW, id: 'cdt_00000000b2', tokenKey: 'sneaky', legacy: true },
            ],
        }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.typeErrors.map(e => [e.id, e.code]).sort(), [[NEW.id, 'pattern_invalid'], ['cdt_00000000b2', 'legacy_forged']]);
    const row = stored();
    assert.deepEqual(row.customDataTypes.map(t => [t.id, t.status || 'ok']), [[LEGACY[0].id, 'ok'], [NEW.id, 'invalid']]);
    assert.deepEqual(row.customSensitiveTerms.map(t => t.id), ['t1'], 'a red type is not mirrored');
});

test('PUT: a test set over its size limit refuses the save', async () => {
    const huge = { [NEW.id]: { examples: ['x'], sentences: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, text: 'y'.repeat(300), origin: 'own' })) } };
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`cdt_${String(i).padStart(10, '0')}`, huge[NEW.id]]));
    const types = Object.keys(many).map((id, i) => ({ ...NEW, id, tokenKey: `k${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26)]}x` }));
    const res = await api.call('PUT', '/api/org-privacy-shield/org1', { user: ADMIN, body: body({ customDataTypes: types, customDataTests: many }) });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'custom_data_tests_too_large');
    assert.equal(stored().customDataTypes, undefined, 'nothing was saved');
});

test('Community: migrated types stay; removing one is accepted, adding or editing is frozen', async () => {
    tierOf.org1 = 'community';
    const add = await api.call('PUT', '/api/org-privacy-shield/org1', {
        user: ADMIN,
        body: body({ customDataTypes: [...LEGACY, NEW], piiDetectionCategories: ['Email', LEGACY[0].id, NEW.id], customDataTests: {} }),
    });
    assert.equal(add.status, 200);
    assert.deepEqual(add.body.clamped_fields.sort(), ['customDataTests', 'customDataTypes']);
    assert.deepEqual(stored().customDataTypes.map(t => t.id), [LEGACY[0].id], 'frozen: the migrated type, now written');
    assert.deepEqual(stored().piiDetectionCategories, ['Email', LEGACY[0].id]);
    assert.equal('customDataTests' in add.body.config, false);
    assert.equal(table.has(TESTS_KEY), false);

    const remove = await api.call('PUT', '/api/org-privacy-shield/org1', { user: ADMIN, body: body({ customDataTypes: [] }) });
    assert.equal(remove.status, 200);
    assert.equal(remove.body.clamped_fields, undefined);
    assert.deepEqual(stored().customDataTypes, []);
    assert.deepEqual(stored().customSensitiveTerms, [], 'the mirror follows');
    assert.deepEqual(stored().piiDetectionCategories, ['Email']);
});

test('a legacy client saving customSensitiveTerms still gets per-term errors', async () => {
    const res = await api.call('PUT', '/api/org-privacy-shield/org1', {
        user: ADMIN,
        body: body({ customSensitiveTerms: [...TERMS, { id: 'bad', label: 'Bad', pattern: '([', type: 'regex' }, { id: 'new', label: 'Nieuw', pattern: 'Borealis', type: 'literal' }] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.termErrors.map(e => e.id), ['bad']);
    assert.deepEqual(stored().customDataTypes.map(t => t.legacyTermId), ['t1', 'new']);
    assert.deepEqual(stored().customSensitiveTerms.map(t => t.id), ['t1', 'new']);
});

test('a non-admin cannot save', async () => {
    const res = await api.call('PUT', '/api/org-privacy-shield/org1', { user: MEMBER, body: body({ customDataTypes: [NEW] }) });
    assert.equal(res.status, 403);
});
