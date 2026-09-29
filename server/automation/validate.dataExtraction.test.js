/**
 * data_extraction — what the validator must catch before a run spends a model
 * call on a step that cannot work, and what it must NOT complain about while
 * someone is still typing.
 *
 * The field names are the sharp edge: they become `steps.<id>.output.<name>`
 * keys and later bindings, so a name that is not a plain identifier, or one
 * declared twice, is refused at every stage. An EMPTY source or field list is
 * the other kind of problem — the node is dropped on the canvas that way and
 * filled in over the next autosaves — and has to stay draft-saveable
 * (COMPLETENESS_CODES), or the canvas 400s mid-typing.
 *
 * Run: node --test --test-force-exit automation/validate.dataExtraction.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateDefinition } = require('./validate');
const { COMPLETENESS_CODES } = require('./validate/completenessCodes');
const { VALID_STEP_TYPES, ON_ERROR_SOURCE_TYPES } = require('./validate/constants');

const FIELDS = [
    { name: 'datum', type: 'date', description: 'Invoice date', required: true },
    { name: 'totaal', type: 'number', description: 'Total including VAT' },
];

const base = (step, extraSteps = [], extraEdges = []) => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'read', type: 'http_request', url: 'https://example.com/invoice.txt', method: 'GET' },
        { id: 'ex1', type: 'data_extraction', source: { kind: 'ref', path: 'steps.read.output.body' }, fields: FIELDS, ...step },
        ...extraSteps,
    ],
    edges: [{ from: 'trg', to: 'read' }, { from: 'read', to: 'ex1' }, ...extraEdges],
});

const codes = (def, opts) => validateDefinition(def, opts).errors.map(e => e.code);
const warnings = (def, opts) => (validateDefinition(def, opts).warnings || []).map(e => e.code);
const allCodes = (def, opts) => {
    const r = validateDefinition(def, opts);
    return [...r.errors, ...(r.warnings || [])].map(e => e.code);
};

test('a well-formed step validates clean', () => {
    assert.deepStrictEqual(codes(base()), []);
});

test('the step type is actually known — this is the registration canary', () => {
    // If VALID_STEP_TYPES was missed, EVERY other assertion here would pass
    // for the wrong reason: the type check short-circuits the per-type block.
    assert.ok(VALID_STEP_TYPES.has('data_extraction'));
    assert.ok(!allCodes(base()).includes('step.unknown_type'));
});

test('no source is an error, and the completeness kind — the autosave must not 400', () => {
    assert.ok(codes(base({ source: undefined })).includes('data_extraction.source_missing'));
    assert.ok(codes(base({ source: null })).includes('data_extraction.source_missing'));
    // A binding with nothing in it, an empty scaffold object and an empty
    // string are all "not wired yet" too — whatever shape the palette seeds.
    assert.ok(codes(base({ source: { kind: 'ref', path: '' } })).includes('data_extraction.source_missing'));
    assert.ok(codes(base({ source: { kind: 'literal', value: '' } })).includes('data_extraction.source_missing'));
    assert.ok(codes(base({ source: {} })).includes('data_extraction.source_missing'));
    assert.ok(codes(base({ source: '' })).includes('data_extraction.source_missing'));
    assert.ok(COMPLETENESS_CODES.has('data_extraction.source_missing'));
    const r = validateDefinition(base({ source: undefined }), { stage: 'draft' });
    assert.ok(!r.errors.some(e => e.code === 'data_extraction.source_missing'), 'not an error in a draft');
    assert.ok((r.warnings || []).some(e => e.code === 'data_extraction.source_missing'), 'still reported');
});

test('a bare string source only warns (the runner resolves it), but its refs are still checked', () => {
    // A ref-looking string is read as a path, a {{…}} string as a template —
    // so neither blocks a save, and both get the ordinary ref checks.
    assert.deepStrictEqual(codes(base({ source: 'steps.read.output.body' })), []);
    assert.ok(warnings(base({ source: 'steps.read.output.body' })).includes('data_extraction.source_bare_string'));
    assert.ok(allCodes(base({ source: 'steps.nope.output.body' })).includes('ref.unknown_step'));
    assert.ok(allCodes(base({ source: 'Subject: {{steps.nope.output.body}}' })).includes('ref.unknown_step'));
    const lit = validateDefinition(base({ source: 'just some words' }));
    assert.match(lit.warnings.find(w => w.code === 'data_extraction.source_bare_string').message, /LITERAL text/);
    // Anything else that is not a binding is integrity: the runner would
    // serialise it and extract from the words.
    assert.ok(codes(base({ source: { foo: 1 } })).includes('data_extraction.source_invalid'));
    assert.ok(codes(base({ source: 42 })).includes('data_extraction.source_invalid'));
    assert.ok(!COMPLETENESS_CODES.has('data_extraction.source_invalid'));
    assert.ok(codes(base({ source: { foo: 1 } }), { stage: 'draft' }).includes('data_extraction.source_invalid'), 'blocks at draft too');
});

test('a template binding is a legitimate source too', () => {
    assert.deepStrictEqual(codes(base({ source: { kind: 'template', value: 'Subject: {{steps.read.output.body}}' } })), []);
});

test('no fields is an error of the completeness kind; the seeded blank row counts as none', () => {
    for (const fields of [undefined, [], [{ name: '', type: 'string', description: '' }]]) {
        assert.ok(codes(base({ fields })).includes('data_extraction.fields_missing'), JSON.stringify(fields));
    }
    assert.ok(COMPLETENESS_CODES.has('data_extraction.fields_missing'));
    const r = validateDefinition(base({ fields: [] }), { stage: 'draft' });
    assert.ok(!r.errors.some(e => e.code === 'data_extraction.fields_missing'));
    assert.ok((r.warnings || []).some(e => e.code === 'data_extraction.fields_missing'));
});

test('field names must be lowercase snake identifiers — they become output keys', () => {
    for (const name of ['Datum', 'invoice date', '1st', 'total-amount', 'a'.repeat(41), 'naam.van', '_x']) {
        assert.ok(codes(base({ fields: [{ name, type: 'string' }] })).includes('data_extraction.field_name_invalid'), `"${name}" should be refused`);
    }
    for (const name of ['datum', 'invoice_date', 'x1', 'a'.repeat(40), 'total_incl_btw']) {
        assert.deepStrictEqual(codes(base({ fields: [{ name, type: 'string' }] })), [], `"${name}" is fine`);
    }
    // Integrity: blocks at draft stage as well.
    assert.ok(!COMPLETENESS_CODES.has('data_extraction.field_name_invalid'));
    assert.ok(codes(base({ fields: [{ name: 'Datum', type: 'string' }] }), { stage: 'draft' }).includes('data_extraction.field_name_invalid'));
});

test('a field type outside the enum is refused, and the hint lists the four', () => {
    const r = validateDefinition(base({ fields: [{ name: 'x', type: 'integer' }] }));
    const issue = r.errors.find(e => e.code === 'data_extraction.field_type_invalid');
    assert.ok(issue, 'refused');
    for (const t of ['string', 'number', 'boolean', 'date']) assert.match(issue.hint, new RegExp(t));
    for (const type of ['string', 'number', 'boolean', 'date']) {
        assert.deepStrictEqual(codes(base({ fields: [{ name: 'x', type }] })), [], type);
    }
    // No type at all — or a blank one, the palette's seed — is tolerated (the runner reads it as string).
    assert.deepStrictEqual(codes(base({ fields: [{ name: 'x' }] })), []);
    assert.deepStrictEqual(codes(base({ fields: [{ name: 'x', type: '' }] })), []);
    assert.deepStrictEqual(codes(base({ fields: [{ name: 'x', type: null }] })), []);
});

test('the same name twice is refused', () => {
    const r = codes(base({ fields: [{ name: 'datum', type: 'date' }, { name: 'datum', type: 'string' }] }));
    assert.ok(r.includes('data_extraction.fields_duplicate'));
    assert.ok(!COMPLETENESS_CODES.has('data_extraction.fields_duplicate'));
});

test('more than 30 fields is refused', () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ name: `f${i}`, type: 'string' }));
    assert.ok(codes(base({ fields: many })).includes('data_extraction.fields_too_many'));
    assert.deepStrictEqual(codes(base({ fields: many.slice(0, 30) })), []);
});

test('instructions are optional and capped at 2000 characters', () => {
    assert.deepStrictEqual(codes(base({ instructions: 'Amounts are in euros.' })), []);
    assert.deepStrictEqual(codes(base({ instructions: '' })), []);
    assert.ok(codes(base({ instructions: 'x'.repeat(2001) })).includes('data_extraction.instructions_too_long'));
    assert.ok(codes(base({ instructions: 42 })).includes('data_extraction.instructions_too_long'));
});

test('a source pointing at a step that does not exist is reported like any other ref', () => {
    const def = base({ source: { kind: 'ref', path: 'steps.nope.output.body' } });
    assert.ok(allCodes(def).includes('ref.unknown_step'));
});

test('forEach is allowed on this type — "extract the same fields from every file"', () => {
    const def = base({
        source: { kind: 'ref', path: 'loop.f.output.body' },
        forEach: { overRef: 'steps.read.output.results', itemVar: 'f' },
    });
    assert.ok(!allCodes(def).includes('foreach.type_unsupported'));
});

test('it can be the source of an on_error branch — an unreadable invoice is routable', () => {
    assert.ok(ON_ERROR_SOURCE_TYPES.has('data_extraction'));
    const def = base({}, [{ id: 'n1', type: 'notification', title: 'could not read it' }], [{ from: 'ex1', to: 'n1', label: 'on_error' }]);
    assert.ok(!allCodes(def).some(c => /on_error/.test(c) && /type/.test(c)), `no on_error type complaint: ${allCodes(def)}`);
});

test('a downstream read of a field this step does not declare is a warning', () => {
    const def = base({}, [{ id: 'n1', type: 'notification', title: 'x', body: '{{steps.ex1.output.leverancier}} / {{steps.ex1.output.totaal}}' }], [{ from: 'ex1', to: 'n1' }]);
    assert.ok(warnings(def).includes('data_extraction.field_not_declared'));
    const r = validateDefinition(def);
    const w = r.warnings.find(e => e.code === 'data_extraction.field_not_declared');
    assert.match(w.message, /leverancier/);
    assert.ok(!/totaal/.test(w.message), 'the declared field is not listed');
    assert.ok(r.ok, 'a warning does not block');
});

test('a downstream read of a DECLARED field is clean, also through a fan-out', () => {
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 'read', type: 'http_request', url: 'https://example.com/a', method: 'GET' },
            { id: 'ex1', type: 'data_extraction', source: { kind: 'ref', path: 'loop.f.output.body' }, fields: FIELDS, forEach: { overRef: 'steps.read.output.results', itemVar: 'f' } },
            { id: 'n1', type: 'notification', title: 'x', body: '{{loop.r.output.totaal}}', forEach: { overRef: 'steps.ex1.output.results', itemVar: 'r' } },
        ],
        edges: [{ from: 'trg', to: 'read' }, { from: 'read', to: 'ex1' }, { from: 'ex1', to: 'n1' }],
    };
    assert.ok(!allCodes(def).includes('data_extraction.field_not_declared'));
});

test('the step validates inside a loop body too (nested rules run)', () => {
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 'read', type: 'http_request', url: 'https://example.com/a', method: 'GET' },
            {
                id: 'lp', type: 'loop', overRef: 'steps.read.output.results', itemVar: 'f',
                body: [{ id: 'ex_in', type: 'data_extraction', source: { kind: 'ref', path: 'loop.f.body' }, fields: [{ name: 'Bad Name', type: 'string' }] }],
            },
        ],
        edges: [{ from: 'trg', to: 'read' }, { from: 'read', to: 'lp' }],
    };
    assert.ok(codes(def).includes('data_extraction.field_name_invalid'));
});

test('a source bound to a file location (path, fileId, url) warns — a path is not text', () => {
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 'list', type: 'http_request', url: 'https://example.com/list', method: 'GET' },
            { id: 'ex1', type: 'data_extraction', source: { kind: 'ref', path: 'loop.f.path' }, fields: FIELDS, forEach: { overRef: 'steps.list.output.items', itemVar: 'f' } },
        ],
        edges: [{ from: 'trg', to: 'list' }, { from: 'list', to: 'ex1' }],
    };
    assert.ok(warnings(def).includes('data_extraction.source_is_location'));
    assert.ok(!codes(def).includes('data_extraction.source_is_location'), 'a warning, never a blocker');
    const fine = base({ source: { kind: 'ref', path: 'loop.f.output.content' }, forEach: { overRef: 'steps.read.output.results', itemVar: 'f' } });
    assert.ok(!warnings(fine).includes('data_extraction.source_is_location'));
});

test('loop.<var> read by a step that does not iterate as <var> is an error (completeness: draft-saveable)', () => {
    const def = base({}, [
        { id: 'row', type: 'notification', title: 'Rij', body: 'Totaal {{loop.e.output.totaal}}', channels: ['notification'] },
    ], [{ from: 'ex1', to: 'row' }]);
    assert.ok(codes(def).includes('ref.loop_unbound'), JSON.stringify(codes(def)));
    assert.ok(COMPLETENESS_CODES.has('ref.loop_unbound'));
    assert.ok(!codes(def, { stage: 'draft' }).includes('ref.loop_unbound'), 'draft stage downgrades it');
    // Bound by the step's own forEach, or by an enclosing loop body: fine.
    const own = base({}, [
        { id: 'row', type: 'notification', title: 'Rij', body: 'Totaal {{loop.e.output.totaal}}', channels: ['notification'], forEach: { overRef: 'steps.ex1.output.results', itemVar: 'e' } },
    ], [{ from: 'ex1', to: 'row' }]);
    assert.ok(!codes(own).includes('ref.loop_unbound'));
    const nested = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 'read', type: 'http_request', url: 'https://example.com/a', method: 'GET' },
            { id: 'lp', type: 'loop', overRef: 'steps.read.output.results', itemVar: 'f',
              body: [{ id: 'ex_in', type: 'data_extraction', source: { kind: 'ref', path: 'loop.f.body' }, fields: FIELDS }] },
        ],
        edges: [{ from: 'trg', to: 'read' }, { from: 'read', to: 'lp' }],
    };
    assert.ok(!codes(nested).includes('ref.loop_unbound'));
    const wrongVar = base({ source: { kind: 'ref', path: 'loop.r.output.content' }, forEach: { overRef: 'steps.read.output.results', itemVar: 'f' } });
    assert.ok(codes(wrongVar).includes('ref.loop_unbound'));
    // `loop._index` is injected by the runner beside the item on every pass
    // (execFlow.js) — bound wherever the itemVar is. It was flagged as a var
    // named "_index" and blocked activation of a numbered fan-out.
    const numbered = base({}, [
        { id: 'row', type: 'notification', title: 'Rij', body: 'Row {{loop._index}}: {{loop.e.output.totaal}}', channels: ['notification'], forEach: { overRef: 'steps.ex1.output.results', itemVar: 'e' } },
    ], [{ from: 'ex1', to: 'row' }]);
    assert.ok(!codes(numbered).includes('ref.loop_unbound'), JSON.stringify(codes(numbered)));
    const inBody = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 'read', type: 'http_request', url: 'https://example.com/a', method: 'GET' },
            { id: 'lp', type: 'loop', overRef: 'steps.read.output.results', itemVar: 'f',
              body: [{ id: 'n_in', type: 'notification', title: 'x', body: 'Row {{loop._index}}', channels: ['notification'] }] },
        ],
        edges: [{ from: 'trg', to: 'read' }, { from: 'read', to: 'lp' }],
    };
    assert.ok(!codes(inBody).includes('ref.loop_unbound'));
    // …but a bare loop._index with NO forEach and outside any loop body is
    // still undefined at run time, and still reported.
    const bare = base({}, [
        { id: 'row', type: 'notification', title: 'Rij', body: 'Row {{loop._index}}', channels: ['notification'] },
    ], [{ from: 'ex1', to: 'row' }]);
    assert.ok(codes(bare).includes('ref.loop_unbound'));
});
