/**
 * migrate.js — v1 → v2 is a lossless identity + two seeds. Every v1 template
 * (our v1 sample definitions) must migrate and then canonicalize + validate
 * with zero errors, proving the v2 contract is a strict superset of v1.
 *
 * Run: node --test appStudio/migrate.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { migrateV1toV2 } = require('./migrate');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { TEMPLATES } = require('./templates');
const { SCHEMA_VERSION_CURRENT } = require('./componentSpecs');

test('migrateV1toV2 bumps the version and seeds roles when absent', () => {
    const v1 = { schemaVersion: 1, meta: { name: 'x' }, screens: [], actions: {} };
    const out = migrateV1toV2(v1);
    assert.equal(out.schemaVersion, SCHEMA_VERSION_CURRENT);
    assert.deepEqual(out.roles, []);
    // lossless: every original field is preserved by reference
    assert.equal(out.meta, v1.meta);
    assert.equal(out.screens, v1.screens);
    assert.equal(out.actions, v1.actions);
});

test('migrateV1toV2 never mutates its input', () => {
    const v1 = Object.freeze({ schemaVersion: 1, meta: { name: 'x' }, screens: [], actions: {} });
    const before = JSON.stringify(v1);
    const out = migrateV1toV2(v1); // would throw if it mutated the frozen input
    assert.notEqual(out, v1);
    assert.equal(JSON.stringify(v1), before);
    assert.equal(v1.schemaVersion, 1, 'original version untouched');
});

test('migrateV1toV2 preserves an existing roles list (idempotent on v2)', () => {
    const roles = [{ id: 'admin', name: 'Admin' }];
    const v2 = { schemaVersion: 2, meta: { name: 'x' }, roles, screens: [], actions: {} };
    const out = migrateV1toV2(v2);
    assert.equal(out.schemaVersion, SCHEMA_VERSION_CURRENT);
    assert.equal(out.roles, roles, 'existing roles kept by reference');
    // re-migrating is a no-op except a shallow copy
    const again = migrateV1toV2(out);
    assert.deepEqual(again, out);
});

test('non-object input is returned unchanged (validate/canonicalize own that error)', () => {
    for (const bad of [null, undefined, 42, 'x', [1, 2]]) {
        assert.equal(migrateV1toV2(bad), bad);
    }
});

// The load-bearing guarantee: every v1 sample (template) migrates and then
// canonicalizes + validates with zero errors. (The gallery also ships v2
// data-backed templates — those are exercised by templates.test.js against the
// v2 pipeline; this loop is specifically about the v1 → v2 migration seam, so
// it covers only the v1 samples.)
const V1_TEMPLATES = TEMPLATES.filter((t) => t.definition.schemaVersion === 1);
for (const t of V1_TEMPLATES) {
    test(`v1 template ${t.id} migrates → validates with zero errors`, () => {
        assert.equal(t.definition.schemaVersion, 1, 'template is a v1 sample');

        // migrate → validate directly (templates are already complete v1 defs)
        const migrated = migrateV1toV2(t.definition);
        assert.equal(migrated.schemaVersion, SCHEMA_VERSION_CURRENT);
        const direct = validateAppDefinition(migrated);
        assert.deepEqual(direct.errors.map((e) => `${e.code} @ ${e.path}`), [], `${t.id} errors after migrate`);
        const unexpected = direct.warnings.filter((w) => w.code !== 'action.automation_unset');
        assert.deepEqual(unexpected.map((w) => `${w.code} @ ${w.path}`), [], `${t.id} unexpected warnings after migrate`);

        // and through the full canonicalize pipeline too
        const { def } = canonicalizeAppDefinition(migrated);
        assert.equal(def.schemaVersion, SCHEMA_VERSION_CURRENT);
        assert.equal(validateAppDefinition(def).ok, true, `${t.id} not ok after canonicalize`);
    });
}

test('canonicalize applies the same migration inline (a v1 def in → v2 out, no schema repair)', () => {
    const { def, repairs } = canonicalizeAppDefinition(TEMPLATES[0].definition);
    assert.equal(def.schemaVersion, SCHEMA_VERSION_CURRENT);
    assert.deepEqual(def.roles, []);
    assert.ok(!repairs.some((r) => r.code === 'shape.schema_version'), 'v1 → v2 migration is silent, not a repair');
});
