'use strict';

/**
 * Pins the text each former private copy produced, per caller, on one sample
 * that hits every edge the copies disagreed on: an undefined member, an
 * undefined array element, a function, a Date and integer-like keys. A cache
 * key or a stored hash built from this text must not change when the helper
 * does.
 *
 * Run: node --test utils/stableJson.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { stableStringify, sortedKeysJson } = require('./stableJson');

const sample = () => ({ z: [3, undefined, { y: 1, b: null }], a: 'x', u: undefined, '10': true, '2': new Date(0), f: () => 1 });

const NULL_MODE = '{"10":true,"2":{},"a":"x","f":undefined,"u":null,"z":[3,null,{"b":null,"y":1}]}';
const RAW_MODE = '{"10":true,"2":{},"a":"x","f":undefined,"u":undefined,"z":[3,,{"b":null,"y":1}]}';
const DROP_MODE = '{"10":true,"2":{},"a":"x","z":[3,null,{"b":null,"y":1}]}';
const DROP_TOJSON = '{"10":true,"2":"1970-01-01T00:00:00.000Z","a":"x","z":[3,null,{"b":null,"y":1}]}';
const SORTED_NO_TOJSON = '{"2":{},"10":true,"a":"x","z":[3,null,{"b":null,"y":1}]}';
const SORTED_TOJSON = '{"2":"1970-01-01T00:00:00.000Z","10":true,"a":"x","z":[3,null,{"b":null,"y":1}]}';

// undefined: 'null' (the default)
for (const caller of ['appStudio/datasetCache', 'core/automationRunner/toolMemo', 'services/appStudioRender', 'projects/stages/referenceRows']) {
    test(`${caller}: undefined -> null, member kept`, () => {
        assert.equal(stableStringify(sample()), NULL_MODE);
        assert.equal(stableStringify(undefined), 'null');
        assert.equal(stableStringify(null), 'null');
    });
}

// undefined: 'raw'
for (const caller of ['core/agentRuntime/toolRoundExecutor', 'core/agentRuntime/toolCallDedupe']) {
    test(`${caller}: leaves go through JSON.stringify unchanged`, () => {
        assert.equal(stableStringify(sample(), { undefined: 'raw' }), RAW_MODE);
        assert.equal(stableStringify(undefined, { undefined: 'raw' }), undefined);
    });
}

// undefined: 'drop'
test('appStudio/templateUpgrade: JSON drop rule, Date has no own keys', () => {
    assert.equal(stableStringify(sample(), { undefined: 'drop' }), DROP_MODE);
    assert.equal(stableStringify(undefined, { undefined: 'drop' }), 'null');
    assert.equal(stableStringify(() => 1, { undefined: 'drop' }), 'null');
});

for (const caller of ['projects/stages/model', 'stores/datatableStore/managedGuard']) {
    test(`${caller}: JSON drop rule with toJSON`, () => {
        assert.equal(stableStringify(sample(), { undefined: 'drop', toJSON: true }), DROP_TOJSON);
        assert.equal(stableStringify(undefined, { undefined: 'drop', toJSON: true }), 'null');
    });
}

// sortedKeysJson, toJSON: false (callers pass `v ?? null`)
for (const caller of ['automation/diffSummary', 'automation/fieldDiff']) {
    test(`${caller}: rebuilt with sorted keys, JSON.stringify order`, () => {
        assert.equal(sortedKeysJson(sample(), { toJSON: false }), SORTED_NO_TOJSON);
        assert.equal(sortedKeysJson(null, { toJSON: false }), 'null');
    });
}

// sortedKeysJson, toJSON (callers turn undefined into 'undefined')
for (const caller of ['automation/builderTools/suggestedPatch', 'core/llm/toolCallHygiene']) {
    test(`${caller}: replacer sort, toJSON first`, () => {
        assert.equal(sortedKeysJson(sample()), SORTED_TOJSON);
        assert.equal(sortedKeysJson(undefined), undefined);
    });
}

test('key order does not change the text, array order does', () => {
    for (const fn of [(v) => stableStringify(v), (v) => stableStringify(v, { undefined: 'drop' }), (v) => sortedKeysJson(v)]) {
        assert.equal(fn({ a: 1, b: { d: 2, c: 3 } }), fn({ b: { c: 3, d: 2 }, a: 1 }));
        assert.notEqual(fn({ a: [1, 2] }), fn({ a: [2, 1] }));
    }
});

test('an unknown undefined mode is a programming error', () => {
    assert.throws(() => stableStringify({}, { undefined: 'nope' }), TypeError);
});
