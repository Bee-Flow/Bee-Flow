// @typecheck
/**
 * aiStepEnum: the output schema as tool parameters, and the allowed values
 * (`enumFrom`) from run data to the model and back into the schema. Synthetic
 * data only.
 *
 * Run: node --test core/automationRunner/aiStepEnum.test.js
 */

'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const {
    toToolParameters, resolveLists, allowedValuesMessage, guardedListsOf, injectEnums, ALLOWED_VALUES_HEADER,
} = require('./aiStepEnum');

afterEach(() => { delete process.env.AUTOMATION_AI_ENUM_MAX_VALUES; });

// ── toToolParameters ───────────────────────────────────────────────────────

test('a JSON Schema object is deep-cloned, not shared', () => {
    const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
    const params = toToolParameters(schema);
    assert.deepStrictEqual(params, schema);
    params.properties.summary.enum = ['x'];
    assert.strictEqual(schema.properties.summary.enum, undefined, 'the step definition is never touched');
});

test('the flat { field: type } map becomes an object schema', () => {
    const params = toToolParameters({ digest: 'string', total: 'number', when: 'datetime', rows: 'array', odd: 'colour', extra: { type: 'string', enum: ['a'] } });
    assert.deepStrictEqual(params, {
        type: 'object',
        properties: {
            digest: { type: 'string' },
            total: { type: 'number' },
            when: { type: 'string', format: 'date-time' },
            rows: { type: 'array' },
            odd: { type: 'string' },
            extra: { type: 'string', enum: ['a'] },
        },
    });
});

test('anything else is not a tool definition', () => {
    for (const bad of [null, undefined, 'string', 3, [], {}, { type: 'string' }, { type: 'object' }, { type: 'object', properties: 'x' }, { anyOf: [] }, { a: 1 }, { a: null }]) {
        assert.strictEqual(toToolParameters(bad), null, JSON.stringify(bad));
    }
});

// ── resolveLists ───────────────────────────────────────────────────────────

const runState = () => ({
    steps: {
        s1: { output: { rows: [{ id: ' a ', name: { en: 'Alpha' } }, { id: 'b', name: { en: 'Beta' } }, { id: 'a' }, { id: '' }, { id: null }, 7] } },
        syn: { synthesised: true, output: { rows: [{ id: 'x' }] } },
    },
    vars: { tags: ['red', 'green', 'red', '', 5, true, { not: 'scalar' }] },
    secrets: { hidden: ['no'] },
});

test('values are read through the item path, trimmed, deduplicated, empty ones dropped', () => {
    const [l] = resolveLists([{ field: 'category', ref: 'steps.s1.output.rows', value: 'id' }], runState(), { mode: 'live', ctx: {} });
    assert.deepStrictEqual(l.values, ['a', 'b']);
    assert.strictEqual(l.ok, true);
    assert.strictEqual(l.sendable, true);
    assert.strictEqual(l.ignoreCase, true);
    assert.strictEqual(l.allowEmpty, false);
    const [nested] = resolveLists([{ field: 'f', ref: 'steps.s1.output.rows', value: 'name.en' }], runState(), { mode: 'live', ctx: {} });
    assert.deepStrictEqual(nested.values, ['Alpha', 'Beta']);
});

test('a list of plain values needs no item path; objects without one are skipped', () => {
    const [l] = resolveLists([{ field: 'tag', ref: 'vars.tags', ignoreCase: false, allowEmpty: true }], runState(), { mode: 'live', ctx: {} });
    assert.deepStrictEqual(l.values, ['red', 'green', '5', 'true']);
    assert.strictEqual(l.ignoreCase, false);
    assert.strictEqual(l.allowEmpty, true);
});

test('a ref that is not a list resolves to ok: false', () => {
    const [l] = resolveLists([{ field: 'x', ref: 'steps.s1.output.nothing' }], runState(), { mode: 'live', ctx: {} });
    assert.strictEqual(l.ok, false);
    assert.strictEqual(l.sendable, false);
});

test('secrets are never readable as a list', () => {
    const [l] = resolveLists([{ field: 'x', ref: 'secrets.hidden' }], runState(), { mode: 'live', ctx: {} });
    assert.strictEqual(l.ok, false);
});

test('a dry run skips a list that comes from synthesised data', () => {
    const entries = [{ field: 'x', ref: 'steps.syn.output.rows', value: 'id' }];
    assert.deepStrictEqual(resolveLists(entries, runState(), { mode: 'dry_run', ctx: {} }), []);
    assert.strictEqual(resolveLists(entries, runState(), { mode: 'live', ctx: {} }).length, 1);
});

test('a list over the cap is checked afterwards but not sent', () => {
    process.env.AUTOMATION_AI_ENUM_MAX_VALUES = '2';
    const rs = { steps: { s: { output: { v: ['a', 'b', 'c'] } } } };
    const [l] = resolveLists([{ field: 'f', ref: 'steps.s.output.v' }], rs, { mode: 'live', ctx: {} });
    assert.deepStrictEqual(l.values, ['a', 'b', 'c'], 'the whole list stays available for the check');
    assert.strictEqual(l.sendable, false);
    assert.strictEqual(allowedValuesMessage([l]), null);
    process.env.AUTOMATION_AI_ENUM_MAX_VALUES = '0';
    assert.strictEqual(resolveLists([{ field: 'f', ref: 'steps.s.output.v' }], rs, { mode: 'live', ctx: {} })[0].sendable, true, '0 = unlimited');
});

// ── the guarded message round trip ─────────────────────────────────────────

test('the message carries every sendable list, and the lists come back out of the GUARDED copy', () => {
    const lists = [
        { field: 'owner', values: ['Jan Jansen', 'Piet Pietersen'], sendable: true },
        { field: 'items[].kind', values: ['a', 'b'], sendable: true },
        { field: 'skipped', values: ['z'], sendable: false },
    ];
    const msg = allowedValuesMessage(lists);
    assert.strictEqual(msg.role, 'user');
    assert.ok(msg.content.startsWith(`${ALLOWED_VALUES_HEADER}\n`));
    assert.strictEqual(guardedListsOf(msg).skipped, undefined);

    // A guard that tokenises a name, in place, the way guardAiInput does.
    msg.content = msg.content.replaceAll('Jan Jansen', '[person_1]').replaceAll('Piet Pietersen', '[person_2]');
    assert.doesNotMatch(msg.content, /Jansen|Pietersen/);
    assert.deepStrictEqual(guardedListsOf(msg), { owner: ['[person_1]', '[person_2]'], 'items[].kind': ['a', 'b'] });
});

test('a message the guard left unparseable yields no lists', () => {
    assert.strictEqual(guardedListsOf({ role: 'user', content: `${ALLOWED_VALUES_HEADER}\n{broken` }), null);
    assert.strictEqual(guardedListsOf({ role: 'user', content: 'no newline' }), null);
    assert.strictEqual(guardedListsOf(null), null);
});

// ── injectEnums ────────────────────────────────────────────────────────────

test('enum lands at top-level and nested list-item paths; a missing type becomes string', () => {
    const params = toToolParameters({
        type: 'object',
        properties: {
            category: { type: 'string' },
            bare: {},
            items: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' } } } },
        },
    });
    const n = injectEnums(params, { category: ['[person_1]', 'b'], bare: ['x'], 'items[].kind': ['p', 'q', 'p'] });
    assert.strictEqual(n, 3);
    assert.deepStrictEqual(params.properties.category.enum, ['[person_1]', 'b']);
    assert.deepStrictEqual(params.properties.bare, { type: 'string', enum: ['x'] });
    assert.deepStrictEqual(params.properties.items.items.properties.kind.enum, ['p', 'q']);
});

test('allowEmpty fields also accept the empty text, so a strict schema can leave them empty', () => {
    const params = toToolParameters({
        type: 'object',
        properties: { category: { type: 'string' }, owner: { type: 'string' } },
    });
    assert.strictEqual(injectEnums(params, { category: ['a', 'b'], owner: ['x'] }, ['category']), 2);
    assert.deepStrictEqual(params.properties.category.enum, ['a', 'b', '']);
    assert.deepStrictEqual(params.properties.owner.enum, ['x'], 'a field without allowEmpty stays strict');
    // a field with no sendable values gets no enum at all, so nothing is forced
    const bare = toToolParameters({ type: 'object', properties: { category: { type: 'string' } } });
    assert.strictEqual(injectEnums(bare, { category: [] }, ['category']), 0);
    assert.deepStrictEqual(bare.properties.category, { type: 'string' });
});

test('non-string leaves, undeclared fields and bad shapes get no enum', () => {
    const params = toToolParameters({
        type: 'object',
        properties: { count: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } } },
    });
    const before = JSON.stringify(params);
    assert.strictEqual(injectEnums(params, { count: ['1'], missing: ['x'], 'count[]': ['a'], '': ['a'], bad: 'nope' }), 0);
    assert.strictEqual(JSON.stringify(params), before, 'nothing changed');
    assert.strictEqual(injectEnums(params, { 'tags[]': ['a'] }), 1, 'a list of strings takes its enum on the item schema');
    assert.deepStrictEqual(params.properties.tags.items, { type: 'string', enum: ['a'] });
    assert.strictEqual(injectEnums(params, null), 0);
    assert.strictEqual(injectEnums(null, { a: ['x'] }), 0);
});
