/**
 * Unit tests for the structured automation validator.
 *
 * Run: node automation/validate.test.js
 *
 * No DB needed — validator is a pure function over a definition object.
 */

const assert = require('assert');
const { validateDefinition } = require('./validate');

function trigger() {
    return { id: 'trg', kind: 'manual' };
}

// ── Smoke: empty graph (just a trigger) is valid ────────────────────────
{
    const def = { trigger: trigger(), steps: [], edges: [] };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'empty graph should validate');
    assert.deepStrictEqual(r.errors, [], 'no errors expected');
}

// ── Records carry the structured shape (code/severity/path/message/hint) ─
{
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'condition' }], edges: [{ from: 'trg', to: 's1' }] };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'condition without expr is an error');
    const rec = r.errors.find(e => e.code === 'condition.expr_missing');
    assert.ok(rec, 'expected condition.expr_missing record');
    assert.strictEqual(rec.severity, 'error');
    assert.ok(rec.path.includes('s1'), 'path includes step id');
    assert.ok(typeof rec.message === 'string' && rec.message.length > 0, 'has message');
    assert.ok(typeof rec.hint === 'string' && rec.hint.length > 0, 'has hint');
}

// ── Condition with no edges → ERROR (was a warning before) ───────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'c1', type: 'condition', expr: 'true' }],
        edges: [{ from: 'trg', to: 'c1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'dead-branch condition must block');
    const rec = r.errors.find(e => e.code === 'condition.dead_branch');
    assert.ok(rec, 'expected condition.dead_branch error record');
}

// ── Condition with only one branch wired → WARNING (still ok) ────────────
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'c1', type: 'condition', expr: 'true' },
            { id: 'n1', type: 'notification', title: 'hi' },
        ],
        edges: [
            { from: 'trg', to: 'c1' },
            { from: 'c1', to: 'n1', label: 'then' },
        ],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'partial branch is just a warning');
    const w = r.warnings.find(x => x.code === 'condition.partial_branch');
    assert.ok(w, 'expected partial_branch warning record');
}

// ── Cycle detection still works ──────────────────────────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'a', type: 'notification', title: 'a' },
            { id: 'b', type: 'notification', title: 'b' },
        ],
        edges: [
            { from: 'trg', to: 'a' },
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
        ],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.find(e => e.code === 'graph.cycle'), 'expected graph.cycle');
}

// ── Unknown step type produces a stable code ─────────────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'wat' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.find(e => e.code === 'step.unknown_type'));
}

// ── Forward ref to a real step still warns (not error) ──────────────────
// "future" step EXISTS in the def but appears after `n1` in topo order.
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'n1', type: 'notification', title: 'using {{steps.future.output.x}}' },
            { id: 'future', type: 'notification', title: 'placeholder' },
        ],
        edges: [{ from: 'trg', to: 'n1' }, { from: 'n1', to: 'future' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'forward refs to real steps only warn');
    assert.ok(r.warnings.find(w => w.code === 'ref.forward'), 'expected ref.forward warning');
}

// ── Ref to a step that DOESN'T exist → error with did-you-mean hint ─────
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'a_4a3d50', type: 'notification', title: 'real step' },
            { id: 'n1', type: 'notification', title: 'using {{steps.step_1.output.x}}' },
        ],
        edges: [{ from: 'trg', to: 'a_4a3d50' }, { from: 'a_4a3d50', to: 'n1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'unknown-step ref must error');
    const rec = r.errors.find(e => e.code === 'ref.unknown_step');
    assert.ok(rec, 'expected ref.unknown_step record');
    assert.ok(/a_4a3d50/.test(rec.hint), `hint must surface the real id, got: ${rec.hint}`);
}

// ── position: optional but must be {x, y} numbers when present ──────────
{
    const def = {
        trigger: { id: 'trg', kind: 'manual', position: { x: 12, y: 34 } },
        steps: [{ id: 's1', type: 'notification', title: 'hi', position: { x: 100, y: 200 } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'valid positions should pass');
}
{
    const def = {
        trigger: { id: 'trg', kind: 'manual', position: { x: 'NaN', y: 0 } },
        steps: [], edges: [],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'non-numeric x must error');
    assert.ok(r.errors.some(e => e.code === 'position.coord'), 'expected position.coord error');
}
{
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 's1', type: 'notification', title: 'hi', position: 'left' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'non-object position must error');
    assert.ok(r.errors.some(e => e.code === 'position.shape'), 'expected position.shape error');
}

// ── n8n-style utility nodes ─────────────────────────────────────────────
//
// One pass + one fail case per new step type. We don't exhaustively cover
// every per-op variant of datetime — the validator's per-op checks are
// straightforward and additional coverage would just rehash the validator's
// own enum lists.

// set: passes when fields is omitted; fails when fields is non-object.
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'set', fields: { name: { kind: 'literal', value: 'Alice' } } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'set with valid fields should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'set', fields: 'not-an-object' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'set with non-object fields must error');
    assert.ok(r.errors.some(e => e.code === 'set.fields_shape'), 'expected set.fields_shape error');
}

// datetime
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'datetime', op: 'now' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'datetime op:now should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'datetime', op: 'addDays', input: 'trigger.output.t' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'addDays without amount must error');
    assert.ok(r.errors.some(e => e.code === 'datetime.amount_missing'));
}

// wait
{
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'wait', seconds: 5 }], edges: [{ from: 'trg', to: 's1' }] };
    assert.strictEqual(validateDefinition(def).ok, true, 'wait 5s should pass');
}
{
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'wait', seconds: 0 }], edges: [{ from: 'trg', to: 's1' }] };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'wait.seconds_range'), 'wait < 1 must error');
}

// stop_error
{
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'stop_error', message: 'boom' }], edges: [{ from: 'trg', to: 's1' }] };
    assert.strictEqual(validateDefinition(def).ok, true, 'stop_error with message should pass');
}
{
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'stop_error' }], edges: [{ from: 'trg', to: 's1' }] };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'stop_error.message_missing'));
}

// switch — needs at least one case AND at least one wired case edge.
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'sw', type: 'switch', expr: 'trigger.output.priority', cases: [{ name: 'urgent', value: 'high' }] },
            { id: 'n1', type: 'notification', title: 'urgent path' },
        ],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'n1', label: 'case:urgent', caseName: 'urgent' },
        ],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'switch with one wired case should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'sw', type: 'switch', expr: 'trigger.output.x', cases: [] }],
        edges: [{ from: 'trg', to: 'sw' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'switch.cases_missing'), 'empty cases must error');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'sw', type: 'switch', expr: 'x', cases: [{ name: 'a', value: 1 }] }],
        edges: [{ from: 'trg', to: 'sw' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'switch.no_branches'), 'unwired switch must error');
}

// filter / limit / aggregate / summarize — arrayRef required
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'filter', arrayRef: 'trigger.output.items', expr: 'item.flag' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'filter with arrayRef + expr should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'filter', expr: 'item.flag' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'filter.arrayRef_missing'));
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'limit', arrayRef: 'trigger.output.items', count: 5 }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'limit with arrayRef + count should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'aggregate', arrayRef: 'trigger.output.items' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'aggregate.field_missing'));
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'summarize', arrayRef: 'trigger.output.items', field: 'amount', op: 'sum' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'summarize with all fields should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'summarize', arrayRef: 'trigger.output.items', field: 'amount', op: 'median' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'summarize.op_invalid'));
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'dedupe', arrayRef: 'trigger.output.items', keyField: 'id' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'dedupe with keyField should pass');
}

// ── WS-9C: tool_unknown only fires when availableTools is supplied ──────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'integration_action', tool: 'nextcloud_delete_share', inputs: { shareId: { kind: 'literal', value: 1 } } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'no availableTools → tool not checked');
    const r = validateDefinition(def, { availableTools: new Set(['gmail_send']) });
    assert.strictEqual(r.ok, false, 'unknown tool blocks when catalog provided');
    assert.ok(r.errors.some(e => e.code === 'integration_action.tool_unknown'), 'tool_unknown raised');
    assert.strictEqual(validateDefinition(def, { availableTools: new Set(['nextcloud_delete_share']) }).ok, true, 'known tool passes');
}

// ── WS-9B: required-param check (absent + empty-string literal) ─────────
{
    const reqMap = { nextcloud_talk_send_message: ['token', 'message'] };
    const emptyTok = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'integration_action', tool: 'nextcloud_talk_send_message', inputs: { token: { kind: 'literal', value: '' }, message: { kind: 'literal', value: 'hi' } } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r1 = validateDefinition(emptyTok, { availableTools: new Set(['nextcloud_talk_send_message']), toolRequiredParams: reqMap });
    assert.strictEqual(r1.ok, false, 'empty-literal required param blocks');
    assert.ok(r1.errors.some(e => e.code === 'integration_action.param_missing' && e.path.endsWith('.token')), 'param_missing on token');
    const noMsg = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'integration_action', tool: 'nextcloud_talk_send_message', inputs: { token: { kind: 'literal', value: 'abc' } } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r2 = validateDefinition(noMsg, { availableTools: new Set(['nextcloud_talk_send_message']), toolRequiredParams: reqMap });
    assert.ok(r2.errors.some(e => e.code === 'integration_action.param_missing' && e.path.endsWith('.message')), 'param_missing on absent message');
    const okDef = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'integration_action', tool: 'nextcloud_talk_send_message', inputs: { token: { kind: 'ref', path: 'trigger.output.roomToken' }, message: { kind: 'literal', value: 'hi' } } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(okDef, { availableTools: new Set(['nextcloud_talk_send_message']), toolRequiredParams: reqMap }).ok, true, 'all required params present → passes');
    assert.strictEqual(validateDefinition(emptyTok, { availableTools: new Set(['nextcloud_talk_send_message']) }).ok, true, 'no schema map → param not checked');
}

// ── WS-9D: literal containing {{…}} → uninterpolated warning (non-blocking) ──
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'integration_action', tool: 'nextcloud_create_folder', inputs: { path: { kind: 'literal', value: '/Welcome/{{trigger.output.actor}}' } } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'uninterpolated literal is a warning, not an error');
    assert.ok(r.warnings.some(w => w.code === 'literal.uninterpolated'), 'literal.uninterpolated warning raised');
    const def2 = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'integration_action', tool: 'nextcloud_create_folder', inputs: { path: { kind: 'template', value: '/Welcome/{{trigger.output.actor}}' } } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.ok(!validateDefinition(def2).warnings.some(w => w.code === 'literal.uninterpolated'), 'template kind → no uninterpolated warning');
}

// ── WS-9A: app_event deliverability warning (non-blocking) ─────────────
{
    const deliverable = { nextcloud: new Set(['file.new', 'calendar.event.upcoming']) };
    const mk = (ev) => ({ trigger: { id: 'trg', kind: 'app_event', appEvent: { provider: 'nextcloud', event: ev } }, steps: [], edges: [] });
    let r = validateDefinition(mk('file.new'), { deliverableEvents: deliverable });
    assert.ok(!r.warnings.some(w => w.code === 'trigger.app_event_undeliverable'), 'deliverable event → no warning');
    r = validateDefinition(mk('talk.mention.received'), { deliverableEvents: deliverable });
    assert.strictEqual(r.ok, true, 'undeliverable event is a warning, not an error');
    assert.ok(r.warnings.some(w => w.code === 'trigger.app_event_undeliverable'), 'undeliverable event → warning');
    assert.ok(!validateDefinition(mk('talk.mention.received')).warnings.some(w => w.code === 'trigger.app_event_undeliverable'), 'no deliverableEvents option → not checked');
}

// ── FIX 1: branch-labelled condition/switch edges satisfy the wiring checks ──
{
    // Condition with both then + else labelled edges (what branch-aware
    // appends now produce) — no dead_branch / partial_branch.
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'c1', type: 'condition', expr: 'trigger.output.x == 1' },
            { id: 'a1', type: 'notification', title: 'yes' },
            { id: 'a2', type: 'notification', title: 'no' },
        ],
        edges: [
            { from: 'trg', to: 'c1' },
            { from: 'c1', to: 'a1', label: 'then' },
            { from: 'c1', to: 'a2', label: 'else' },
        ],
    };
    const r = validateDefinition(def);
    assert.ok(!r.errors.some(e => e.code === 'condition.dead_branch'), 'labelled then/else → no dead_branch');
    assert.ok(!r.warnings.some(e => e.code === 'condition.partial_branch'), 'labelled then/else → no partial_branch');

    // Switch with a case:<name> labelled edge → no no_branches error.
    const sw = {
        trigger: trigger(),
        steps: [
            { id: 's1', type: 'switch', expr: 'trigger.output.p', cases: [{ name: 'urgent', value: 'high' }] },
            { id: 'n1', type: 'notification', title: 'urgent!' },
        ],
        edges: [
            { from: 'trg', to: 's1' },
            { from: 's1', to: 'n1', label: 'case:urgent', caseName: 'urgent' },
        ],
    };
    assert.ok(!validateDefinition(sw).errors.some(e => e.code === 'switch.no_branches'), 'labelled case edge → no switch.no_branches');
}

// ═══ WS3: inline layers ══════════════════════════════════════════════════

function layerGraph(overrides = {}) {
    return {
        title: 'Enrich contact',
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [{ name: 'email', type: 'string', required: true }] },
        steps: [{ id: 'out', type: 'layer_output', fields: { score: { kind: 'literal', value: 1 } } }],
        edges: [{ from: 'trg', to: 'out' }],
        ...overrides,
    };
}

// ── Happy path: a layer + a call_layer referencing it validates clean ────
{
    const def = {
        schemaVersion: 2,
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'enrich_contact', inputs: { email: { kind: 'ref', path: 'trigger.output.email' } } }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { enrich_contact: layerGraph() },
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, `valid inline layer should pass, got ${JSON.stringify(r.errors)}`);
    assert.ok(!r.warnings.some(w => w.code === 'layers.orphaned'), 'referenced layer is not orphaned');
}

// ── layers map shape + key format ────────────────────────────────────────
{
    const def = { trigger: trigger(), steps: [], edges: [], layers: ['nope'] };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'layers.shape'), 'non-object layers → layers.shape');
}
{
    const def = { trigger: trigger(), steps: [], edges: [], layers: { 'Bad-Key': layerGraph() } };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'layers.key_invalid'), 'invalid key → layers.key_invalid');
}
{
    const def = { trigger: trigger(), steps: [], edges: [], layers: { good_key: 'not-an-object' } };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'layers.value_shape'), 'non-object layer value → layers.value_shape');
}

// ── unknown layerKey → error with did-you-mean hint ──────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'enrich_contct', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { enrich_contact: layerGraph({ trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] } }) },
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false);
    const rec = r.errors.find(e => e.code === 'call_layer.unknown_layer');
    assert.ok(rec, 'expected call_layer.unknown_layer');
    assert.ok(/enrich_contact/.test(rec.hint), `hint must suggest the real key, got: ${rec.hint}`);
}

// ── legacy layerId (pre-migration shape) → dedicated error ───────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerId: 'some-uuid', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => e.code === 'call_layer.legacy_layerId'), 'expected call_layer.legacy_layerId');
}

// ── required layer param must be bound ───────────────────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'enrich_contact', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { enrich_contact: layerGraph() },
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'missing required param must block');
    const rec = r.errors.find(e => e.code === 'call_layer.param_missing');
    assert.ok(rec && rec.path.endsWith('.email'), 'param_missing on email');
    // Empty-string literal counts as missing too.
    const def2 = { ...def, steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'enrich_contact', inputs: { email: { kind: 'literal', value: '' } } }] };
    assert.ok(validateDefinition(def2).errors.some(e => e.code === 'call_layer.param_missing'), 'empty literal → param_missing');
}

// ── approval inside a layer → error ──────────────────────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'l', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: {
            l: layerGraph({
                trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
                steps: [
                    { id: 'ap', type: 'approval', prompt: 'ok?' },
                    { id: 'out', type: 'layer_output', fields: {} },
                ],
                edges: [{ from: 'trg', to: 'ap' }, { from: 'ap', to: 'out' }],
            }),
        },
    };
    const r = validateDefinition(def);
    const rec = r.errors.find(e => e.code === 'layer.approval_forbidden');
    assert.ok(rec, 'expected layer.approval_forbidden');
    assert.ok(rec.path.startsWith('layers.l.'), `layer-scoped path, got ${rec.path}`);
}

// ── layer trigger must be layer_input ────────────────────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'l', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { l: layerGraph({ trigger: { id: 'trg', type: 'trigger', kind: 'manual' } }) },
    };
    assert.ok(validateDefinition(def).errors.some(e => e.code === 'layer.trigger_kind'), 'non-layer_input trigger → layer.trigger_kind');
}

// ── layer_output count: >1 error, 0 warning; root layer_output stays legal ─
{
    const two = layerGraph({
        steps: [
            { id: 'out', type: 'layer_output', fields: {} },
            { id: 'out2', type: 'layer_output', fields: {} },
        ],
        edges: [{ from: 'trg', to: 'out' }, { from: 'out', to: 'out2' }],
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
    });
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'l', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { l: two },
    };
    assert.ok(validateDefinition(def).errors.some(e => e.code === 'layer.multiple_outputs'), 'two layer_outputs → error');

    const zero = layerGraph({
        steps: [{ id: 's1', type: 'set', fields: {} }],
        edges: [{ from: 'trg', to: 's1' }],
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
    });
    const def0 = { ...def, layers: { l: zero } };
    const r0 = validateDefinition(def0);
    assert.strictEqual(r0.ok, true, 'zero layer_outputs is only a warning');
    assert.ok(r0.warnings.some(w => w.code === 'layer.no_output'), 'zero layer_outputs → warning');

    // layer_output at the ROOT (converted orphan layers) stays legal.
    const rootOut = {
        trigger: trigger(),
        steps: [{ id: 'out', type: 'layer_output', fields: { a: { kind: 'literal', value: 1 } } }],
        edges: [{ from: 'trg', to: 'out' }],
    };
    assert.strictEqual(validateDefinition(rootOut).ok, true, 'root layer_output stays legal');
}

// ── nested layers key inside a layer → error ─────────────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'l', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { l: layerGraph({ layers: { inner: {} }, trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] } }) },
    };
    assert.ok(validateDefinition(def).errors.some(e => e.code === 'layers.nested'), 'nested layers map → layers.nested');
}

// ── cycle A → B → A → layers.cycle ───────────────────────────────────────
{
    const callTo = (key) => layerGraph({
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
        steps: [
            { id: 'cl', type: 'call_layer', layerKey: key, inputs: {} },
            { id: 'out', type: 'layer_output', fields: {} },
        ],
        edges: [{ from: 'trg', to: 'cl' }, { from: 'cl', to: 'out' }],
    });
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'a', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { a: callTo('b'), b: callTo('a') },
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'layers.cycle'), 'A→B→A must raise layers.cycle');
}

// ── chain deeper than 8 layers → layers.depth_exceeded ───────────────────
{
    const layers = {};
    const N = 9; // root → l1 → … → l9 = depth 9 > MAX_LAYER_DEPTH (8)
    for (let i = 1; i <= N; i++) {
        const next = i < N ? `l${i + 1}` : null;
        layers[`l${i}`] = layerGraph({
            trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
            steps: [
                ...(next ? [{ id: 'cl', type: 'call_layer', layerKey: next, inputs: {} }] : []),
                { id: 'out', type: 'layer_output', fields: {} },
            ],
            edges: next
                ? [{ from: 'trg', to: 'cl' }, { from: 'cl', to: 'out' }]
                : [{ from: 'trg', to: 'out' }],
        });
    }
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'l1', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers,
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'layers.depth_exceeded'), `9-deep chain must raise layers.depth_exceeded, got ${JSON.stringify(r.errors.map(e => e.code))}`);
}

// ── never-referenced layer → orphan warning (non-blocking) ───────────────
{
    const def = {
        trigger: trigger(),
        steps: [],
        edges: [],
        layers: { unused_layer: layerGraph({ trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] } }) },
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'orphan layer is a warning, not an error');
    assert.ok(r.warnings.some(w => w.code === 'layers.orphaned'), 'expected layers.orphaned warning');
}

// ── call_layer inside a loop body is checked too (unknown key) ───────────
{
    const def = {
        trigger: trigger(),
        steps: [{
            id: 'loop1', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 10,
            body: [{ id: 'cl1', type: 'call_layer', layerKey: 'missing', inputs: {} }],
        }],
        edges: [{ from: 'trg', to: 'loop1' }],
        layers: {},
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'call_layer.unknown_layer' && /body/.test(e.path)), 'loop-body call_layer is validated');
}

// ── leftover denormalized contract fields are tolerated (ignored) ────────
{
    const def = {
        trigger: trigger(),
        steps: [{
            id: 'cl1', type: 'call_layer', layerKey: 'enrich_contact',
            inputs: { email: { kind: 'literal', value: 'a@b.c' } },
            migratedFromLayerId: 'old-uuid',
            inputContract: [{ name: 'email' }], outputContract: [{ name: 'score' }],
        }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { enrich_contact: layerGraph() },
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'leftover contract fields are ignored');
}

// ── Whitelisted helper functions validate (used by the clickable builder) ─
// condition / filter / switch exprs using contains/startsWith/isEmpty must
// parse cleanly so saving a clickable-built filter doesn't 400.
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'c1', type: 'condition', expr: 'contains(steps.trg.output.name, ".pdf") && !isEmpty(steps.trg.output.name)' },
            { id: 'n1', type: 'notification', title: 'yes' },
            { id: 'n2', type: 'notification', title: 'no' },
        ],
        edges: [
            { from: 'trg', to: 'c1' },
            { from: 'c1', to: 'n1', label: 'then' },
            { from: 'c1', to: 'n2', label: 'else' },
        ],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'condition with helper fns should validate');
    assert.ok(!r.errors.some(e => e.code === 'condition.expr_parse'), 'no parse error for helper expr');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'f1', type: 'filter', arrayRef: 'steps.trg.output.items', expr: 'startsWith(item.name, "Re:")' }],
        edges: [{ from: 'trg', to: 'f1' }],
    };
    const r = validateDefinition(def);
    assert.ok(!r.errors.some(e => e.code === 'filter.expr_parse'), 'filter helper expr parses');
}

// ── An arbitrary function call in an expr is STILL a parse error ──────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'f1', type: 'filter', arrayRef: 'steps.trg.output.items', expr: 'fetch(item.url)' }],
        edges: [{ from: 'trg', to: 'f1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'arbitrary call must be rejected');
    assert.ok(r.errors.some(e => e.code === 'filter.expr_parse'), 'expected filter.expr_parse for fetch()');
}

// ── loop.batchSize is OPTIONAL — omitted is fine (every pre-existing loop
// step has no batchSize at all; it must not suddenly start failing) ──────
{
    const def = {
        trigger: trigger(),
        steps: [{
            id: 'loop1', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 10,
            body: [{ id: 'n1', type: 'notification', title: 'hi' }],
        }],
        edges: [{ from: 'trg', to: 'loop1' }],
    };
    const r = validateDefinition(def);
    assert.ok(!r.errors.some(e => e.code === 'loop.batch_size_range'), 'omitted batchSize must not be flagged');
}

// ── loop.batchSize, when EXPLICITLY set, must be 1..1000 ──────────────────
{
    const def = {
        trigger: trigger(),
        steps: [{
            id: 'loop1', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 10, batchSize: 0,
            body: [{ id: 'n1', type: 'notification', title: 'hi' }],
        }],
        edges: [{ from: 'trg', to: 'loop1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'batchSize=0 must be rejected');
    assert.ok(r.errors.some(e => e.code === 'loop.batch_size_range'), 'expected loop.batch_size_range error');
}

// ── definition.triggers[] — additional webhook/app_event triggers ────────
// (scoped multi-trigger slice; schedule stays single-per-automation)
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'n1', type: 'notification', title: 'hi' }],
        edges: [{ from: 'trg', to: 'n1' }],
        triggers: [{ id: 'trg2', kind: 'webhook' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'a valid additional webhook trigger should validate clean');
}
{
    // Additional trigger can itself be an edge source.
    const def = {
        trigger: trigger(),
        steps: [{ id: 'n1', type: 'notification', title: 'hi' }, { id: 'n2', type: 'notification', title: 'hi2' }],
        edges: [{ from: 'trg', to: 'n1' }, { from: 'trg2', to: 'n2' }],
        triggers: [{ id: 'trg2', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'an additional trigger can source its own edge');
}
{
    // Schedule is allowed inside triggers[] since automation_schedules
    // (2026-09) — and gets the same cron rules as the primary, on ITS path.
    const ok = validateDefinition({
        trigger: trigger(),
        steps: [{ id: 'n1', type: 'notification', title: 'hi' }],
        edges: [{ from: 'trg2', to: 'n1' }],
        triggers: [{ id: 'trg2', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam' } }],
    });
    assert.strictEqual(ok.ok, true, `a schedule trigger inside triggers[] is accepted: ${JSON.stringify(ok.errors)}`);
    const bad = validateDefinition({
        trigger: trigger(),
        steps: [], edges: [],
        triggers: [{ id: 'trg2', kind: 'schedule' }],
    });
    assert.strictEqual(bad.ok, false, 'a secondary schedule without a cron cannot go live');
    const rec = bad.errors.find(e => e.code === 'trigger.schedule_missing');
    assert.ok(rec, 'expected trigger.schedule_missing');
    assert.ok(String(rec.path).includes('triggers[trg2]'), `path names the secondary trigger: ${rec.path}`);
    assert.ok(!bad.errors.some(e => e.code === 'triggers.kind_unsupported'), 'schedule is no longer an unsupported secondary kind');
}
{
    // Manual is also rejected as a SECONDARY trigger (only the one primary
    // entry point may be manual).
    const def = { trigger: trigger(), steps: [], edges: [], triggers: [{ id: 'trg2', kind: 'manual' }] };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'triggers.kind_unsupported'), 'manual must be rejected as a secondary trigger');
}
{
    // Duplicate id across trigger/triggers[]/steps is rejected.
    const def = { trigger: trigger(), steps: [], edges: [], triggers: [{ id: 'trg', kind: 'webhook' }] };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'triggers.item_id_duplicate'), 'expected a duplicate-id error');
}
{
    // triggers must be an array when present.
    const def = { trigger: trigger(), steps: [], edges: [], triggers: 'nope' };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'triggers.not_array'), 'expected triggers.not_array');
}
{
    // A cycle THROUGH an additional trigger's own edge is still rejected —
    // Kahn's algorithm already seeds from every in-degree-0 node.
    const def = {
        trigger: trigger(),
        steps: [{ id: 'a', type: 'notification', title: 'x' }, { id: 'b', type: 'notification', title: 'y' }],
        edges: [{ from: 'trg', to: 'a' }, { from: 'trg2', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
        triggers: [{ id: 'trg2', kind: 'webhook' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'a real cycle must still be rejected regardless of extra triggers');
    assert.ok(r.errors.some(e => e.code === 'graph.cycle'));
}

// ── A step with no path from the trigger (orphan/disconnected) is VALID ──
// Regression lock: it's fine for a step to not be wired to the trigger yet
// (mid-build, or intentionally staged for later). topoOrder seeds Kahn's
// algorithm from every in-degree-0 node, not just the trigger, so this
// already passes today — this test guards against that silently regressing.
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'connected', type: 'notification', title: 'hi' },
            { id: 'orphan', type: 'notification', title: 'unwired' },
        ],
        edges: [{ from: 'trg', to: 'connected' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'a disconnected step must not fail validation');
    assert.ok(!r.errors.some(e => typeof e.path === 'string' && e.path.includes('orphan')), 'no error scoped to the orphan step');
    assert.ok(!r.warnings.some(e => typeof e.path === 'string' && e.path.includes('orphan')), 'no warning scoped to the orphan step either');
}

// ── http_request step ────────────────────────────────────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'h1', type: 'http_request' }],
        edges: [{ from: 'trg', to: 'h1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'http_request with no url is an error');
    assert.ok(r.errors.some(e => e.code === 'http_request.url_missing'));
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'h1', type: 'http_request', url: 'https://api.example.com' }],
        edges: [{ from: 'trg', to: 'h1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'url alone is enough — method/headers/body/timeout/blockPrivateTargets all default');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'h1', type: 'http_request', url: 'https://api.example.com', method: 'TRACE' }],
        edges: [{ from: 'trg', to: 'h1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'an unsupported method is an error');
    assert.ok(r.errors.some(e => e.code === 'http_request.method_unsupported'));
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'h1', type: 'http_request', url: 'https://api.example.com', headers: 'not-an-object' }],
        edges: [{ from: 'trg', to: 'h1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'non-object headers is an error');
    assert.ok(r.errors.some(e => e.code === 'http_request.headers_shape'));
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'h1', type: 'http_request', url: 'https://api.example.com', headers: { Authorization: 123 } }],
        edges: [{ from: 'trg', to: 'h1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'a non-string header value is an error');
    assert.ok(r.errors.some(e => e.code === 'http_request.header_value_shape'));
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'h1', type: 'http_request', url: 'https://api.example.com', timeoutMs: 500 }],
        edges: [{ from: 'trg', to: 'h1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'timeoutMs below 1000 is an error');
    assert.ok(r.errors.some(e => e.code === 'http_request.timeout_range'));
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'h1', type: 'http_request', url: 'https://api.example.com', blockPrivateTargets: 'yes' }],
        edges: [{ from: 'trg', to: 'h1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'blockPrivateTargets must be a boolean, not a string');
    assert.ok(r.errors.some(e => e.code === 'http_request.block_private_targets_shape'));
}
{
    const def = {
        trigger: trigger(),
        // The body reads the trigger: http_request templates are reference-scoped
        // now, and the old `steps.a` named a step this fixture never had.
        steps: [{ id: 'h1', type: 'http_request', url: 'https://api.example.com', method: 'post', headers: { 'Content-Type': 'application/json' }, body: '{{trigger.output.x}}', timeoutMs: 30_000, blockPrivateTargets: false }],
        edges: [{ from: 'trg', to: 'h1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'a fully-specified http_request (incl. blockPrivateTargets:false) is valid — the opt-out itself is not an error');
}

// ── app_trigger: primary trigger with declared typed params ─────────────
{
    const def = {
        trigger: { id: 'trg', kind: 'app_trigger', params: [
            { name: 'title', type: 'string', required: true },
            { name: 'amount', type: 'number' },
            { name: 'rows', type: 'array' },
            { name: 'meta', type: 'object', description: 'free-form context' },
            { name: 'doc', type: 'file', required: true },
        ] },
        steps: [], edges: [],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, `app_trigger with typed params should validate: ${JSON.stringify(r.errors)}`);
}
{
    // Params absent = zero-input app trigger, legal.
    const r = validateDefinition({ trigger: { id: 'trg', kind: 'app_trigger' }, steps: [], edges: [] });
    assert.strictEqual(r.ok, true, 'app_trigger without params should validate');
}
{
    // Declaration errors surface as app_trigger.* codes with trigger paths.
    const def = {
        trigger: { id: 'trg', kind: 'app_trigger', params: [
            { name: '_reserved', type: 'string' },
            { name: 'dup', type: 'string' },
            { name: 'dup', type: 'blob' },
        ] },
        steps: [], edges: [],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'bad app_trigger params must block');
    assert.ok(r.errors.some(e => e.code === 'app_trigger.param_name' && e.path.includes('trigger.params[0].name')), 'leading underscore rejected');
    assert.ok(r.errors.some(e => e.code === 'app_trigger.param_name_duplicate'), 'duplicate name rejected');
    assert.ok(r.errors.some(e => e.code === 'app_trigger.param_type'), 'unknown type rejected');
}
{
    // app_trigger is primary-only: the triggers[] enum still rejects it.
    const def = {
        trigger: trigger(),
        triggers: [{ id: 'trg2', kind: 'app_trigger' }],
        steps: [], edges: [],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'app_trigger as an additional trigger must be rejected');
    assert.ok(r.errors.some(e => e.code === 'triggers.kind_unsupported'));
}

// ── http_request.auth (Feature C — saved credential reference) ───────────
{
    // Absent and null are both fine (back-compat).
    for (const auth of [undefined, null]) {
        const def = {
            trigger: trigger(),
            steps: [{ id: 'h1', type: 'http_request', url: 'https://api.example.com', ...(auth === undefined ? {} : { auth }) }],
            edges: [{ from: 'trg', to: 'h1' }],
        };
        const r = validateDefinition(def);
        assert.strictEqual(r.ok, true, `auth ${String(auth)} must validate clean`);
        assert.ok(!r.warnings.some(w => w.code.startsWith('http_request.auth')), 'no auth findings without auth');
    }
}
{
    // Malformed shapes → http_request.auth_shape error.
    for (const auth of ['conn-1', 42, {}, { connectionId: '' }, { connectionId: 42 }, { connectionId: 'c1', extra: true }]) {
        const def = {
            trigger: trigger(),
            steps: [{ id: 'h1', type: 'http_request', url: 'https://api.example.com', auth }],
            edges: [{ from: 'trg', to: 'h1' }],
        };
        const r = validateDefinition(def);
        assert.strictEqual(r.ok, false, `auth ${JSON.stringify(auth)} must be rejected`);
        assert.ok(r.errors.some(e => e.code === 'http_request.auth_shape' && e.path.includes('h1')), 'auth_shape error expected');
    }
}
{
    // Well-formed auth + a manual Authorization header (any casing) → conflict warning.
    const def = {
        trigger: trigger(),
        steps: [{ id: 'h1', type: 'http_request', url: 'https://api.example.com', headers: { AUTHORIZATION: 'Bearer manual' }, auth: { connectionId: 'c1' } }],
        edges: [{ from: 'trg', to: 'h1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'conflict is a warning, not an error');
    const w = r.warnings.find(x => x.code === 'http_request.auth_header_conflict');
    assert.ok(w, 'auth_header_conflict warning expected');
    assert.ok(/replaces this manual header/.test(w.hint));
}
{
    // Unknown-connection warning ONLY when knownConnectionIds is provided.
    const def = {
        trigger: trigger(),
        steps: [{ id: 'h1', type: 'http_request', url: 'https://api.example.com', auth: { connectionId: 'c-unknown' } }],
        edges: [{ from: 'trg', to: 'h1' }],
    };
    let r = validateDefinition(def);
    assert.ok(!r.warnings.some(w => w.code === 'http_request.auth_connection_unknown'), 'no catalog → check skipped');
    r = validateDefinition(def, { knownConnectionIds: new Set(['c-known']) });
    assert.strictEqual(r.ok, true, 'unknown credential is a warning (activation stays possible)');
    assert.ok(r.warnings.some(w => w.code === 'http_request.auth_connection_unknown'), 'unknown id flagged when a catalog is provided');
    r = validateDefinition(def, { knownConnectionIds: new Set(['c-unknown']) });
    assert.ok(!r.warnings.some(w => w.code === 'http_request.auth_connection_unknown'), 'accessible id not flagged');
}

// ── Edge colour: a cosmetic palette KEY — never blocks, typos warn ───────
{
    const def = (color) => ({
        trigger: trigger(),
        steps: [{ id: 'n1', type: 'notification', title: 'x', body: 'y' }],
        edges: [{ from: 'trg', to: 'n1', ...(color === undefined ? {} : { color }) }],
    });
    // A valid key: silent.
    let r = validateDefinition(def('red'));
    assert.strictEqual(r.ok, true, 'coloured edge validates');
    assert.ok(!r.warnings.some(w => w.code === 'edge.color_unknown'), 'known colour key is silent');
    // No colour at all: silent.
    r = validateDefinition(def(undefined));
    assert.ok(!r.warnings.some(w => w.code === 'edge.color_unknown'), 'absent colour is silent');
    // A typo / non-key value: WARNING only — cosmetics must never block a save.
    for (const bad of ['purple', '#ff0000', 7, null]) {
        r = validateDefinition(def(bad));
        assert.strictEqual(r.ok, true, `bad colour ${JSON.stringify(bad)} still saves`);
        const w = r.warnings.find(x => x.code === 'edge.color_unknown');
        assert.ok(w, `bad colour ${JSON.stringify(bad)} warns`);
        assert.ok(/default line colour/.test(w.message));
    }
}

// ── piiLineColors: cosmetic overrides — same never-block posture ─────────
{
    const def = (piiLineColors) => ({
        trigger: trigger(),
        steps: [{ id: 'n1', type: 'notification', title: 'x', body: 'y' }],
        edges: [{ from: 'trg', to: 'n1' }],
        ...(piiLineColors === undefined ? {} : { piiLineColors }),
    });
    let r = validateDefinition(def({ Contact: 'green', Financial: 'orange' }));
    assert.strictEqual(r.ok, true);
    assert.ok(!r.warnings.some(w => w.code.startsWith('piiLineColors')), 'valid keys are silent');
    r = validateDefinition(def({ Contact: 'purple' }));
    assert.strictEqual(r.ok, true, 'bad colour value still saves');
    assert.ok(r.warnings.some(w => w.code === 'piiLineColors.color_unknown'));
    r = validateDefinition(def('green'));
    assert.strictEqual(r.ok, true);
    assert.ok(r.warnings.some(w => w.code === 'piiLineColors.shape'));
}

// ── guard: scan config + branch wiring ───────────────────────────────────
{
    const guardDef = (over = {}, edges = null) => ({
        trigger: trigger(),
        steps: [
            { id: 'g1', type: 'guard', sourceRef: 'trigger.output.body', ...over },
            { id: 'n1', type: 'notification', title: 'PII found', body: 'x' },
        ],
        edges: edges || [{ from: 'trg', to: 'g1' }, { from: 'g1', to: 'n1', label: 'then' }],
    });

    let r = validateDefinition(guardDef());
    assert.strictEqual(r.ok, true, 'a guard with a source and a wired branch validates');
    assert.ok(r.warnings.some(w => w.code === 'guard.partial_branch'), 'one-sided wiring is a warning, not an error');

    // Nothing to scan yet WARNS but still saves. An error here would make a
    // freshly dropped guard unsaveable, so the canvas would show a node the
    // saved definition does not have — and Execute would then fail with
    // "step not found in definition", which explains nothing. The RUNTIME
    // refuses to run it (execGuard), so nothing passes quietly.
    r = validateDefinition(guardDef({ sourceRef: '' }));
    assert.strictEqual(r.ok, true, 'a half-configured guard can still be saved');
    assert.ok(r.warnings.some(w => w.code === 'guard.sourceRef_missing'), 'but it is flagged');

    // A typo'd category would narrow the scan to nothing and report clean —
    // the one failure this step must never have, so it is an ERROR.
    r = validateDefinition(guardDef({ categories: ['Email', 'Emial'] }));
    assert.ok(r.errors.some(e => e.code === 'guard.category_unknown'), 'a typo\'d category is rejected');
    r = validateDefinition(guardDef({ categories: ['Email', 'Person'] }));
    assert.strictEqual(r.ok, true, 'real category ids pass');

    r = validateDefinition(guardDef({ confidence: 1.5 }));
    assert.ok(r.errors.some(e => e.code === 'guard.confidence_invalid'));
    r = validateDefinition(guardDef({ confidence: 0.9 }));
    assert.strictEqual(r.ok, true);

    r = validateDefinition(guardDef({ onFound: 'stop' }));
    assert.ok(r.errors.some(e => e.code === 'guard.onFound_invalid'));

    // Neither branch wired yet: a WARNING, and the definition still saves.
    // You drop the node first and wire the alert second, and every save in
    // between runs through this validator — an error there makes the
    // intermediate state unsaveable, so the canvas holds a node the stored
    // definition does not and the next action fails with
    // "runPartial: step not found in definition".
    r = validateDefinition(guardDef({}, [{ from: 'trg', to: 'g1' }]));
    assert.strictEqual(r.ok, true, 'a half-wired guard can still be saved');
    assert.ok(r.warnings.some(w => w.code === 'guard.dead_branch'), 'but it is flagged');
    assert.ok(!r.warnings.some(w => w.code === 'condition.dead_branch'), 'and it says GUARD, not condition');

    // A CONDITION keeps its harder rule — it is spliced into an existing edge
    // rather than dropped at the end, so it never needs the unwired grace.
    r = validateDefinition({
        trigger: trigger(),
        steps: [{ id: 'c1', type: 'condition', expr: 'true' }],
        edges: [{ from: 'trg', to: 'c1' }],
    });
    assert.ok(r.errors.some(e => e.code === 'condition.dead_branch'));

    // A guard routes by its own branch labels, so an on_error edge would
    // shadow that routing — same rule as condition/switch.
    r = validateDefinition(guardDef({}, [
        { from: 'trg', to: 'g1' }, { from: 'g1', to: 'n1', label: 'then' }, { from: 'g1', to: 'n1', label: 'on_error' },
    ]));
    assert.ok(!r.ok, 'an on_error edge out of a guard is rejected');

    // The scanned path is scope-checked like any other ref.
    r = validateDefinition(guardDef({ sourceRef: 'steps.nope.output.x' }));
    assert.ok(r.errors.length || r.warnings.length, 'a dangling sourceRef is reported');
}

// ── tokenize: shares the guard's scan config, differs in outcome ─────────
{
    const tokDef = (over = {}, edges = null) => ({
        trigger: trigger(),
        steps: [
            { id: 't1', type: 'tokenize', sourceRef: 'trigger.output.body', ...over },
            { id: 'n1', type: 'notification', title: 'x', body: 'y' },
        ],
        edges: edges || [{ from: 'trg', to: 't1' }, { from: 't1', to: 'n1' }],
    });

    let r = validateDefinition(tokDef());
    assert.strictEqual(r.ok, true, 'a bound tokenize step validates');
    // It is NOT a brancher, so there is no dead-branch rule to satisfy.
    assert.ok(!r.warnings.some(w => w.code.endsWith('.dead_branch')));

    // The scan config is shared, so its checks are too — and the codes name
    // the step the author is looking at, not "guard".
    r = validateDefinition(tokDef({ categories: ['Emial'] }));
    assert.ok(r.errors.some(e => e.code === 'tokenize.category_unknown'), 'a typo is rejected for tokenize too');
    r = validateDefinition(tokDef({ confidence: 2 }));
    assert.ok(r.errors.some(e => e.code === 'tokenize.confidence_invalid'));

    r = validateDefinition(tokDef({ sourceRef: '' }));
    assert.strictEqual(r.ok, true, 'half-configured still saves');
    assert.ok(r.warnings.some(w => w.code === 'tokenize.sourceRef_missing'));

    // onFound belongs to the guard; a tokenize step has one outcome, so the
    // key is simply not its business to police.
    r = validateDefinition(tokDef({ onFound: 'nonsense' }));
    assert.ok(!r.errors.some(e => e.code.endsWith('.onFound_invalid')));

    // It CAN fail (no policy, detector down), so an error branch is legal —
    // unlike the guard, which routes by its own labels.
    r = validateDefinition(tokDef({}, [
        { from: 'trg', to: 't1' }, { from: 't1', to: 'n1' }, { from: 't1', to: 'n1', label: 'on_error' },
    ]));
    assert.strictEqual(r.ok, true, 'an on_error branch out of tokenize is allowed');
}

// ── note (BFSF-411): a canvas annotation — bounds-checked, never wired ───
{
    const noteDef = (over = {}) => ({
        trigger: trigger(),
        steps: [{ id: 'note_1', type: 'note', ...over }],
        edges: [],
    });

    // Bare/empty note (nothing written yet) is valid — same "freshly dropped
    // node survives autosave" posture as every other optional-content step.
    let r = validateDefinition(noteDef());
    assert.strictEqual(r.ok, true, 'a bare note validates');

    r = validateDefinition(noteDef({ text: 'why this branch exists' }));
    assert.strictEqual(r.ok, true, 'a note with text validates');

    // Oversized text is an error, not a silent truncation.
    r = validateDefinition(noteDef({ text: 'x'.repeat(5000) }));
    assert.ok(r.errors.some(e => e.code === 'note.text_invalid'), 'oversized note text is rejected');

    // Size bounds.
    r = validateDefinition(noteDef({ size: { width: 10, height: 40 } }));
    assert.ok(r.errors.some(e => e.code === 'note.size_invalid'), 'a too-small width is rejected');
    r = validateDefinition(noteDef({ size: 'nope' }));
    assert.ok(r.errors.some(e => e.code === 'note.size_invalid'), 'a non-object size is rejected');
    r = validateDefinition(noteDef({ size: { width: 200, height: 140 } }));
    assert.strictEqual(r.ok, true, 'an in-range size validates');

    // Colour — cosmetic, so unknown is a WARNING (like edge.color), never a
    // blocker; a known key is silent.
    r = validateDefinition(noteDef({ color: 'not-a-colour' }));
    assert.ok(r.warnings.some(w => w.code === 'note.color_unknown'));
    assert.strictEqual(r.ok, true, 'an unknown colour still saves');
    r = validateDefinition(noteDef({ color: 'blue' }));
    assert.ok(!r.warnings.some(w => w.code === 'note.color_unknown'), 'a known colour is silent');

    // The graph-level guarantee: a note can never be wired into the flow, in
    // either direction — this is what execution.js/execFlow.js build the
    // "never dispatched" contract ON, so it is enforced here too rather than
    // left to whichever builder tool happened to produce the edge.
    r = validateDefinition({
        trigger: trigger(),
        steps: [
            { id: 'note_1', type: 'note', text: 'x' },
            { id: 'n1', type: 'notification', title: 'hi' },
        ],
        edges: [{ from: 'trg', to: 'note_1' }, { from: 'note_1', to: 'n1' }],
    });
    assert.strictEqual(r.ok, false, 'an edge touching a note must block');
    const fromCodes = r.errors.filter(e => e.code === 'edge.note_no_edges');
    assert.strictEqual(fromCodes.length, 2, 'both the incoming and the outgoing edge are flagged');

    // A note with zero edges sits fine alongside a real, fully-wired flow —
    // the DAG/topo-order pass tolerates an isolated node (Kahn's algorithm
    // seeds every in-degree-0 node, not just the trigger).
    r = validateDefinition({
        trigger: trigger(),
        steps: [
            { id: 'n1', type: 'notification', title: 'hi' },
            { id: 'note_1', type: 'note', text: 'unrelated context' },
        ],
        edges: [{ from: 'trg', to: 'n1' }],
    });
    assert.strictEqual(r.ok, true, 'an isolated note beside a real flow validates');
}

console.log('validate.test.js — all checks passed');
