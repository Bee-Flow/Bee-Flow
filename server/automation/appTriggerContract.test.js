/**
 * Unit tests for the app-trigger contract (declaration + runtime value checks).
 *
 * Run: node automation/appTriggerContract.test.js
 *
 * No DB needed — pure functions over params/values.
 */

const assert = require('assert');
const {
    PARAM_TYPES,
    MAX_PARAMS,
    MAX_JSON_VALUE_BYTES,
    MAX_STRING_VALUE,
    isAppTriggerDefinition,
    appTriggerParams,
    validateAppTriggerParams,
    checkInputValue,
} = require('./appTriggerContract');

// ── isAppTriggerDefinition ───────────────────────────────────────────
{
    assert.strictEqual(isAppTriggerDefinition({ trigger: { kind: 'app_trigger' } }), true);
    assert.strictEqual(isAppTriggerDefinition({ trigger: { kind: 'manual' } }), false);
    assert.strictEqual(isAppTriggerDefinition(null), false);
}

// ── validateAppTriggerParams: declaration rules ──────────────────────
{
    // undefined = zero-input trigger, legal.
    assert.deepStrictEqual(validateAppTriggerParams(undefined), []);
    // Valid declaration incl. every type.
    const ok = validateAppTriggerParams(PARAM_TYPES.map((t, i) => ({ name: `p_${i}`, type: t, required: i % 2 === 0, description: `input ${t}` })));
    assert.deepStrictEqual(ok, [], JSON.stringify(ok));
}
{
    // Not an array.
    assert.ok(validateAppTriggerParams({}).some((i) => i.code === 'params_shape'));
    // Leading underscore (reserved for audit keys) and leading digit rejected.
    assert.ok(validateAppTriggerParams([{ name: '_viewerUserId', type: 'string' }]).some((i) => i.code === 'param_name'));
    assert.ok(validateAppTriggerParams([{ name: '1abc', type: 'string' }]).some((i) => i.code === 'param_name'));
    // Duplicates.
    assert.ok(validateAppTriggerParams([{ name: 'a', type: 'string' }, { name: 'a', type: 'number' }])
        .some((i) => i.code === 'param_name_duplicate'));
    // Unknown type.
    assert.ok(validateAppTriggerParams([{ name: 'a', type: 'blob' }]).some((i) => i.code === 'param_type'));
    // Too many.
    const many = Array.from({ length: MAX_PARAMS + 1 }, (_, i) => ({ name: `p${i}`, type: 'string' }));
    assert.ok(validateAppTriggerParams(many).some((i) => i.code === 'params_too_many'));
    // Bad required / overlong description.
    assert.ok(validateAppTriggerParams([{ name: 'a', type: 'string', required: 'yes' }]).some((i) => i.code === 'param_required'));
    assert.ok(validateAppTriggerParams([{ name: 'a', type: 'string', description: 'x'.repeat(501) }]).some((i) => i.code === 'param_description'));
}

// ── appTriggerParams: normalization ──────────────────────────────────
{
    const def = { trigger: { kind: 'app_trigger', params: [
        { name: 'q', type: 'string' },
        { name: 'doc', type: 'file', required: true },
        { name: 'junk_type', type: 'nope' },
        'not-an-object',
        { type: 'string' }, // no name → dropped
    ] } };
    const params = appTriggerParams(def);
    assert.deepStrictEqual(params.map((p) => [p.name, p.type, p.required]), [
        ['q', 'string', false],
        ['doc', 'file', true],
        ['junk_type', 'string', false], // unknown type defaults to string
    ]);
    assert.deepStrictEqual(appTriggerParams({}), []);
}

// ── checkInputValue: string / number / boolean coercions ─────────────
{
    assert.deepStrictEqual(checkInputValue('string', 'hi'), { ok: true, value: 'hi' });
    assert.strictEqual(checkInputValue('string', 42).value, '42');
    assert.strictEqual(checkInputValue('string', 'x'.repeat(MAX_STRING_VALUE + 10)).value.length, MAX_STRING_VALUE);
    assert.strictEqual(checkInputValue('string', { a: 1 }).ok, false);

    assert.deepStrictEqual(checkInputValue('number', 3.5), { ok: true, value: 3.5 });
    assert.deepStrictEqual(checkInputValue('number', '42'), { ok: true, value: 42 });
    assert.strictEqual(checkInputValue('number', 'abc').ok, false);
    assert.strictEqual(checkInputValue('number', NaN).ok, false);

    assert.deepStrictEqual(checkInputValue('boolean', true), { ok: true, value: true });
    assert.deepStrictEqual(checkInputValue('boolean', 'false'), { ok: true, value: false });
    assert.strictEqual(checkInputValue('boolean', 1).ok, false);
}

// ── checkInputValue: array / object incl. JSON-string parsing + caps ─
{
    assert.deepStrictEqual(checkInputValue('array', [1, 2]), { ok: true, value: [1, 2] });
    assert.deepStrictEqual(checkInputValue('array', '[1,2]'), { ok: true, value: [1, 2] });
    assert.strictEqual(checkInputValue('array', '{"a":1}').ok, false); // parsed but wrong shape
    assert.strictEqual(checkInputValue('array', 'not json').ok, false);

    assert.deepStrictEqual(checkInputValue('object', { a: 1 }), { ok: true, value: { a: 1 } });
    assert.deepStrictEqual(checkInputValue('object', '{"a":1}'), { ok: true, value: { a: 1 } });
    assert.strictEqual(checkInputValue('object', [1]).ok, false);

    const big = { blob: 'x'.repeat(MAX_JSON_VALUE_BYTES + 1) };
    const r = checkInputValue('object', big);
    assert.strictEqual(r.ok, false);
    assert.ok(/too large/.test(r.error), r.error);
}

// ── checkInputValue: file descriptors ────────────────────────────────
{
    const desc = { kind: 'studio_attachment', fileId: 'att-1', name: 'a.pdf' };
    const single = checkInputValue('file', desc);
    assert.strictEqual(single.ok, true);
    assert.strictEqual(single.isFile, true);
    assert.strictEqual(single.descriptor.fileId, 'att-1');

    // A `multiple` file input with exactly one file unwraps.
    const wrapped = checkInputValue('file', [desc]);
    assert.strictEqual(wrapped.ok, true);
    assert.strictEqual(wrapped.descriptor.fileId, 'att-1');

    // Multiple files → v1 error.
    const multi = checkInputValue('file', [desc, desc]);
    assert.strictEqual(multi.ok, false);
    assert.ok(/one file/.test(multi.error), multi.error);

    // Wrong shapes.
    assert.strictEqual(checkInputValue('file', 'https://x/file.pdf').ok, false);
    assert.strictEqual(checkInputValue('file', { kind: 'other', fileId: 'x' }).ok, false);
    assert.strictEqual(checkInputValue('file', { kind: 'studio_attachment' }).ok, false);
}

console.log('appTriggerContract.test.js: all assertions passed');
