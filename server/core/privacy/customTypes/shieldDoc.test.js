'use strict';
/**
 * What a Privacy Shield save may change about "Your own data", and what the
 * GET shows. The rules live in shieldDoc.js; routes/orgPrivacyShield.js only
 * wires them (its own test covers the HTTP side).
 *
 * Run: cd server && node --test core/privacy/customTypes/shieldDoc.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { planPut, applyToGetResponse } = require('./shieldDoc');
const { migrateLegacyTerms } = require('./migrate');
const registry = require('./registry');

const NOW = '2026-09-26T12:00:00.000Z';
const TERMS = [{ id: 't1', label: 'Projectnaam', pattern: 'Aurora', type: 'literal' }];
const NEW = { id: 'cdt_00000000a1', name: 'Customer numbers', method: 'pattern', tokenKey: 'customer_number', pattern: { source: 'KL-\\d{5}' } };

function storedWithLegacy() {
    const legacy = migrateLegacyTerms('org1', TERMS);
    return {
        row: { enabled: true, piiDetectionCategories: ['Email'], customSensitiveTerms: TERMS },
        legacy,
    };
}
const put = (over) => planPut({ orgId: 'org1', featureEnabled: true, userId: 'u1', now: NOW, ...over });

test.beforeEach(() => registry._resetRegistry());

test('GET: types always present, migrated lazily with hide-from-AI on; a Community org is told its created types are frozen', () => {
    const { row, legacy } = storedWithLegacy();
    const cfg = JSON.parse(JSON.stringify(row));
    assert.deepEqual(applyToGetResponse(cfg, { orgId: 'org1', stored: row, featureEnabled: false }), []);
    assert.deepEqual(cfg.customDataTypes.map(t => t.id), [legacy[0].id]);
    assert.deepEqual(cfg.piiDetectionCategories, ['Email', legacy[0].id]);

    const withCreated = { ...row, customDataTypes: [...legacy, { ...NEW, origin: 'created' }] };
    const cfg2 = JSON.parse(JSON.stringify(withCreated));
    assert.deepEqual(applyToGetResponse(cfg2, { orgId: 'org1', stored: withCreated, featureEnabled: false }), ['customDataTypes']);
    const empty = {};
    applyToGetResponse(empty, { orgId: 'org1', stored: null, featureEnabled: true });
    assert.deepEqual(empty.customDataTypes, []);
});

test('Enterprise: the list is the admin\'s; switches only for its own types; a mirror is written', async () => {
    const { row, legacy } = storedWithLegacy();
    const body = {
        customDataTypes: [...legacy, NEW],
        piiDetectionCategories: ['Email', legacy[0].id, NEW.id, 'cdt_00000000ff'],
        toolPiiPolicy: { external: { blockCategories: [NEW.id] }, internal: { blockCategories: [] } },
    };
    const r = await put({ body, storedRow: row });
    assert.deepEqual(r.customDataTypes.map(t => t.id), [legacy[0].id, NEW.id]);
    assert.equal(r.customDataTypes[1].createdBy, 'u1');
    assert.equal(r.customDataTypes[1].pattern.engine, 're2');
    assert.deepEqual(r.lists.pii, [legacy[0].id, NEW.id]);
    assert.deepEqual(r.lists.external, [NEW.id]);
    assert.deepEqual(r.typeErrors.map(e => [e.id, e.code]), [['cdt_00000000ff', 'unknown_type']]);
    assert.deepEqual(r.mirror.map(t => [t.id, t.type]), [['t1', 'literal'], [NEW.id, 'regex']]);
    assert.deepEqual(r.removedIds, []);
});

test('an absent customDataTypes key changes nothing, and keeps the stored switches', async () => {
    const { row, legacy } = storedWithLegacy();
    const r = await put({ body: { piiDetectionCategories: ['Email'] }, storedRow: row });
    assert.equal(r.changed, false);
    assert.deepEqual(r.customDataTypes.map(t => t.id), [legacy[0].id]);
    assert.deepEqual(r.lists.pii, [legacy[0].id], 'an old client that knows no custom ids does not switch them off');
});

test('a forged legacy flag and a content error are reported per type', async () => {
    const { row, legacy } = storedWithLegacy();
    const forged = { ...NEW, id: 'cdt_00000000b2', tokenKey: 'forged', legacy: true };
    const broken = { ...NEW, id: 'cdt_00000000c3', tokenKey: 'broken', pattern: { source: '(?=x)' } };
    const r = await put({ body: { customDataTypes: [...legacy, forged, broken] }, storedRow: row });
    assert.deepEqual(r.customDataTypes.map(t => [t.id, t.status || 'ok']), [[legacy[0].id, 'ok'], ['cdt_00000000c3', 'invalid']]);
    assert.deepEqual(r.typeErrors.map(e => e.code).sort(), ['legacy_forged', 'pattern_invalid']);
    assert.deepEqual(r.enforced.map(t => t.id), [legacy[0].id], 'a red type is stored, not enforced');
});

test('Community: removing a migrated type is the one change accepted', async () => {
    const { row, legacy } = storedWithLegacy();
    const removed = await put({ featureEnabled: false, body: { customDataTypes: [] }, storedRow: row });
    assert.deepEqual(removed.customDataTypes, []);
    assert.deepEqual(removed.clamped, []);
    assert.deepEqual(removed.removedIds, [legacy[0].id]);
    assert.deepEqual(removed.mirror, []);

    const added = await put({ featureEnabled: false, body: { customDataTypes: [...legacy, NEW] }, storedRow: row });
    assert.deepEqual(added.customDataTypes.map(t => t.id), [legacy[0].id], 'frozen');
    assert.deepEqual(added.clamped, ['customDataTypes']);

    const edited = await put({ featureEnabled: false, body: { customDataTypes: [{ ...legacy[0], words: { values: ['Borealis'] } }] }, storedRow: row });
    assert.deepEqual(edited.customDataTypes[0].words.values, ['Aurora'], 'an edit is not accepted either');
    assert.deepEqual(edited.clamped, ['customDataTypes']);

    const switched = await put({ featureEnabled: false, body: { customDataTypes: legacy, piiDetectionCategories: ['Email'] }, storedRow: row });
    assert.deepEqual(switched.lists.pii, [legacy[0].id], 'a migrated type keeps hiding from the AI');
    assert.deepEqual(switched.clamped, ['customDataTypes']);
});

test('an older client editing customSensitiveTerms: the edit is migrated', async () => {
    const { row, legacy } = storedWithLegacy();
    const echo = await put({ body: { customSensitiveTerms: TERMS }, storedRow: row });
    assert.equal(echo.changed, false, 'an echo of the stored terms is not an edit');
    const r = await put({
        body: { customSensitiveTerms: [...TERMS, { id: 't2', label: 'Code', pattern: 'KC-\\d+', type: 'regex' }] },
        storedRow: { ...row, customDataTypes: legacy, piiDetectionCategories: ['Email', legacy[0].id] },
    });
    assert.equal(r.customDataTypes.length, 2);
    assert.ok(r.customDataTypes.every(t => t.legacy === true));
    assert.deepEqual(r.lists.pii, r.customDataTypes.map(t => t.id), 'a newly migrated term hides from the AI');
    assert.deepEqual(r.termErrors, []);
});

test('an id another organisation already has is refused', async () => {
    registry.syncOrg('org2', [{ ...NEW, name: 'Theirs' }]);
    const r = await put({ body: { customDataTypes: [NEW] }, storedRow: null });
    assert.deepEqual(r.customDataTypes, []);
    assert.deepEqual(r.typeErrors.map(e => e.code), ['id_taken']);

    registry._resetRegistry();
    const configStore = {
        async listKeysWithPrefix() { return ['org_privacy_shield_org1', 'org_privacy_shield_org3']; },
        async getConfigsByKeys(keys) {
            assert.deepEqual(keys, ['org_privacy_shield_org3'], 'the saving org is not compared with itself');
            return { org_privacy_shield_org3: { customDataTypes: [NEW] } };
        },
    };
    const r2 = await put({ body: { customDataTypes: [NEW] }, storedRow: null, configStore });
    assert.deepEqual(r2.typeErrors.map(e => e.code), ['id_taken'], 'found in a stored row this process never synced');
});
