/**
 * builder_add_set / builder_update_step — "Edit data" list mode + operations.
 *
 * Run: node --test automation/builderTools.setList.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { applyToolCall, emptyDefinition, TOOL_SCHEMAS } = require('./builderTools');
const { validateDefinition } = require('./validate');

function freshWrap() {
    return { userId: 'u_test', def: emptyDefinition() };
}

// A gmail-ish upstream producer so arrayRef refs resolve to a known step.
async function withProducer(dw) {
    const http = await applyToolCall('builder_add_http_request', { url: 'https://api.example.com/x' }, dw);
    return http.added.id;
}

const OPS = [
    { op: 'groupId', target: 'thread', keys: ['sender', 'subject'] },
    { op: 'rowId', target: 'id' },
    { op: 'sort', key: 'id', direction: 'desc' },
];

test('schema advertises the list-mode surface', () => {
    const schema = TOOL_SCHEMAS.find(t => t.function?.name === 'builder_add_set');
    assert.ok(schema.function.parameters.properties.arrayRef, 'arrayRef param');
    assert.ok(schema.function.parameters.properties.operations, 'operations param');
    assert.ok(schema.function.parameters.properties.maxItems, 'maxItems param');
    assert.match(schema.function.description, /parseJson\(/, 'teaches the parse_json replacement');
});

test('happy path: list-mode set with fields + operations validates clean', async () => {
    const dw = freshWrap();
    const hid = await withProducer(dw);
    const res = await applyToolCall('builder_add_set', {
        arrayRef: `steps.${hid}.output.body`,
        fields: { sender: { kind: 'expr', value: 'lower(item.from)' } },
        operations: OPS,
        maxItems: 500,
    }, dw);
    assert.ok(!res.error, res.error);
    assert.strictEqual(res.added.arrayRef, `steps.${hid}.output.body`);
    assert.deepStrictEqual(res.added.operations, [
        { op: 'groupId', target: 'thread', keys: ['sender', 'subject'] },
        { op: 'rowId', target: 'id' },                    // start:1 normalised away
        { op: 'sort', key: 'id', direction: 'desc' },
    ]);
    assert.strictEqual(res.added.maxItems, 500);
    assert.strictEqual(res.added.label, 'Edit data');
    const v = validateDefinition(dw.def);
    assert.deepStrictEqual(v.errors, []);
});

test('single-mode add is unchanged (no stray list keys)', async () => {
    const dw = freshWrap();
    const res = await applyToolCall('builder_add_set', {
        fields: { name: { kind: 'literal', value: 'Alice' } },
    }, dw);
    assert.ok(!res.error, res.error);
    assert.ok(!('arrayRef' in res.added));
    assert.ok(!('operations' in res.added));
    assert.ok(!('maxItems' in res.added));
});

test('rejections: arrayRef+forEach, ops without arrayRef, bad ops, >20 ops, unknown upstream', async () => {
    const dw = freshWrap();
    const hid = await withProducer(dw);
    const list = `steps.${hid}.output.body`;

    const conflict = await applyToolCall('builder_add_set', {
        arrayRef: list, fields: {}, forEach: { overRef: list, itemVar: 'item' },
    }, dw);
    assert.match(conflict.error, /cannot be combined/);

    const noList = await applyToolCall('builder_add_set', { fields: {}, operations: OPS }, dw);
    assert.match(noList.error, /operations need arrayRef/);

    for (const operations of [
        [{ op: 'explode' }],
        [{ op: 'rowId' }],
        [{ op: 'groupId', target: 'g', keys: [] }],
        [{ op: 'rename', from: 'a' }],
        [{ op: 'sort', key: 'a', direction: 'sideways' }],
        [{ op: 'rowId', target: '__proto__' }],
        Array.from({ length: 21 }, () => ({ op: 'rowId', target: 'id' })),
    ]) {
        const res = await applyToolCall('builder_add_set', { arrayRef: list, fields: {}, operations }, dw);
        assert.ok(res.error, `expected rejection for ${JSON.stringify(operations[0])} (len ${operations.length})`);
    }

    // A bad ROOT is rejected at the tool boundary; an unknown STEP ID is the
    // validator's job on save (same contract as forEach.overRef / loop.overRef).
    const badRoot = await applyToolCall('builder_add_set', { arrayRef: 'results.items', fields: {} }, dw);
    assert.match(badRoot.error, /unknown root/);

    // Only the producer + nothing else — every rejection rolled back cleanly.
    assert.strictEqual(dw.def.steps.length, 1);
});

test('builder_update_step: operations replace wholesale; null clears; arrayRef null exits list mode', async () => {
    const dw = freshWrap();
    const hid = await withProducer(dw);
    const list = `steps.${hid}.output.body`;
    const added = (await applyToolCall('builder_add_set', {
        arrayRef: list, fields: { a: { kind: 'literal', value: 1 } }, operations: OPS, maxItems: 9,
    }, dw)).added;

    const up1 = await applyToolCall('builder_update_step', {
        stepId: added.id,
        patch: { operations: [{ op: 'keep', keys: ['thread'] }] },
    }, dw);
    assert.ok(!up1.error, up1.error);
    assert.deepStrictEqual(up1.updated.operations, [{ op: 'keep', keys: ['thread'] }]);

    const up2 = await applyToolCall('builder_update_step', {
        stepId: added.id,
        patch: { operations: null, arrayRef: null },
    }, dw);
    assert.ok(!up2.error, up2.error);
    assert.ok(!('operations' in up2.updated), 'operations cleared');
    assert.ok(!('arrayRef' in up2.updated), 'back to single mode');
    assert.ok(!('maxItems' in up2.updated), 'maxItems dropped with list mode');
    assert.deepStrictEqual(validateDefinition(dw.def).errors, []);
});

test('builder_update_step cross-checks: ops stranded without list / forEach conflict', async () => {
    const dw = freshWrap();
    const hid = await withProducer(dw);
    const list = `steps.${hid}.output.body`;
    const added = (await applyToolCall('builder_add_set', {
        arrayRef: list, fields: {}, operations: OPS,
    }, dw)).added;

    const strand = await applyToolCall('builder_update_step', {
        stepId: added.id, patch: { arrayRef: null },
    }, dw);
    assert.match(strand.error, /operations need arrayRef/);

    const conflict = await applyToolCall('builder_update_step', {
        stepId: added.id, patch: { forEach: { overRef: list, itemVar: 'item' } },
    }, dw);
    assert.match(conflict.error, /cannot be combined/);
});

test('builder_add_steps batch: $tempId inside arrayRef is rewritten', async () => {
    const dw = freshWrap();
    const res = await applyToolCall('builder_add_steps', {
        steps: [
            { tempId: 'h', type: 'http_request', spec: { url: 'https://api.example.com/x' } },
            { tempId: 's', type: 'set', spec: { arrayRef: 'steps.$h.output.body', fields: {}, operations: [{ op: 'rowId', target: 'id' }] } },
        ],
    }, dw);
    assert.ok(!res.error, res.error);
    const setStep = dw.def.steps.find(s => s.type === 'set');
    assert.strictEqual(setStep.arrayRef, `steps.${res.idMap.h}.output.body`);
    assert.deepStrictEqual(validateDefinition(dw.def).errors, []);
});
