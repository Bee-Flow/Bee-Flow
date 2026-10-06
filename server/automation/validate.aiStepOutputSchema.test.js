/**
 * An ai_step that later steps read FIELDS from, without an outputSchema.
 *
 * Without one the step answers free-form text. The runner infers a schema from
 * how later steps read the step (aiOutputInference.js: direct reads, fan-out
 * `loop.<v>.output.<field>` reads, nested and bracket reads), so those read
 * shapes WARN and show the inferred schema. A read the runner cannot serve
 * still resolves to nothing — and a dry run cannot reveal it, because the
 * write step downstream is synthesised rather than called. A measured build
 * did exactly that: read four invoices, extracted nothing bindable, and
 * finalised green (2026-09-12). Those stay `ai_step.output_schema_missing`.
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

// The runner now infers a schemaless step's schema from EVERY read, the
// fan-out's `loop.<e>.output.<f>` included, nested and typed
// (core/automationRunner/aiOutputInference.js). So the fan-out shape that used
// to be refused (`output_schema_missing`, completeness) now runs, and warns
// like the direct read: the warning shows the schema the run will ask for.

test('a fan-out that reads loop.<item>.output.<field> warns with the schema the runner infers', () => {
    assert.equal(errs(base()).length, 0, 'the runner serves these reads: not an error at any stage');
    const w = warns(base());
    assert.equal(w.length, 1);
    assert.match(w[0].message, /`datum`/);
    assert.match(w[0].message, /`totaal`/);
    assert.match(w[0].message, /infers \{datum: string, totaal: string\}/);
    assert.match(w[0].hint, /"datum":\{"type":"string"\}/);
    assert.equal(w[0].path, 'steps[ai1].outputSchema', 'the path names the step by id');
    assert.equal(validateDefinition(base(), { stage: 'activate' }).ok, true, 'activation is not blocked');
});

test('declaring the schema silences it — both shapes are accepted', () => {
    assert.equal(warns(base({ outputSchema: { type: 'object', properties: { datum: { type: 'string' }, totaal: { type: 'number' } } } })).length, 0);
    // execAi also accepts a plain field map.
    assert.equal(warns(base({ outputSchema: { datum: 'string', totaal: 'number' } })).length, 0);
    // An EMPTY schema is no schema.
    assert.equal(warns(base({ outputSchema: {} })).length, 1);
});

test('a direct steps.<id>.output.<field> ref WARNS — the runner infers the schema from it and the automation runs', () => {
    const def = base({}, {
        tableId: { kind: 'literal', value: 4 },
        values: { Leverancier: { kind: 'ref', path: 'steps.ai1.output.leverancier' } },
    });
    def.steps[2].forEach = undefined;
    // One answer, read directly. (The fixture used to keep ai1's forEach: a
    // per-item step's output is the list of answers, so this read never
    // resolved — see the per-item test below.)
    def.steps[1].forEach = undefined;
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

test('the warning shows the NESTED schema the reads imply, bracket reads included', () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'ai1', type: 'ai_step', prompt: 'read the order' },
            { id: 'n1', type: 'notification', title: 'Order', body: 'Mail {{steps.ai1.output.customer.contacts[0].email}} about {{steps.ai1.output["Story Points"]}}' },
            {
                id: 'w1', type: 'integration_action', tool: 'nextcloud_tables_create_row',
                forEach: { overRef: 'steps.ai1.output.line_items', itemVar: 'li' },
                inputs: { tableId: { kind: 'literal', value: 4 }, values: { Sku: { kind: 'ref', path: 'loop.li.sku' } } },
            },
        ],
        edges: [{ from: 'trg', to: 'ai1' }, { from: 'ai1', to: 'n1' }, { from: 'n1', to: 'w1' }],
    };
    const [w] = warns(def);
    assert.ok(w, JSON.stringify(validateDefinition(def, {}).warnings));
    assert.match(w.message, /infers \{customer: \{contacts: \[\{email: string\}\]\}, "Story Points": string, line_items: \[\{sku: string\}\]\}/);
    assert.match(w.message, /`customer`, `Story Points`, `line_items`/);
    assert.match(w.hint, /"line_items":\{"type":"array","items":\{"type":"object","properties":\{"sku":\{"type":"string"\}\}\}\}/);
    assert.equal(errs(def).length, 0);
});

test('a field read directly off a PER-ITEM step is refused: its output is the list of answers', () => {
    const def = base({}, {
        tableId: { kind: 'literal', value: 4 },
        values: { Leverancier: { kind: 'ref', path: 'steps.ai1.output.leverancier' } },
    });
    def.steps[2].forEach = undefined;
    const [e] = errs(def);
    assert.ok(e, 'the runner cannot serve this read, with or without inference');
    assert.match(e.message, /`leverancier`/);
    assert.match(e.hint, /results\[\*\]\.output\.leverancier/);
    assert.equal(warns(def).length, 0, 'never claimed as inferred');
    // Completeness: a draft still saves.
    assert.ok(COMPLETENESS_CODES.has(CODE));
    const draft = validateDefinition(def, { stage: 'draft' });
    assert.equal(draft.ok, true);
    assert.equal(draft.warnings.find(w => w.code === CODE)?.blockedAt, 'activate');
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
