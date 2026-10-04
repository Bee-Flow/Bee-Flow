/**
 * An ai_step that a FAN-OUT reads FIELDS from must declare an outputSchema.
 *
 * Without one the step answers free-form text, so every
 * `loop.<v>.output.<field>` reference into it resolves to nothing — and a
 * dry run cannot reveal it, because the write step downstream is synthesised
 * rather than called. A measured build did exactly that: read four invoices,
 * extracted nothing bindable, and finalised green (2026-09-12).
 *
 * Two things the rule must NOT do, both measured after it landed:
 *   - refuse a DIRECT `steps.<id>.output.<field>` read: execAi.js infers the
 *     schema from exactly those refs (collectAiStepOutputFields) and the
 *     automation runs — that shape only warns (`ai_step.output_schema_inferred`);
 *   - block a draft SAVE: stored automations carried the fan-out shape and
 *     validated green until now, and a label edit on any node PUTs the whole
 *     definition — so the code is completeness-listed (warn at draft, block
 *     activation), like approval.nested_forbidden.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition } = require('./validate');
const { COMPLETENESS_CODES } = require('./validate/completenessCodes');

const CODE = 'ai_step.output_schema_missing';
const WARN = 'ai_step.output_schema_inferred';
const errs = (def) => (validateDefinition(def, {}).errors || []).filter(e => e.code === CODE);
const warns = (def, opts = {}) => (validateDefinition(def, opts).warnings || []).filter(w => w.code === WARN);

const base = (aiExtra = {}, rowInputs = null) => ({
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        { id: 'a1', type: 'integration_action', tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/Invoices' } } },
        { id: 'ai1', type: 'ai_step', prompt: 'extract the invoice', forEach: { overRef: 'steps.a1.output.items', itemVar: 'f' }, ...aiExtra },
        {
            id: 'a2',
            type: 'integration_action',
            tool: 'nextcloud_tables_create_row',
            forEach: { overRef: 'steps.ai1.output.results', itemVar: 'e' },
            inputs: rowInputs || {
                tableId: { kind: 'literal', value: 4 },
                values: {
                    Datum: { kind: 'ref', path: 'loop.e.output.datum' },
                    Totaal: { kind: 'ref', path: 'loop.e.output.totaal' },
                },
            },
        },
    ],
    edges: [{ from: 'trg', to: 'a1' }, { from: 'a1', to: 'ai1' }, { from: 'ai1', to: 'a2' }],
});

test('a fan-out that reads loop.<item>.output.<field> requires the schema', () => {
    const e = errs(base());
    assert.equal(e.length, 1);
    assert.match(e[0].message, /`datum`/);
    assert.match(e[0].message, /`totaal`/);
    assert.match(e[0].hint, /"datum":\{"type":"string"\}/);
    assert.equal(e[0].path, 'steps[ai1].outputSchema', 'the path names the step by id');
});

test('declaring the schema silences it — both shapes are accepted', () => {
    assert.equal(errs(base({ outputSchema: { type: 'object', properties: { datum: { type: 'string' }, totaal: { type: 'number' } } } })).length, 0);
    // execAi also accepts a plain field map.
    assert.equal(errs(base({ outputSchema: { datum: 'string', totaal: 'number' } })).length, 0);
    // An EMPTY schema is no schema.
    assert.equal(errs(base({ outputSchema: {} })).length, 1);
});

test('a direct steps.<id>.output.<field> ref WARNS — the runner infers the schema from it and the automation runs', () => {
    const def = base({}, {
        tableId: { kind: 'literal', value: 4 },
        values: { Leverancier: { kind: 'ref', path: 'steps.ai1.output.leverancier' } },
    });
    def.steps[2].forEach = undefined;
    assert.equal(errs(def).length, 0, 'not an error at any stage');
    const v = validateDefinition(def, { stage: 'draft' });
    assert.equal(v.ok, true);
    const w = warns(def);
    assert.equal(w.length, 1);
    assert.match(w[0].message, /`leverancier`/);
    assert.match(w[0].message, /infers \{leverancier: string\}/);
    assert.match(w[0].hint, /"leverancier":\{"type":"string"\}/);
    assert.equal(w[0].path, 'steps[ai1].outputSchema');
    // Activation is not blocked either: execAi's inferred schema covers it.
    assert.equal(validateDefinition(def, {}).ok, true);
    // With the schema declared the warning is gone too.
    def.steps[1].outputSchema = { leverancier: 'string' };
    assert.equal(warns(def).length, 0);
});

test('the fan-out shape is completeness: a draft SAVE keeps working (warning tagged blockedAt activate), activation blocks', () => {
    assert.ok(COMPLETENESS_CODES.has(CODE));
    const def = base();
    const draft = validateDefinition(def, { stage: 'draft' });
    assert.equal(draft.ok, true, 'a label edit on any node PUTs the whole definition — it must save');
    assert.ok(!(draft.errors || []).some(e => e.code === CODE));
    const downgraded = (draft.warnings || []).find(w => w.code === CODE);
    assert.ok(downgraded, 'reported as a warning at draft');
    assert.equal(downgraded.blockedAt, 'activate');
    const activate = validateDefinition(def, { stage: 'activate' });
    assert.equal(activate.ok, false);
    assert.ok(activate.errors.some(e => e.code === CODE));
    // The fan-out shape never gets the softer warning on top.
    assert.equal(warns(def).length, 0);
});

test('reading only the fan-out wrapper is not a field read', () => {
    // A step that just counts the results, or passes the whole output on, has
    // no field expectations — nothing to declare.
    const def = base({}, {
        tableId: { kind: 'literal', value: 4 },
        values: { kind: 'expr', value: 'loop.e.output' },
    });
    assert.equal(errs(def).length, 0);

    const counting = base({}, { tableId: { kind: 'literal', value: 4 }, values: { N: { kind: 'ref', path: 'steps.ai1.output.succeeded' } } });
    counting.steps[2].forEach = undefined;
    assert.equal(errs(counting).length, 0);
});

test('an ai_step nobody reads from is left alone', () => {
    const def = base();
    def.steps.pop();
    def.edges = [{ from: 'trg', to: 'a1' }, { from: 'a1', to: 'ai1' }];
    assert.equal(errs(def).length, 0);
});
