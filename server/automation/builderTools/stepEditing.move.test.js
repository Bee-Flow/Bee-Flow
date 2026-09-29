/**
 * builder_update_step as a MOVE — position and branch wiring are patchable.
 *
 * REGRESSION (2026-09-11, measured on the demo box). The model's first repair
 * attempt in two of three thrashing builds was exactly one of these calls:
 *   update_step(loop,      {afterStepId: list_files})   → "not patchable"
 *   update_step(condition, {elseStepId: notification})  → "not patchable"
 * With no way to move a step it removed and re-added, the re-add (no
 * afterStepId) landed at the tail again, and it repeated that up to seven
 * times — 10-14 rounds per build, both hitting the 24-round cap. These tests
 * pin the two shapes as they happened, plus the edge cases of the primitive.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/stepEditing.move.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { applyToolCall, emptyDefinition } = require('../builderTools');
const { validateDefinition } = require('../validate');

function wrap() {
    // Every Nextcloud tool used below is pre-marked inspected so the §B3 gate
    // stays out of the way; these tests are about edges, not inspection.
    return { userId: 'u_test', def: emptyDefinition(), _inspectedTools: new Set(['nextcloud_list_files', 'nextcloud_read_file', 'nextcloud_create_spreadsheet']) };
}
const edges = (def) => def.edges.map(e => `${e.from}→${e.to}${e.label ? `(${e.label})` : ''}`).sort();
const order = (def) => def.steps.map(s => s.id);

test('run-6 shape: a loop appended at the tail moves after list_files and the chain re-joins', async () => {
    const dw = wrap();
    const list = (await applyToolCall('builder_add_action', { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/Invoices' } } }, dw)).added;
    const sheet = (await applyToolCall('builder_add_action', { tool: 'nextcloud_create_spreadsheet', inputs: { path: { kind: 'literal', value: '/x.xlsx' } } }, dw)).added;
    const notif = (await applyToolCall('builder_add_notification', { title: 'done' }, dw)).added;
    // No afterStepId → tail, exactly as the model did it.
    const loop = (await applyToolCall('builder_add_loop', { overRef: `steps.${list.id}.output.items`, itemVar: 'f', body: [{ type: 'notification', title: 'x' }] }, dw)).added;
    assert.ok(dw.def.edges.some(e => e.from === notif.id && e.to === loop.id), 'precondition: loop hangs off the notification');
    // Make the spreadsheet depend on the loop, as in the real build — a
    // FORWARD ref while the loop sits behind it.
    await applyToolCall('builder_update_step', { stepId: sheet.id, patch: { inputs: { rows: { kind: 'ref', path: `steps.${loop.id}.output.results` } } } }, dw);
    assert.ok(validateDefinition(dw.def).warnings.some(w => w.code === 'ref.forward'), 'precondition: the spreadsheet reads the loop before it runs');

    const r = await applyToolCall('builder_update_step', { stepId: loop.id, patch: { afterStepId: list.id } }, dw);
    assert.ok(!r.error, r.error);
    assert.ok(Array.isArray(r.moved) && r.moved[0].startsWith(`${list.id}→${loop.id}`), 'the result says where it went');
    assert.deepStrictEqual(edges(dw.def), [`${list.id}→${loop.id}`, `${loop.id}→${sheet.id}`, `${sheet.id}→${notif.id}`, `trg→${list.id}`].sort());
    assert.deepStrictEqual(order(dw.def), [list.id, loop.id, sheet.id, notif.id], 'array order follows the chain so the default tail is still the notification');
    const v = validateDefinition(dw.def);
    assert.ok(!v.warnings.some(w => w.code === 'ref.forward'), 'the forward ref is a plain ref now');
    assert.ok(!v.errors.some(e => e.code === 'ref.unknown_step'), 'the id survived, so nothing dangles');
});

test('run-4 shape: elseStepId on a condition moves an existing step onto the else branch', async () => {
    const dw = wrap();
    const cond = (await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw)).added;
    const failed = (await applyToolCall('builder_add_notification', { title: 'failed' }, dw)).added;       // auto → then
    const ok = (await applyToolCall('builder_add_notification', { title: 'complete' }, dw)).added;         // no afterStepId → after `failed`
    assert.ok(dw.def.edges.some(e => e.from === failed.id && e.to === ok.id), 'precondition: chained after the then-step');

    const r = await applyToolCall('builder_update_step', { stepId: cond.id, patch: { elseStepId: ok.id } }, dw);
    assert.ok(!r.error, r.error);
    assert.deepStrictEqual(edges(dw.def), [`${cond.id}→${failed.id}(then)`, `${cond.id}→${ok.id}(else)`, `trg→${cond.id}`].sort());
    const v = validateDefinition(dw.def);
    assert.ok(!v.warnings.some(w => w.code === 'condition.partial_branch'), 'both branches wired');
    assert.ok(!v.errors.length, JSON.stringify(v.errors));
});

test('the same wiring from the step side: afterStepId + branch', async () => {
    const dw = wrap();
    const cond = (await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw)).added;
    const a = (await applyToolCall('builder_add_notification', { title: 'a' }, dw)).added;
    const b = (await applyToolCall('builder_add_notification', { title: 'b' }, dw)).added;
    const r = await applyToolCall('builder_update_step', { stepId: b.id, patch: { afterStepId: cond.id, branch: 'else' } }, dw);
    assert.ok(!r.error, r.error);
    assert.ok(dw.def.edges.some(e => e.from === cond.id && e.to === b.id && e.label === 'else'));
    assert.ok(!dw.def.edges.some(e => e.from === a.id), 'the then-step lost its accidental successor');
});

test('a move and a field patch in one call both apply', async () => {
    const dw = wrap();
    const a = (await applyToolCall('builder_add_notification', { title: 'a' }, dw)).added;
    const b = (await applyToolCall('builder_add_notification', { title: 'b' }, dw)).added;
    const c = (await applyToolCall('builder_add_notification', { title: 'c' }, dw)).added;
    const r = await applyToolCall('builder_update_step', { stepId: c.id, patch: { afterStepId: a.id, label: 'moved' } }, dw);
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.updated.label, 'moved');
    assert.deepStrictEqual(edges(dw.def), [`${a.id}→${c.id}`, `${c.id}→${b.id}`, `trg→${a.id}`].sort());
});

test('moving a step after the trigger puts it first', async () => {
    const dw = wrap();
    const a = (await applyToolCall('builder_add_notification', { title: 'a' }, dw)).added;
    const b = (await applyToolCall('builder_add_notification', { title: 'b' }, dw)).added;
    const r = await applyToolCall('builder_update_step', { stepId: b.id, patch: { afterStepId: dw.def.trigger.id } }, dw);
    assert.ok(!r.error, r.error);
    assert.deepStrictEqual(edges(dw.def), [`${b.id}→${a.id}`, `trg→${b.id}`].sort());
    assert.deepStrictEqual(order(dw.def), [b.id, a.id]);
});

test('moving a step to where it already is changes nothing', async () => {
    const dw = wrap();
    const a = (await applyToolCall('builder_add_notification', { title: 'a' }, dw)).added;
    const b = (await applyToolCall('builder_add_notification', { title: 'b' }, dw)).added;
    const c = (await applyToolCall('builder_add_notification', { title: 'c' }, dw)).added;
    const before = edges(dw.def);
    const r = await applyToolCall('builder_update_step', { stepId: b.id, patch: { afterStepId: a.id } }, dw);
    assert.ok(!r.error, r.error);
    assert.deepStrictEqual(edges(dw.def), before);
    assert.deepStrictEqual(order(dw.def), [a.id, b.id, c.id]);
});

test('a condition moves WITH its branches, and the anchor\'s old successor stays beside it', async () => {
    const dw = wrap();
    const a = (await applyToolCall('builder_add_notification', { title: 'a' }, dw)).added;
    const b = (await applyToolCall('builder_add_notification', { title: 'b' }, dw)).added;
    const cond = (await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw)).added;
    const t = (await applyToolCall('builder_add_notification', { title: 't', afterStepId: cond.id }, dw)).added;
    const e = (await applyToolCall('builder_add_notification', { title: 'e', afterStepId: cond.id }, dw)).added;
    const r = await applyToolCall('builder_update_step', { stepId: cond.id, patch: { afterStepId: a.id } }, dw);
    assert.ok(!r.error, r.error);
    assert.ok(/beside/.test(r.moved[0]), 'the result explains that b now runs beside the condition');
    assert.deepStrictEqual(edges(dw.def), [`${a.id}→${b.id}`, `${a.id}→${cond.id}`, `${cond.id}→${t.id}(then)`, `${cond.id}→${e.id}(else)`, `trg→${a.id}`].sort());
});

test('a condition cannot be moved onto one of its own branches', async () => {
    const dw = wrap();
    const cond = (await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw)).added;
    const t = (await applyToolCall('builder_add_notification', { title: 't', afterStepId: cond.id }, dw)).added;
    const r = await applyToolCall('builder_update_step', { stepId: cond.id, patch: { afterStepId: t.id } }, dw);
    assert.match(r.error, /cycle/);
});

test('an error handler that is moved stops being a handler', async () => {
    const dw = wrap();
    const a = (await applyToolCall('builder_add_action', { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/' } } }, dw)).added;
    const b = (await applyToolCall('builder_add_notification', { title: 'b' }, dw)).added;
    const h = (await applyToolCall('builder_add_notification', { title: 'handler', afterStepId: a.id, branch: 'error' }, dw)).added;
    assert.ok(dw.def.edges.some(e => e.from === a.id && e.to === h.id && e.label === 'on_error'), 'precondition');
    const r = await applyToolCall('builder_update_step', { stepId: h.id, patch: { afterStepId: b.id } }, dw);
    assert.ok(!r.error, r.error);
    assert.ok(!dw.def.edges.some(e => e.label === 'on_error'), 'the on_error edge is gone, not bridged');
    assert.match(r.moved[0], /on_error/);
    assert.ok(dw.def.edges.some(e => e.from === b.id && e.to === h.id && !e.label));
});

test('refusals name the route: loop-body step, branch without anchor, wire keys on a non-condition, unknown anchor', async () => {
    const dw = wrap();
    const a = (await applyToolCall('builder_add_notification', { title: 'a' }, dw)).added;
    const loop = (await applyToolCall('builder_add_loop', { overRef: 'trigger.output.items', itemVar: 'i', body: [{ id: 'inner', type: 'notification', title: 'x' }] }, dw)).added;
    const r1 = await applyToolCall('builder_update_step', { stepId: 'inner', patch: { afterStepId: a.id } }, dw);
    assert.match(r1.error, /builder_replace_step/);
    const r2 = await applyToolCall('builder_update_step', { stepId: a.id, patch: { branch: 'else' } }, dw);
    assert.match(r2.error, /afterStepId/);
    const r3 = await applyToolCall('builder_update_step', { stepId: a.id, patch: { elseStepId: loop.id } }, dw);
    assert.match(r3.error, /condition/);
    const r4 = await applyToolCall('builder_update_step', { stepId: a.id, patch: { afterStepId: 'nope' } }, dw);
    assert.match(r4.error, /Unknown afterStepId/);
    const r5 = await applyToolCall('builder_update_step', { stepId: a.id, patch: { afterStepId: 'inner' } }, dw);
    assert.match(r5.error, /INSIDE loop/);
    // Nothing above changed the graph.
    assert.deepStrictEqual(edges(dw.def), [`${a.id}→${loop.id}`, `trg→${a.id}`].sort());
});

test('builder_update_steps carries a move too, and rolls everything back when one entry fails', async () => {
    const dw = wrap();
    const a = (await applyToolCall('builder_add_notification', { title: 'a' }, dw)).added;
    const b = (await applyToolCall('builder_add_notification', { title: 'b' }, dw)).added;
    const c = (await applyToolCall('builder_add_notification', { title: 'c' }, dw)).added;
    const ok = await applyToolCall('builder_update_steps', { updates: [{ stepId: c.id, patch: { afterStepId: a.id } }, { stepId: b.id, patch: { label: 'B' } }] }, dw);
    assert.ok(!ok.error, ok.error);
    assert.deepStrictEqual(edges(dw.def), [`${a.id}→${c.id}`, `${c.id}→${b.id}`, `trg→${a.id}`].sort());
    const before = edges(dw.def);
    const bad = await applyToolCall('builder_update_steps', { updates: [{ stepId: b.id, patch: { afterStepId: dw.def.trigger.id } }, { stepId: a.id, patch: { afterStepId: 'nope' } }] }, dw);
    assert.ok(bad.error && bad._rolledBack);
    assert.deepStrictEqual(edges(dw.def), before, 'the first, valid move was rolled back with the failing one');
});
