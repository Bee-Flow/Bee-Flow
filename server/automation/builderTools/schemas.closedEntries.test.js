/**
 * A batch entry whose shape is fully declared is CLOSED to extra keys.
 *
 * llama.cpp compiles the tool schema into the decoding grammar, so the schema
 * is not documentation there — it is the only thing that can physically stop a
 * small model from emitting the wrong shape. With the entry open, every live
 * build put `label`, `afterStepId`, `forEach` and `branch` beside `spec`
 * instead of in it (the server lifts them and warns, so it never broke — it
 * just cost tokens on every entry of every round), and at temperature the model
 * wandered further: `"{spec": …`, `"{kind": "literal"` — keys that are not keys,
 * from a call that no longer means what it meant.
 *
 * Measured 2026-09-16, real core menu, builder_add_steps forced, temp 0.7,
 * 12 runs each: entry open 10/12 clean with 2 corrupt keys; entry closed 12/12
 * with 0. `spec` and `patch` stay free-form objects, so closing the entry takes
 * away nothing the builder could express — only places to put it wrongly.
 *
 * The remaining open entries are listed below rather than closed silently: each
 * is a decision, and an eleventh open one should be a deliberate choice too.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/schemas.closedEntries.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { TOOL_SCHEMAS } = require('./schemas');

/** Every array-of-objects parameter whose item shape declares its properties. */
function batchEntries() {
    const out = [];
    for (const t of TOOL_SCHEMAS) {
        const props = t.function?.parameters?.properties || {};
        for (const [key, v] of Object.entries(props)) {
            const items = v && v.type === 'array' ? v.items : null;
            if (items && items.type === 'object' && items.properties) {
                out.push({ tool: t.function.name, key, items });
            }
        }
    }
    return out;
}

// Closed because the model demonstrably wandered in them. Both carry a
// free-form escape hatch (`spec`, `patch`), so nothing is lost.
const MUST_BE_CLOSED = [
    ['builder_add_steps', 'steps'],
    ['builder_update_steps', 'updates'],
];

// Still open. Not a bug in itself — no live failure has been traced to these —
// but the same exposure applies, so the list is written down rather than left
// to be discovered again.
const KNOWN_OPEN = [
    ['builder_propose_trigger', 'params'],
    ['builder_add_data_extraction', 'fields'],
    ['builder_create_layer', 'params'],
    ['builder_set_layer_contract', 'params'],
    ['builder_generate_layer', 'params'],
    ['builder_generate_layers', 'layers'],
    ['builder_set_plan', 'todos'],
    ['builder_add_switch', 'cases'],
    ['builder_add_datatable', 'where'],
    ['builder_add_datatable', 'sort'],
    ['builder_create_datatable', 'fields'],
];

test('the entries that carry a free-form escape hatch are closed', () => {
    for (const [tool, key] of MUST_BE_CLOSED) {
        const e = batchEntries().find((x) => x.tool === tool && x.key === key);
        assert.ok(e, `${tool}.${key} is gone — update MUST_BE_CLOSED`);
        assert.strictEqual(e.items.additionalProperties, false,
            `${tool}.${key} is open again: the grammar will let the model put fields beside the entry shape`);
    }
});

test('a closed entry still has somewhere to put everything else', () => {
    // The point of closing is to move fields INTO the escape hatch, not to
    // forbid them. If the hatch ever gained its own properties the entry would
    // become genuinely restrictive and this rule would need rethinking.
    for (const [tool, key, hatch] of [['builder_add_steps', 'steps', 'spec'], ['builder_update_steps', 'updates', 'patch']]) {
        const e = batchEntries().find((x) => x.tool === tool && x.key === key);
        const h = e.items.properties[hatch];
        assert.strictEqual(h.type, 'object', `${tool}.${key}.${hatch} must stay an object`);
        assert.ok(!h.properties, `${tool}.${key}.${hatch} gained properties — it is no longer a free-form hatch`);
    }
});

test('no NEW batch entry is left open without a decision', () => {
    const declared = new Set([...MUST_BE_CLOSED, ...KNOWN_OPEN].map(([t, k]) => `${t}.${k}`));
    const surprises = batchEntries()
        .filter((e) => e.items.additionalProperties !== false)
        .map((e) => `${e.tool}.${e.key}`)
        .filter((id) => !declared.has(id));
    assert.deepStrictEqual(surprises, [],
        `open batch entr${surprises.length === 1 ? 'y' : 'ies'}: ${surprises.join(', ')}. `
        + 'Close it (additionalProperties: false) or add it to KNOWN_OPEN with a reason.');
});

test('every name on the known-open list is a real batch entry', () => {
    // A stale name would silently excuse a NEW open entry of the same name.
    const real = new Set(batchEntries().map((e) => `${e.tool}.${e.key}`));
    const ghosts = KNOWN_OPEN.map(([t, k]) => `${t}.${k}`).filter((id) => !real.has(id));
    assert.deepStrictEqual(ghosts, [], `no such batch entry: ${ghosts.join(', ')}`);
});

test('the known-open list does not hide an entry that was since closed', () => {
    const stale = KNOWN_OPEN.filter(([tool, key]) => {
        const e = batchEntries().find((x) => x.tool === tool && x.key === key);
        return e && e.items.additionalProperties === false;
    }).map(([t, k]) => `${t}.${k}`);
    assert.deepStrictEqual(stale, [], `${stale.join(', ')} is closed now — remove it from KNOWN_OPEN.`);
});
