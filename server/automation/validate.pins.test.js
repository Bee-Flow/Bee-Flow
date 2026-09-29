/**
 * BFSF-408/409/434 — the validator rules for PINNED SAMPLE DATA.
 *
 * A pin is a payload saved onto a node so the node serves it instead of
 * running. Three things about one can be wrong in a way nothing else notices:
 * it can be enormous (and the definition is re-snapshotted into
 * automation_versions on every save), it can be the run history's truncation
 * SENTINEL rather than real output, and on a brancher it can carry no `branch`
 * — which routes to 'on_success', matches none of the node's then/else/case
 * edges, and dead-ends the flow with the run reported green.
 *
 * The rules live in validate/stepRules.js checkPinnedOutput, called from
 * checkStep for every step and from validate/graph.js for the trigger and each
 * additional trigger (checkStep never runs for a trigger).
 *
 * Run: node --test --test-force-exit automation/validate.pins.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition, COMPLETENESS_CODES } = require('./validate');
const { DEFAULT_MAX_BYTES, truncatePayload } = require('./payloadTruncation');

const trigger = (extra = {}) => ({ id: 'trg', type: 'trigger', kind: 'manual', ...extra });
const note = (id) => ({ id, type: 'notification', title: id, body: 'x', channels: ['notification'] });
const codesOf = (r) => [...r.errors, ...r.warnings].map(x => x.code);
const err = (r, code) => r.errors.find(e => e.code === code);

/** A pin that serializes to comfortably more than the cap. */
function oversizedPin() {
    return { rows: [{ blob: 'x'.repeat(DEFAULT_MAX_BYTES + 4096) }] };
}

// ── 1. Size ────────────────────────────────────────────────────────────────

test('an oversized pin on a step is an error, at draft stage too', () => {
    const def = {
        trigger: trigger(),
        steps: [{ ...note('n1'), pinnedOutput: oversizedPin() }],
        edges: [{ from: 'trg', to: 'n1' }],
    };
    const r = validateDefinition(def);
    const rec = err(r, 'pin.too_large');
    assert.ok(rec, `expected pin.too_large, got ${JSON.stringify(codesOf(r))}`);
    assert.match(rec.message, /Step n1/);
    assert.match(rec.message, /256 KB/, 'the message names the cap it imported');
    assert.equal(r.ok, false);

    // NOT completeness-listed: the cost of an oversized pin is paid on every
    // SAVE (a full definition snapshot into automation_versions), so the draft
    // stage has to block it too — downgrading it to a warning would make the
    // rule ornamental.
    assert.equal(COMPLETENESS_CODES.has('pin.too_large'), false);
    assert.equal(validateDefinition(def, { stage: 'draft' }).ok, false);
});

test('a pin just under the cap is fine', () => {
    const r = validateDefinition({
        trigger: trigger(),
        steps: [{ ...note('n1'), pinnedOutput: { blob: 'x'.repeat(1000) } }],
        edges: [{ from: 'trg', to: 'n1' }],
    });
    assert.equal(err(r, 'pin.too_large'), undefined, JSON.stringify(codesOf(r)));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('an oversized pin on the TRIGGER is caught — checkStep never sees a trigger', () => {
    const r = validateDefinition({
        trigger: trigger({ pinnedOutput: oversizedPin() }),
        steps: [note('n1')],
        edges: [{ from: 'trg', to: 'n1' }],
    });
    const rec = err(r, 'pin.too_large');
    assert.ok(rec, `expected pin.too_large on the trigger, got ${JSON.stringify(codesOf(r))}`);
    assert.match(rec.message, /^Trigger trg/, 'reported as a trigger, not a step');
    assert.equal(rec.path, 'trigger.pinnedOutput');
});

test('an oversized pin on an ADDITIONAL trigger is caught too', () => {
    const r = validateDefinition({
        trigger: trigger(),
        triggers: [{
            id: 'trg2', kind: 'webhook', pinnedOutput: oversizedPin(),
        }],
        steps: [note('n1')],
        edges: [{ from: 'trg', to: 'n1' }, { from: 'trg2', to: 'n1' }],
    });
    const rec = err(r, 'pin.too_large');
    assert.ok(rec, `expected pin.too_large on triggers[trg2], got ${JSON.stringify(codesOf(r))}`);
    assert.match(rec.message, /^Trigger trg2/);
    assert.equal(rec.path, 'triggers[trg2].pinnedOutput');
});

test('a pin on a step inside a LAYER is checked under the layer path', () => {
    const r = validateDefinition({
        trigger: trigger(),
        steps: [{ id: 'c1', type: 'call_layer', layerKey: 'enrich', inputs: {} }],
        edges: [{ from: 'trg', to: 'c1' }],
        layers: {
            enrich: {
                trigger: { id: 'lin', kind: 'layer_input', params: [] },
                steps: [
                    { ...note('ln1'), pinnedOutput: oversizedPin() },
                    { id: 'lout', type: 'layer_output', fields: {} },
                ],
                edges: [{ from: 'lin', to: 'ln1' }, { from: 'ln1', to: 'lout' }],
            },
        },
    });
    const rec = err(r, 'pin.too_large');
    assert.ok(rec, `expected pin.too_large in the layer, got ${JSON.stringify(codesOf(r))}`);
    assert.match(rec.path, /^layers\.enrich\./);
});

// ── 2. The truncation sentinel is not data ─────────────────────────────────

test('pinning the run history truncation sentinel is rejected', () => {
    // Built by the real truncator so the test can never disagree with it about
    // what the sentinel looks like.
    const sentinel = truncatePayload({ rows: Array.from({ length: 40_000 }, (_, i) => ({ i, s: 'value' })) }).value;
    assert.equal(sentinel.__truncated__, true, 'fixture really is the sentinel');

    const r = validateDefinition({
        trigger: trigger(),
        steps: [{ ...note('n1'), pinnedOutput: sentinel }],
        edges: [{ from: 'trg', to: 'n1' }],
    });
    const rec = err(r, 'pin.truncated_sample');
    assert.ok(rec, `expected pin.truncated_sample, got ${JSON.stringify(codesOf(r))}`);
    assert.match(rec.message, /placeholder/);
    assert.equal(r.ok, false);
});

// ── 3. Brancher shape ──────────────────────────────────────────────────────

const ifFlow = (pin, edges) => ({
    trigger: trigger(),
    steps: [{ id: 'c1', type: 'condition', expr: '1 == 1', pinnedOutput: pin }, note('yes'), note('no')],
    edges: [{ from: 'trg', to: 'c1' }, ...edges],
});

test('a pinned If with no branch is an error — it would silently dead-end the flow', () => {
    const r = validateDefinition(ifFlow({ value: true }, [
        { from: 'c1', to: 'yes', label: 'then' },
        { from: 'c1', to: 'no', label: 'else' },
    ]));
    const rec = err(r, 'pin.brancher_no_branch');
    assert.ok(rec, `expected pin.brancher_no_branch, got ${JSON.stringify(codesOf(r))}`);
    assert.match(rec.message, /which way the flow goes/);
    assert.match(rec.hint, /"branch": "then"/);
    assert.equal(r.ok, false);
});

test('a pinned If WITH a wired branch is clean', () => {
    const r = validateDefinition(ifFlow({ branch: 'then', value: true }, [
        { from: 'c1', to: 'yes', label: 'then' },
        { from: 'c1', to: 'no', label: 'else' },
    ]));
    assert.equal(err(r, 'pin.brancher_no_branch'), undefined, JSON.stringify(codesOf(r)));
    assert.equal(err(r, 'pin.brancher_branch_unwired'), undefined, JSON.stringify(codesOf(r)));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('a pinned If routing to a port nothing is wired to is an error', () => {
    const r = validateDefinition(ifFlow({ branch: 'else', value: false }, [
        { from: 'c1', to: 'yes', label: 'then' },
    ]));
    const rec = err(r, 'pin.brancher_branch_unwired');
    assert.ok(rec, `expected pin.brancher_branch_unwired, got ${JSON.stringify(codesOf(r))}`);
    assert.match(rec.message, /routes to "else"/);
    assert.match(rec.hint, /Wired ports: then/);
});

test('a pinned switch may name its port through caseName as well as label', () => {
    // An edge drawn from a case port can carry `caseName` and no `label`; the
    // runtime routes it (shared.js effectiveEdgeLabel), so the validator must
    // not call it a dead end.
    const base = {
        trigger: trigger(),
        steps: [
            {
                id: 'sw', type: 'switch', valueRef: 'trigger.output.kind',
                cases: [{ name: 'a', op: 'eq', value: 'a' }],
                pinnedOutput: { branch: 'case:a', branches: ['case:a'], matched: 'a' },
            },
            note('hit'),
        ],
        edges: [{ from: 'trg', to: 'sw' }, { from: 'sw', to: 'hit', caseName: 'a' }],
    };
    const r = validateDefinition(base);
    assert.equal(err(r, 'pin.brancher_branch_unwired'), undefined, JSON.stringify(codesOf(r)));
    assert.equal(err(r, 'pin.brancher_no_branch'), undefined, JSON.stringify(codesOf(r)));
});

test('a pinned brancher inside a loop body still has to declare a branch', () => {
    // Bodies carry no authored edges (the runtime synthesizes a linear,
    // brancher-aware chain), so only the does-it-match-an-edge half is skipped.
    const r = validateDefinition({
        trigger: trigger(),
        steps: [{
            id: 'lp', type: 'loop', itemVar: 'item', overRef: 'trigger.output.items', maxIterations: 10,
            body: [{ id: 'bc', type: 'condition', expr: '1 == 1', pinnedOutput: { value: true } }],
        }],
        edges: [{ from: 'trg', to: 'lp' }],
    });
    const rec = err(r, 'pin.brancher_no_branch');
    assert.ok(rec, `expected pin.brancher_no_branch in the body, got ${JSON.stringify(codesOf(r))}`);
    assert.match(rec.message, /Step bc/);
});

test('a non-brancher pin needs no branch at all', () => {
    const r = validateDefinition({
        trigger: trigger(),
        steps: [{ ...note('n1'), pinnedOutput: { anything: 'goes' } }],
        edges: [{ from: 'trg', to: 'n1' }],
    });
    assert.equal(err(r, 'pin.brancher_no_branch'), undefined, JSON.stringify(codesOf(r)));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── 4. Nothing pinned changes nothing ──────────────────────────────────────

test('a definition with no pins reports none of these codes', () => {
    const r = validateDefinition({
        trigger: trigger(),
        steps: [{ id: 'c1', type: 'condition', expr: '1 == 1' }, note('yes')],
        edges: [{ from: 'trg', to: 'c1' }, { from: 'c1', to: 'yes', label: 'then' }],
    });
    for (const code of codesOf(r)) assert.ok(!code.startsWith('pin.'), `unexpected ${code}`);
});
