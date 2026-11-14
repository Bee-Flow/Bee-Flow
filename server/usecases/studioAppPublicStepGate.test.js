/**
 * The kind gate of the anonymous step route: every base kind keeps the answer it had, a
 * registry kind is closed unless its policy says the public page may post it.
 *
 * Run: cd server && node --test usecases/studioAppPublicStepGate.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { publicStepRefusal } = require('./studioAppPublicStepGate.mts');
const registry = require('../appStudio/componentSpecs/stepRegistry');
const { BASE_STEP_META } = require('../appStudio/componentSpecs/stepMeta');
const kinds = require('../appStudio/componentSpecs/actionSpecsActionKinds');

const NOT_SERVER = { status: 400, error: 'This step does not run on the server' };
const NOT_PUBLIC = { status: 403, error: 'This step is not available on a public app' };

test('every base kind gets the answer the route always gave', () => {
    // The two lists the route used to read, spelled out: the gate may not move a base kind.
    const denied = ['kb_log_query', 'kb_log_review'];
    for (const kind of kinds.BASE_STEP_KINDS) {
        const expected = !kinds.BASE_DATA_MUTATING_STEP_KINDS.includes(kind) ? NOT_SERVER : (denied.includes(kind) ? NOT_PUBLIC : null);
        assert.deepEqual(publicStepRefusal(kind), expected, kind);
    }
    // ai_browse streams on its own endpoint; what the plain route answers for it is the executor's business, as before.
    assert.equal(BASE_STEP_META.ai_browse.policy.public, 'stream');
    assert.equal(publicStepRefusal('ai_browse'), null);
});

test('a kind the catalogue does not know is not a server step', () => {
    for (const kind of ['never_heard_of', 'constructor', '__proto__', 'toString', '', null, undefined, 7, {}, ['create_record']]) {
        assert.deepEqual(publicStepRefusal(kind), NOT_SERVER, String(kind));
    }
});

/** The gate over the base catalogue plus registry entries made up here. */
function tablesWith(/** @type {Record<string, unknown>[]} */ entries) {
    const table = registry.stepMetaTable(/** @type {any} */ (entries));
    const lists = registry.extendKindLists(kinds.BASE_STEP_KINDS, kinds.BASE_DATA_MUTATING_STEP_KINDS, /** @type {any} */ (entries));
    return {
        serverKinds: lists.DATA_MUTATING_STEP_KINDS,
        metaOf: (/** @type {unknown} */ kind) => (typeof kind === 'string' && Object.hasOwn(table, kind) ? table[kind] : null),
        isBaseKind: (/** @type {string} */ kind) => Object.hasOwn(BASE_STEP_META, kind),
    };
}

const [guarded, probe] = registry.loadStepKindFiles(path.join(__dirname, '..', 'appStudio', 'componentSpecs', 'stepRegistry.fixtures', 'steps'));
const withPublic = (/** @type {string} */ value, kind = 'zz_probe') => ({ ...probe, kind, policy: { ...probe.policy, public: value } });

test('a registry server kind passes only when its policy says the public page may post it', () => {
    assert.equal(probe.policy.public, 'refuse');
    assert.deepEqual(publicStepRefusal('zz_probe', tablesWith([probe])), NOT_PUBLIC);
    assert.equal(publicStepRefusal('zz_probe', tablesWith([withPublic('step')])), null);
    // A streaming kind never reaches the plain step executor; 'browser' is not a server answer at all.
    assert.deepEqual(publicStepRefusal('zz_probe', tablesWith([withPublic('stream')])), NOT_PUBLIC);
    assert.deepEqual(publicStepRefusal('zz_probe', tablesWith([withPublic('browser')])), NOT_PUBLIC);
});

test('a registry kind with a missing or unknown answer is closed', () => {
    for (const value of [undefined, null, '', 'run', 'yes', true]) {
        assert.deepEqual(publicStepRefusal('zz_probe', tablesWith([withPublic(/** @type {any} */ (value))])), NOT_PUBLIC, String(value));
    }
    // A server kind the lists hold but no row describes.
    const tables = tablesWith([probe]);
    assert.deepEqual(publicStepRefusal('zz_probe', { ...tables, metaOf: () => null }), NOT_PUBLIC);
});

test('a registry kind that is not a server kind is the 400 a client step always was', () => {
    assert.deepEqual(publicStepRefusal('zz_guarded', tablesWith([guarded, probe])), NOT_SERVER);
});

test('the base kinds answer the same with registry kinds next to them', () => {
    const tables = tablesWith([guarded, withPublic('step')]);
    for (const kind of kinds.BASE_STEP_KINDS) assert.deepEqual(publicStepRefusal(kind, tables), publicStepRefusal(kind), kind);
});

test('nothing shipped in the registry reaches the route without saying so', () => {
    for (const entry of registry.EXTENSION_STEP_ENTRIES) {
        if (entry.side !== 'server') continue;
        const refusal = publicStepRefusal(entry.kind);
        assert.equal(refusal === null, entry.policy.public === 'step', `${entry.kind}: only policy.public 'step' opens the public step route`);
    }
});
