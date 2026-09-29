/**
 * BFSF-323 — two-tier validation ('draft' vs 'activate').
 *
 * Run: node --test automation/validate.stage.test.js
 *
 * Every builder save PUTs the WHOLE definition (the node inspector merges its
 * patch into the full document client-side), so before this split a single
 * incomplete node blocked every edit anywhere in the flow: you could not change
 * the trigger's kind while a downstream If node still had unwired branches.
 *
 * The contract these tests lock in:
 *   - draft stage blocks INTEGRITY problems only (shape, ids, edges, cycles,
 *     unknown types, size caps)
 *   - draft stage downgrades COMPLETENESS problems to warnings tagged
 *     `blockedAt: 'activate'`
 *   - activate stage (the default) is unchanged in every respect
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition, COMPLETENESS_CODES } = require('./validate');

const trigger = () => ({ id: 'trg', kind: 'manual' });

/** A flow whose only problem is an If node with neither branch wired. */
function deadBranchDef() {
    return {
        trigger: trigger(),
        steps: [{ id: 'cond_7c17a2e6', type: 'condition', expr: 'true' }],
        edges: [{ from: 'trg', to: 'cond_7c17a2e6' }],
    };
}

test('activate stage still blocks a dead-branch condition (unchanged)', () => {
    const strict = validateDefinition(deadBranchDef());
    assert.equal(strict.ok, false);
    assert.ok(strict.errors.some(e => e.code === 'condition.dead_branch'));

    // The default must be 'activate' so every pre-existing caller is unchanged.
    const explicit = validateDefinition(deadBranchDef(), { stage: 'activate' });
    assert.deepEqual(explicit.errors.map(e => e.code), strict.errors.map(e => e.code));
});

test('draft stage lets a dead-branch condition save, as a tagged warning', () => {
    const r = validateDefinition(deadBranchDef(), { stage: 'draft' });
    assert.equal(r.ok, true, 'a half-built flow must stay saveable');
    assert.deepEqual(r.errors, []);

    const rec = r.warnings.find(w => w.code === 'condition.dead_branch');
    assert.ok(rec, 'the problem is still reported, just not blocking');
    assert.equal(rec.severity, 'warning');
    assert.equal(rec.blockedAt, 'activate', 'UI needs to say this will block activation');
    assert.ok(rec.path.includes('cond_7c17a2e6'), 'path still names the step for node mapping');
});

test('draft stage keeps the trigger editable while another node is incomplete', () => {
    // The exact reported repro: changing trigger.kind with a broken If node
    // downstream. Only the trigger differs from deadBranchDef().
    const def = { ...deadBranchDef(), trigger: { id: 'trg', kind: 'webhook' } };
    assert.equal(validateDefinition(def, { stage: 'draft' }).ok, true);
});

test('draft stage downgrades unfilled required fields, not just dead branches', () => {
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'ai1', type: 'ai_step' },                       // prompt_missing
            { id: 'act1', type: 'integration_action' },           // tool_missing
            // itemVar/overRef/body missing. maxIterations IS set: it is a RANGE
            // rule, so it stays blocking at every stage, and the builder always
            // populates it (buildStepFromPayload defaults it to 100).
            { id: 'lp1', type: 'loop', body: [], maxIterations: 100 },
        ],
        edges: [{ from: 'trg', to: 'ai1' }, { from: 'ai1', to: 'act1' }, { from: 'act1', to: 'lp1' }],
    };
    assert.equal(validateDefinition(def).ok, false, 'all of these block activation');

    const draft = validateDefinition(def, { stage: 'draft' });
    assert.equal(draft.ok, true);
    for (const code of ['ai_step.prompt_missing', 'integration_action.tool_missing', 'loop.body_missing']) {
        assert.ok(draft.warnings.some(w => w.code === code), `${code} should be a draft warning`);
    }
});

// ── Integrity problems must STILL block at draft stage ───────────────────────

test('draft stage still blocks an edge pointing at a nonexistent step', () => {
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'notification', title: 'T', body: 'b', channels: ['notification'] }],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'ghost' }],
    };
    const r = validateDefinition(def, { stage: 'draft' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.code === 'edge.unknown_to'));
});

test('draft stage still blocks duplicate step ids', () => {
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'dup', type: 'notification', title: 'A', body: 'a', channels: ['notification'] },
            { id: 'dup', type: 'notification', title: 'B', body: 'b', channels: ['notification'] },
        ],
        edges: [],
    };
    const r = validateDefinition(def, { stage: 'draft' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.code === 'step.id_duplicate'));
});

test('draft stage still blocks an unknown step type', () => {
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'teleport' }], edges: [] };
    const r = validateDefinition(def, { stage: 'draft' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.code === 'step.unknown_type'));
});

test('draft stage still blocks a cycle', () => {
    const n = (id) => ({ id, type: 'notification', title: id, body: 'x', channels: ['notification'] });
    const def = {
        trigger: trigger(),
        steps: [n('a'), n('b')],
        edges: [{ from: 'trg', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    };
    const r = validateDefinition(def, { stage: 'draft' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.code === 'graph.cycle'));
});

test('draft stage still blocks the graph-size ceiling', () => {
    const steps = Array.from({ length: 501 }, (_, i) => ({
        id: `s${i}`, type: 'notification', title: 't', body: 'b', channels: ['notification'],
    }));
    const r = validateDefinition({ trigger: trigger(), steps, edges: [] }, { stage: 'draft' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.code === 'shape.too_many_steps'));
});

test('draft stage still blocks a non-object definition', () => {
    assert.equal(validateDefinition(null, { stage: 'draft' }).ok, false);
    assert.equal(validateDefinition('nope', { stage: 'draft' }).ok, false);
});

test('draft stage still blocks a missing trigger', () => {
    const r = validateDefinition({ steps: [], edges: [] }, { stage: 'draft' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.code === 'trigger.missing'));
});

// ── Shape coercion: a trigger-only draft is a valid EMPTY draft (BFSF-318) ───

test('draft stage accepts a trigger-only definition; activate still rejects it', () => {
    const def = { trigger: { id: 'trg', kind: 'schedule', schedule: { cron: '0 9 * * 1', tz: 'Europe/Amsterdam' } } };

    const strict = validateDefinition(def);
    assert.equal(strict.ok, false);
    assert.ok(strict.errors.some(e => e.code === 'steps.not_array'));
    assert.ok(strict.errors.some(e => e.code === 'edges.not_array'));

    const draft = validateDefinition(def, { stage: 'draft' });
    assert.equal(draft.ok, true, 'a trigger with no steps yet is a valid empty draft');
});

test('draft-stage coercion does not mutate the caller definition', () => {
    const def = { trigger: trigger() };
    validateDefinition(def, { stage: 'draft' });
    assert.equal(def.steps, undefined);
    assert.equal(def.edges, undefined);
});

test('draft stage coerces layer graphs too', () => {
    const def = {
        trigger: trigger(),
        steps: [],
        edges: [],
        layers: { enrich: { title: 'Enrich', trigger: { id: 'lt', kind: 'layer_input' } } },
    };
    // The layer has no steps/edges and no layer_output — shape is coerced,
    // the missing output is a completeness warning.
    const r = validateDefinition(def, { stage: 'draft' });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some(w => w.code === 'layer.no_output'));
});

// ── The set itself ──────────────────────────────────────────────────────────

test('COMPLETENESS_CODES excludes every integrity code it must not swallow', () => {
    for (const code of [
        'steps.not_array', 'edges.not_array', 'trigger.missing', 'shape.not_object',
        'step.id_duplicate', 'step.unknown_type', 'edge.unknown_from', 'edge.unknown_to',
        'graph.cycle', 'shape.too_many_steps', 'shape.too_many_nodes',
        // Range rules stay blocking at every stage: a draft CAN be run manually,
        // so an out-of-range loop bound must never become merely advisory.
        'loop.max_iterations_range', 'loop.batch_size_range', 'wait.seconds_range',
        'http_request.timeout_range',
    ]) {
        assert.equal(COMPLETENESS_CODES.has(code), false, `${code} must always block`);
    }
});
