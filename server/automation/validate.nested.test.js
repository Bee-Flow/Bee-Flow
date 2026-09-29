/**
 * Nested-step validation + Batch-3 policy rules — node-audit C3/C4/C5/C6,
 * C1/C2 (collection-op completeness), B5 (unlabelled brancher edges).
 *
 * Run: node --test automation/validate.nested.test.js
 *
 * Before this pass, steps inside `loop.body[]` / `parallel.branches[][]` got
 * only an id/type shape check — an HTTP Request with the default empty URL
 * nested in a loop activated green and threw on every run.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition, COMPLETENESS_CODES } = require('./validate');

const trigger = () => ({ id: 'trg', kind: 'manual' });
const note = (id) => ({ id, type: 'notification', title: id, body: 'x', channels: ['notification'] });

function withLoop(body, extraSteps = [], extraEdges = []) {
    return {
        trigger: trigger(),
        steps: [
            { id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 100, body },
            ...extraSteps,
        ],
        edges: [{ from: 'trg', to: 'lp' }, ...extraEdges],
    };
}

const codesOf = (r) => [...r.errors, ...r.warnings].map(x => x.code);
const findRec = (r, code) => [...r.errors, ...r.warnings].find(x => x.code === code);

// ── C3/C4 — per-type rules now reach nested steps ────────────────────────────

test('http_request with empty url inside a loop body blocks activation, warns at draft', () => {
    const def = withLoop([{ id: 'http1', type: 'http_request', url: '', method: 'GET' }]);
    const strict = validateDefinition(def);
    const rec = strict.errors.find(e => e.code === 'http_request.url_missing');
    assert.ok(rec, 'nested per-type rule must fire');
    assert.match(rec.path, /steps\[lp\]\.body\.steps\[http1\]/, 'path names loop AND child for FE badge mapping');
    assert.equal(strict.ok, false);

    const draft = validateDefinition(def, { stage: 'draft' });
    assert.equal(draft.ok, true, 'url_missing is completeness — draft-saveable');
    assert.ok(draft.warnings.some(w => w.code === 'http_request.url_missing'));
});

test('per-type rules reach parallel branches too', () => {
    const def = {
        trigger: trigger(),
        steps: [{
            id: 'par', type: 'parallel',
            branches: [[{ id: 'ai1', type: 'ai_step' }], [note('okStep')]],
        }],
        edges: [{ from: 'trg', to: 'par' }],
    };
    const r = validateDefinition(def);
    const rec = r.errors.find(e => e.code === 'ai_step.prompt_missing');
    assert.ok(rec);
    assert.match(rec.path, /steps\[par\]\.branches\[0\]\.steps\[ai1\]/);
});

test('recursion: a loop inside a loop still validates its inner body', () => {
    const def = withLoop([{
        id: 'inner', type: 'loop', overRef: 'loop.item.rows', itemVar: 'row', maxIterations: 50,
        body: [{ id: 'dt1', type: 'datetime', op: 'addDays' }], // amount + input missing
    }]);
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'datetime.amount_missing' && /steps\[inner\]\.body\.steps\[dt1\]/.test(e.path)));
});

test('nested ref to a ghost step errors; loop.<itemVar> refs stay clean', () => {
    const def = withLoop([{
        id: 'act1', type: 'integration_action', tool: 'gmail_send',
        inputs: {
            to: { kind: 'ref', path: 'steps.ghost.output.email' },
            body: { kind: 'ref', path: 'loop.item.text' },
        },
    }]);
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'ref.unknown_step'));
    assert.ok(!codesOf(r).includes('ref.unknown_root'), 'loop root must not be flagged');
});

test('nested sibling refs resolve; body steps can also read top-level steps', () => {
    const def = {
        trigger: trigger(),
        steps: [
            note('before'),
            {
                id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 100,
                body: [
                    { id: 'b1', type: 'set', fields: { x: { kind: 'literal', value: 1 } } },
                    { id: 'b2', type: 'set', fields: { y: { kind: 'ref', path: 'steps.b1.output.x' }, z: { kind: 'ref', path: 'steps.before.output.delivered' } } },
                ],
            },
        ],
        edges: [{ from: 'trg', to: 'before' }, { from: 'before', to: 'lp' }],
    };
    const r = validateDefinition(def);
    assert.ok(!codesOf(r).includes('ref.unknown_step'), `unexpected: ${JSON.stringify(r.errors)}`);
});

test('a body step id colliding with any other id is flagged (draft-warn, activate-block)', () => {
    const def = withLoop([note('dup')], [note('dup2')], [{ from: 'lp', to: 'dup2' }]);
    def.steps[1].id = 'dup2';
    def.steps[0].body[0].id = 'dup2'; // collide with the top-level step
    const strict = validateDefinition(def);
    assert.ok(strict.errors.some(e => e.code === 'loop.body_item_id_duplicate'));
    const draft = validateDefinition(def, { stage: 'draft' });
    assert.equal(draft.ok, true);
});

test('body switches get field rules but NOT edge-wiring rules', () => {
    const def = withLoop([
        { id: 'sw1', type: 'switch', expr: 'loop.item.kind', cases: [{ name: 'a', value: 'a' }] },
        note('after1'),
    ]);
    const r = validateDefinition(def);
    assert.ok(!codesOf(r).includes('switch.no_branches'), 'a body switch is a pass-through, not an unwired brancher');
    // …but a broken expr in the body IS caught now:
    const bad = withLoop([{ id: 'sw2', type: 'switch', expr: '((', cases: [{ name: 'a', value: 'a' }] }]);
    assert.ok(validateDefinition(bad).errors.some(e => e.code === 'switch.expr_parse'));
});

test('call_layer children are not double-reported by the generic pass', () => {
    const def = {
        trigger: trigger(),
        steps: [{
            id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 100,
            body: [{ id: 'cl1', type: 'call_layer', layerKey: 'ghost_layer', inputs: {} }],
        }],
        edges: [{ from: 'trg', to: 'lp' }],
        layers: {},
    };
    const r = validateDefinition(def);
    const unknownLayer = r.errors.filter(e => e.code === 'call_layer.unknown_layer');
    assert.equal(unknownLayer.length, 1, 'exactly one record from the dedicated pass');
});

// ── C5 — parse_json in a body needs an explicit source ───────────────────────

test('parse_json in a loop body without sourceRef blocks activation; top-level stays a warning', () => {
    const nestedDef = withLoop([{ id: 'pj1', type: 'parse_json', fields: [{ name: 'a', path: 'a' }] }]);
    const strict = validateDefinition(nestedDef);
    assert.ok(strict.errors.some(e => e.code === 'parse_json.source_required_here'));
    assert.equal(validateDefinition(nestedDef, { stage: 'draft' }).ok, true);

    const topDef = {
        trigger: trigger(),
        steps: [note('n1'), { id: 'pj2', type: 'parse_json', fields: [{ name: 'a', path: 'a' }] }],
        edges: [{ from: 'trg', to: 'n1' }, { from: 'n1', to: 'pj2' }],
    };
    const topR = validateDefinition(topDef);
    assert.ok(topR.warnings.some(w => w.code === 'parse_json.source_defaulted'));
    assert.ok(!topR.errors.some(e => e.code === 'parse_json.source_required_here'));
});

test('parse_json in a body WITH an explicit source is clean', () => {
    const def = withLoop([{ id: 'pj1', type: 'parse_json', sourceRef: 'loop.item.payload', fields: [{ name: 'a', path: 'a' }] }]);
    assert.ok(!codesOf(validateDefinition(def)).includes('parse_json.source_required_here'));
});

// ── C1/C2 — collection-op codes are completeness now ─────────────────────────

test('blanking a collection op source list no longer blocks a draft save', () => {
    for (const type of ['filter', 'limit', 'dedupe', 'aggregate', 'summarize']) {
        const step = { id: 's1', type, arrayRef: '' };
        if (type === 'filter') step.expr = 'item.x > 0';
        if (type === 'limit') step.count = 5;
        if (type === 'aggregate') step.field = 'x';
        if (type === 'summarize') { step.op = 'sum'; step.field = 'x'; }
        const def = { trigger: trigger(), steps: [step], edges: [{ from: 'trg', to: 's1' }] };
        const draft = validateDefinition(def, { stage: 'draft' });
        assert.equal(draft.ok, true, `${type}: draft must stay saveable`);
        assert.ok(draft.warnings.some(w => w.code === `${type}.arrayRef_missing` && w.blockedAt === 'activate'), `${type}: tagged warning expected`);
        assert.equal(validateDefinition(def).ok, false, `${type}: activation still blocks`);
    }
});

test('summarize op="count" needs no field; other ops still do', () => {
    const mk = (op, field) => ({
        trigger: trigger(),
        steps: [{ id: 's1', type: 'summarize', op, ...(field ? { field } : {}), arrayRef: 'trigger.output.items' }],
        edges: [{ from: 'trg', to: 's1' }],
    });
    assert.ok(!codesOf(validateDefinition(mk('count'))).includes('summarize.field_missing'));
    assert.ok(validateDefinition(mk('sum')).errors.some(e => e.code === 'summarize.field_missing'));
    // …and field_missing is draft-safe now:
    assert.equal(validateDefinition(mk('sum'), { stage: 'draft' }).ok, true);
});

// ── C6 — empty app_event trigger can never fire ─────────────────────────────

test('app_event trigger without provider/event blocks activation, warns at draft', () => {
    const def = { trigger: { id: 'trg', kind: 'app_event' }, steps: [], edges: [] };
    const strict = validateDefinition(def);
    assert.ok(strict.errors.some(e => e.code === 'trigger.app_event_incomplete'));
    assert.equal(validateDefinition(def, { stage: 'draft' }).ok, true);

    const complete = { trigger: { id: 'trg', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } }, steps: [], edges: [] };
    assert.ok(!codesOf(validateDefinition(complete)).includes('trigger.app_event_incomplete'));
});

test('secondary app_event trigger gets the same rule, with the id in the path', () => {
    const def = {
        trigger: trigger(),
        steps: [],
        edges: [],
        triggers: [{ id: 'trg2', kind: 'app_event' }],
    };
    const rec = findRec(validateDefinition(def), 'trigger.app_event_incomplete');
    assert.ok(rec);
    assert.match(rec.path, /triggers\[trg2\]/, 'id-based path so the FE badge lands on the node');
});

// ── B5 — unlabelled brancher edges ───────────────────────────────────────────

test('an unlabelled edge out of a condition/switch blocks activation, warns at draft', () => {
    const def = {
        trigger: trigger(),
        steps: [{ id: 'c1', type: 'condition', expr: 'true' }, note('n1')],
        edges: [
            { from: 'trg', to: 'c1' },
            { from: 'c1', to: 'n1' }, // unlabelled — never fires
            { from: 'c1', to: 'n1', label: 'then' },
        ],
    };
    const strict = validateDefinition(def);
    assert.ok(strict.errors.some(e => e.code === 'edge.branch_unlabelled'));
    assert.equal(validateDefinition(def, { stage: 'draft' }).ok, true);
});

test('labelled brancher edges and plain-step edges stay clean', () => {
    const def = {
        trigger: trigger(),
        steps: [{ id: 'c1', type: 'condition', expr: 'true' }, note('n1'), note('n2')],
        edges: [
            { from: 'trg', to: 'c1' },
            { from: 'c1', to: 'n1', label: 'then' },
            { from: 'c1', to: 'n2', label: 'else' },
            { from: 'n1', to: 'n2' },
        ],
    };
    assert.ok(!codesOf(validateDefinition(def)).includes('edge.branch_unlabelled'));
});

// ── A17 — datetime input rules ───────────────────────────────────────────────

test('datetime ops require input (except now); diff requires input2 — draft-safe', () => {
    const mk = (op, extra = {}) => ({
        trigger: trigger(),
        steps: [{ id: 'dt', type: 'datetime', op, ...extra }],
        edges: [{ from: 'trg', to: 'dt' }],
    });
    assert.ok(validateDefinition(mk('addDays', { amount: 1 })).errors.some(e => e.code === 'datetime.input_missing'));
    assert.ok(!codesOf(validateDefinition(mk('now'))).includes('datetime.input_missing'));
    assert.ok(validateDefinition(mk('diff', { unit: 'days', input: '2026-01-01' })).errors.some(e => e.code === 'datetime.input2_missing'));
    assert.equal(validateDefinition(mk('addDays', { amount: 1 }), { stage: 'draft' }).ok, true);
});

// ── Set integrity ─────────────────────────────────────────────────────────────

test('every new completeness code really is in COMPLETENESS_CODES', () => {
    for (const code of [
        'filter.arrayRef_missing', 'limit.arrayRef_missing', 'dedupe.arrayRef_missing',
        'aggregate.arrayRef_missing', 'summarize.arrayRef_missing',
        'aggregate.field_missing', 'summarize.field_missing',
        'trigger.app_event_incomplete', 'parse_json.source_required_here',
        'edge.branch_unlabelled', 'loop.body_item_id_duplicate',
        'datetime.input_missing', 'datetime.input2_missing',
    ]) {
        assert.ok(COMPLETENESS_CODES.has(code), `${code} missing from COMPLETENESS_CODES`);
    }
});
