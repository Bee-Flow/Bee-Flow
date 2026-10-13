/**
 * The shared variable vocabulary (variables.mjs) carries its own ceilings
 * because it also runs in the browser; the server catalog's LIMITS and
 * VARIABLE_SPEC must say the same, or an editor-side check and the server's
 * validation would disagree about the same declaration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import * as shared from './variables.mjs';

const require = createRequire(import.meta.url);
const specs = require('../../appStudio/componentSpecs.js');

test('the ceilings match the server LIMITS and VARIABLE_SPEC', () => {
    assert.equal(shared.MAX_VARIABLES, specs.LIMITS.MAX_VARIABLES);
    assert.equal(shared.MAX_VARIABLE_DEFAULT_BYTES, specs.LIMITS.MAX_VARIABLE_DEFAULT_BYTES);
    assert.equal(shared.MAX_VARIABLE_NAME_LEN, specs.VARIABLE_SPEC.name.maxLen);
    assert.equal(shared.MAX_VARIABLE_LABEL_LEN, specs.VARIABLE_SPEC.label.maxLen);
    assert.equal(shared.MAX_VARIABLE_DESCRIPTION_LEN, specs.VARIABLE_SPEC.description.maxLen);
});

test('text defaults are capped at the server MAX_STRING', () => {
    const long = 'x'.repeat(specs.LIMITS.MAX_STRING + 10);
    assert.deepEqual(shared.coerceVariableDefault('text', long), { value: long.slice(0, specs.LIMITS.MAX_STRING), coerced: true });
    const exact = 'x'.repeat(specs.LIMITS.MAX_STRING);
    assert.deepEqual(shared.coerceVariableDefault('text', exact), { value: exact, coerced: false });
});

test('the server catalog re-exports the shared implementation', () => {
    assert.equal(specs.coerceVariableDefault, shared.coerceVariableDefault);
    assert.equal(specs.seedVariableDefaults, shared.seedVariableDefaults);
    assert.equal(specs.VARIABLE_TYPES, shared.VARIABLE_TYPES);
});

test('the byte ceiling counts UTF-8 bytes, as Buffer.byteLength did', () => {
    const limit = shared.MAX_VARIABLE_DEFAULT_BYTES;
    const atLimit = { s: 'é'.repeat((limit - 8) / 2) };              // {"s":""} is 8 bytes, é is 2
    assert.equal(Buffer.byteLength(JSON.stringify(atLimit), 'utf8'), limit);
    assert.deepEqual(shared.coerceVariableDefault('record', atLimit), { value: atLimit, coerced: false });
    const over = { s: `${atLimit.s}x` };
    assert.deepEqual(shared.coerceVariableDefault('record', over), { value: {}, coerced: true });
    assert.deepEqual(shared.coerceVariableDefault('any', undefined), { value: null, coerced: true });
});
