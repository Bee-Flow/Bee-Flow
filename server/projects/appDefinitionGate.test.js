/**
 * The stage-prepare definition gate: a newer schema blocks, validator errors
 * are warnings, everything that is not an app is left alone.
 *
 * Run: cd server && node --test projects/appDefinitionGate.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { gateReleaseApps } = require('./appDefinitionGate.mts');
const { emptyDefinition, SCHEMA_VERSION_CURRENT } = require('../appStudio/componentSpecs');

test('a newer schema is one blocking finding per app', () => {
    const out = gateReleaseApps([
        { ref: 'app_1', kind: 'app', entity: { definition: { ...emptyDefinition('Later'), schemaVersion: SCHEMA_VERSION_CURRENT + 1 } } },
        { ref: 'app_2', kind: 'app', entity: { definition: emptyDefinition('Fine') } },
    ]);
    assert.deepEqual(out.blocking, [{ code: 'app.schema_newer', severity: 'blocking', ref: 'app_1' }]);
    assert.deepEqual(out.warnings, []);
});

test('validator errors are warnings and never block', () => {
    const out = gateReleaseApps([{ ref: 'app_1', kind: 'app', entity: { definition: { actions: {} } } }]);
    assert.deepEqual(out.blocking, []);
    assert.ok(out.warnings.length > 0);
    assert.ok(out.warnings.some((f) => f.code === 'app.screens.missing' && f.ref === 'app_1' && f.severity === 'warning'), JSON.stringify(out.warnings));
});

test('a part without a definition is gated as the empty object prepare writes for it', () => {
    const out = gateReleaseApps([{ ref: 'app_1', kind: 'app', entity: {} }]);
    assert.deepEqual(out.blocking, []);
});

test('other kinds are not looked at', () => {
    const out = gateReleaseApps([{ ref: 'aut_1', kind: 'automation', entity: { definition: { schemaVersion: 99 } } }]);
    assert.deepEqual(out, { blocking: [], warnings: [] });
});
