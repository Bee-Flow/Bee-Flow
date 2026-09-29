'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TOOL_SCHEMAS } = require('./builderTools/schemas');
const { MUTATING_TOOLS, DATA_MODEL_TOOLS, applyToolCall } = require('./builderTools');
const { renderDraftState } = require('./builderPrompt');
const { renderCatalogText } = require('./builderPrompt/catalogRender');
const { LIMITS, VARIABLE_TYPES } = require('./componentSpecs');

const toolByName = (name) => TOOL_SCHEMAS.find((t) => t.function && t.function.name === name);

function draft(variables) {
    return {
        def: {
            schemaVersion: 2,
            meta: { name: 'T', description: '', icon: 'LayoutGrid' },
            theme: {},
            homeScreenId: 'scr_a00001',
            roles: [],
            screens: [{ id: 'scr_a00001', name: 'Home', icon: 'Home', showInNav: true, maxWidth: 'medium', sections: [{ id: 'sec_a00001', style: {}, children: [] }] }],
            actions: {},
            ...(variables ? { variables } : {}),
        },
    };
}

const call = async (wrap, args) => applyToolCall('app_set_variables', args, wrap);

test('the tool is declared, mutating, and NOT a data-model tool', () => {
    // Not a data-model tool: that set exists so the route fires a data_model
    // SSE refresh. Variables live in the definition, which already streams.
    assert.ok(toolByName('app_set_variables'));
    assert.ok(MUTATING_TOOLS.has('app_set_variables'));
    assert.equal(DATA_MODEL_TOOLS.has('app_set_variables'), false);
});

test('the schema teaches every type the spec has', () => {
    const props = toolByName('app_set_variables').function.parameters.properties;
    assert.deepStrictEqual(props.variables.items.properties.type.enum, VARIABLE_TYPES);
    assert.deepStrictEqual(props.variables.items.required, ['name', 'type']);
});

test('a well-formed call writes the list', async () => {
    const wrap = draft();
    const res = await call(wrap, { variables: [{ name: 'statusFilter', type: 'text', default: 'new', label: 'Status' }] });
    assert.equal(res.error, undefined);
    assert.deepStrictEqual(wrap.def.variables.map((v) => v.name), ['statusFilter']);
    assert.equal(wrap.def.variables[0].default, 'new');
});

test('it replaces the whole list, like app_set_roles', async () => {
    const wrap = draft([{ name: 'a', label: 'a', type: 'text', default: '', description: '' }]);
    await call(wrap, { variables: [{ name: 'b', type: 'number', default: 1 }] });
    assert.deepStrictEqual(wrap.def.variables.map((v) => v.name), ['b']);
});

test('an empty list removes the key entirely', async () => {
    const wrap = draft([{ name: 'a', label: 'a', type: 'text', default: '', description: '' }]);
    await call(wrap, { variables: [] });
    assert.equal('variables' in wrap.def, false);
});

// The model learns the grammar from its own output rather than from a refusal.
test('a bad name comes back as a hint, not an error', async () => {
    const wrap = draft();
    const res = await call(wrap, { variables: [{ name: 'my var', type: 'text' }] });
    assert.equal(res.error, undefined);
    assert.deepStrictEqual(wrap.def.variables.map((v) => v.name), ['my_var']);
    assert.ok(res._hints && res._hints.some((h) => /my_var/.test(h)), JSON.stringify(res._hints));
});

test('dropping a variable a formula still reads warns rather than refusing', async () => {
    const wrap = draft([{ name: 'kept', label: 'k', type: 'text', default: '', description: '' }]);
    wrap.def.screens[0].sections[0].children = [
        { id: 'cmp_t00001', type: 'text', props: { text: 'x' }, computed: { text: { kind: 'formula', expr: 'vars.kept' } } },
    ];
    const res = await call(wrap, { variables: [{ name: 'other', type: 'text' }] });
    assert.equal(res.error, undefined);
    assert.ok(res._hints && res._hints.some((h) => /vars\.kept/.test(h)), JSON.stringify(res._hints));
});

test('a non-array argument is a plain error', async () => {
    const res = await call(draft(), { variables: 'nope' });
    assert.match(res.error, /array/);
});

test('over the ceiling is refused with the number in the message', async () => {
    const many = Array.from({ length: LIMITS.MAX_VARIABLES + 1 }, (_, i) => ({ name: `v${i}`, type: 'text' }));
    const res = await call(draft(), { variables: many });
    assert.match(res.error, new RegExp(String(LIMITS.MAX_VARIABLES)));
});

// ── what the model is told ──────────────────────────────────────────────────

test('the catalog teaches the variable shape, derived from the spec', () => {
    const text = renderCatalogText();
    assert.match(text, /### Variables \(app_set_variables\)/);
    for (const t of VARIABLE_TYPES) assert.ok(text.includes(t), `type ${t} not taught`);
    assert.match(text, /filters/);
    assert.match(text, new RegExp(`Max ${LIMITS.MAX_VARIABLES} per app`));
});

test('the draft state lists variables only when there are some', () => {
    const withoutKey = renderDraftState(draft().def);
    assert.equal(/^variables:/m.test(withoutKey), false);

    const withVars = renderDraftState(draft([{ name: 'a', label: 'a', type: 'number', default: 3, description: '' }]).def);
    assert.match(withVars, /^variables: a:number=3$/m);
    // Appended, not woven in — the rest of the state is untouched.
    assert.ok(withVars.startsWith(withoutKey.split('\nvariables:')[0].slice(0, 40)));
});

// ── The RETURN value, not just the draft ────────────────────────────────────
//
// Every assertion above reads wrap.def.variables. Not one read res.variables —
// so the echo could return the PREVIOUS list forever and this file stayed
// green. It did: the echo was built as an argument to adoptCanonical, which
// evaluates it BEFORE adoptCanonical reassigns draftWrap.def. Call 1 answered
// {variables:[]}, call 2 answered call 1's list. A model that trusts its own
// tool results reads [] as failure, retries with a changed payload, sees a
// non-empty list and credits whatever it changed — which is the entire origin
// of the "app_set_variables returns empty until you add a default" folklore.
// `default` was never involved.

test('the RESULT echoes the list this call stored — not the previous one', async () => {
    const wrap = draft();
    const first = await call(wrap, { variables: [{ name: 'entry', type: 'text', default: '0' }] });
    assert.equal(first.error, undefined);
    assert.deepStrictEqual(first.variables, [{ name: 'entry', type: 'text', default: '0' }],
        'call 1 must not answer with the empty list it replaced');
    assert.deepStrictEqual(first.variables.map((v) => v.name), wrap.def.variables.map((v) => v.name),
        'echo === stored');

    const second = await call(wrap, { variables: [{ name: 'acc', type: 'number', default: 0 }] });
    assert.deepStrictEqual(second.variables, [{ name: 'acc', type: 'number', default: 0 }],
        'call 2 must not answer with call 1\'s list');
});

test('the echo shows the canonicalizer\'s REPAIRS, so the model sees the real names', async () => {
    const wrap = draft();
    const res = await call(wrap, { variables: [{ name: 'my var', type: 'text' }] });
    assert.deepStrictEqual(res.variables.map((v) => v.name), ['my_var'],
        'the echo carries the repaired name, matching the hint');
    assert.deepStrictEqual(res.variables.map((v) => v.name), wrap.def.variables.map((v) => v.name));
});

test('clearing the list echoes the empty list rather than the one just removed', async () => {
    const wrap = draft([{ name: 'a', label: 'a', type: 'text', default: '', description: '' }]);
    const res = await call(wrap, { variables: [] });
    assert.equal(res.error, undefined);
    assert.deepStrictEqual(res.variables, [], 'echo === stored (the key is gone from the def)');
});
