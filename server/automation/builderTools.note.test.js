/**
 * builder_add_note (BFSF-411) — the AI/MCP route into a free-floating canvas
 * annotation. Notes are deliberately NOT a normal builder_add_* step:
 *
 *   - no afterStepId/branch/caseName in the schema — there is nothing to
 *     chain it after
 *   - NOT in ADD_FOR_TYPE, so builder_replace_step / builder_add_steps both
 *     refuse it by construction (replacing an existing WIRED step into a
 *     note would leave dangling edges pointing at something that must never
 *     carry one)
 *   - builder_update_step still patches it in place (text/position/size/color)
 *
 * Run: node --test automation/builderTools.note.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { applyToolCall, TOOL_SCHEMAS } = require('./builderTools');
const { validateDefinition } = require('./validate');

const freshWrap = () => ({
    userId: 'u_test',
    def: { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] },
});
const addNote = (dw, args) => applyToolCall('builder_add_note', args, dw);
const only = (dw) => dw.def.steps[dw.def.steps.length - 1];

test('the tool exists, requires only text, and offers no wiring fields', () => {
    const schema = TOOL_SCHEMAS.find(t => t.function.name === 'builder_add_note');
    assert.ok(schema, 'registered in TOOL_SCHEMAS');
    assert.deepStrictEqual(schema.function.parameters.required, ['text']);
    const props = schema.function.parameters.properties;
    for (const wiringField of ['afterStepId', 'branch', 'caseName']) {
        assert.strictEqual(props[wiringField], undefined, `note schema must not offer ${wiringField}`);
    }
});

test('an added note carries no edge at all — not even from the trigger', async () => {
    const dw = freshWrap();
    const res = await addNote(dw, { text: 'why this branch exists' });
    assert.ok(!res.error, res.error);
    assert.strictEqual(dw.def.steps.length, 1);
    assert.strictEqual(dw.def.edges.length, 0, 'no edge was minted for the note');
    const step = only(dw);
    assert.strictEqual(step.type, 'note');
    assert.strictEqual(step.text, 'why this branch exists');
    const r = validateDefinition(dw.def);
    assert.deepStrictEqual(r.errors, [], JSON.stringify(r.errors));
});

test('text is required — a note with nothing to say is refused', async () => {
    const res = await addNote(freshWrap(), {});
    assert.ok(res.error, 'refused');
    const res2 = await addNote(freshWrap(), { text: '   ' });
    assert.ok(res2.error, 'whitespace-only text is refused too');
});

test('position/size/color are sanitized and clamped the same way validate.js bounds them', async () => {
    const dw = freshWrap();
    await addNote(dw, {
        text: 'x', position: { x: 100, y: 40 }, size: { width: 10, height: 99999 }, color: 'blue',
    });
    const step = only(dw);
    assert.deepStrictEqual(step.position, { x: 100, y: 40 });
    // Out-of-range dimensions are clamped into range, not rejected — the note
    // still lands, just at a sane size.
    assert.ok(step.size.width >= 40 && step.size.height <= 2000, JSON.stringify(step.size));
    assert.strictEqual(step.color, 'blue');
    assert.deepStrictEqual(validateDefinition(dw.def).errors, []);
});

test('an unknown color is silently dropped rather than persisted as garbage', async () => {
    const dw = freshWrap();
    await addNote(dw, { text: 'x', color: 'not-a-real-color' });
    assert.strictEqual(only(dw).color, undefined);
});

test('a note can be added alongside a real, already-wired flow without touching its edges', async () => {
    const dw = {
        userId: 'u_test',
        def: {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [{ id: 'n1', type: 'notification', title: 'hi' }],
            edges: [{ from: 'trg', to: 'n1' }],
        },
    };
    const before = JSON.stringify(dw.def.edges);
    await addNote(dw, { text: 'context for n1' });
    assert.strictEqual(JSON.stringify(dw.def.edges), before, 'existing edges are untouched');
    assert.strictEqual(dw.def.steps.length, 2);
});

test('a note added LAST does not become the implicit anchor for the next builder_add_* call', async () => {
    // The real regression this guards: lastStepId() used to return
    // whichever step was physically last in the array, so adding a note and
    // then another step with no afterStepId would wire FROM the note.
    const dw = freshWrap();
    await addNote(dw, { text: 'a floating note' });
    const res = await applyToolCall('builder_add_notification', { title: 'hi' }, dw);
    assert.ok(!res.error, res.error);
    const notif = dw.def.steps.find(s => s.type === 'notification');
    const noteId = dw.def.steps.find(s => s.type === 'note').id;
    assert.ok(!dw.def.edges.some(e => e.from === noteId || e.to === noteId), 'the note still has no edges');
    assert.ok(dw.def.edges.some(e => e.from === 'trg' && e.to === notif.id), 'the new step wired from the trigger instead, skipping the note');
});

test('builder_replace_step refuses to turn a step into a note (ADD_FOR_TYPE has no entry)', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_add_notification', { title: 'hi' }, dw);
    const stepId = only(dw).id;
    const res = await applyToolCall('builder_replace_step', { stepId, newType: 'note', spec: { text: 'x' } }, dw);
    assert.ok(res.error, 'refused');
    assert.match(res.error, /note/);
});

test('builder_add_steps (batch) refuses a note entry — use builder_add_note instead', async () => {
    const dw = freshWrap();
    const res = await applyToolCall('builder_add_steps', {
        steps: [{ type: 'note', spec: { text: 'x' } }],
    }, dw);
    assert.ok(res.error, 'refused');
    assert.strictEqual(dw.def.steps.length, 0, 'nothing was added');
});

test('builder_update_step patches text/position/size/color in place', async () => {
    const dw = freshWrap();
    await addNote(dw, { text: 'first draft' });
    const id = only(dw).id;

    const res = await applyToolCall('builder_update_step', {
        stepId: id,
        patch: { text: 'revised', position: { x: 10, y: 20 }, size: { width: 300, height: 200 }, color: 'rose' },
    }, dw);
    assert.ok(!res.error, res.error);
    const step = only(dw);
    assert.strictEqual(step.id, id);
    assert.strictEqual(step.text, 'revised');
    assert.deepStrictEqual(step.position, { x: 10, y: 20 });
    assert.deepStrictEqual(step.size, { width: 300, height: 200 });
    assert.strictEqual(step.color, 'rose');
    assert.deepStrictEqual(validateDefinition(dw.def).errors, []);
});

test('builder_update_step rejects a field outside the note allow-list', async () => {
    const dw = freshWrap();
    await addNote(dw, { text: 'x' });
    const res = await applyToolCall('builder_update_step', {
        stepId: only(dw).id, patch: { expr: 'true' },
    }, dw);
    assert.ok(res.error, 'refused');
});

test('builder_remove_step removes a note cleanly — no edges to reconnect', async () => {
    const dw = freshWrap();
    await addNote(dw, { text: 'x' });
    const id = only(dw).id;
    const res = await applyToolCall('builder_remove_step', { stepId: id }, dw);
    assert.ok(!res.error, res.error);
    assert.strictEqual(dw.def.steps.length, 0);
});
