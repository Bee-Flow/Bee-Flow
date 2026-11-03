/**
 * The AI builder and an approval's rejected branch (D4a):
 *
 *   - `branch:"rejected"` after an approval wires an 'on_rejected' edge, and
 *     every branch enum offers it;
 *   - removing the approval never bridges the rejected target as a plain edge
 *     (it would then run on every approve);
 *   - changing the approval's type drops the rejected edge;
 *   - a binding on the approval is checked against the output contract
 *     (approvalOutput.mts), not against a dry run's stand-in.
 *
 * No DB needed — everything here mutates the in-memory draft only.
 *
 * Run: node --test automation/builderTools.rejectedBranch.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { applyToolCall, emptyDefinition, TOOL_SCHEMAS } = require('./builderTools');
const { validateAndFixBindings } = require('./builderTools/bindings');
const { rememberStepShape } = require('./builderTools/refCheck');

function freshWrap() {
    return { userId: 'u_test', def: emptyDefinition() };
}

async function call(dw, name, args) {
    const res = await applyToolCall(name, args, dw);
    assert.ok(!res.error, `${name} errored: ${res.error}`);
    return res;
}

/** trigger → ap (approval) → yes, and ap → no on its rejected branch. */
async function approvalWithBranches() {
    const dw = freshWrap();
    await call(dw, 'builder_add_approval', { prompt: 'Ship it?' });
    const ap = dw.def.steps.find(s => s.type === 'approval');
    await call(dw, 'builder_add_notification', { afterStepId: ap.id, title: 'Shipped', body: 'yes', label: 'yes' });
    await call(dw, 'builder_add_notification', { afterStepId: ap.id, branch: 'rejected', title: 'Declined', body: 'no', label: 'no' });
    const yes = dw.def.steps.find(s => s.label === 'yes');
    const no = dw.def.steps.find(s => s.label === 'no');
    return { dw, ap, yes, no };
}

test('every branch enum offers "rejected"', () => {
    const withBranch = TOOL_SCHEMAS.filter(t => t.function?.parameters?.properties?.branch?.enum);
    assert.ok(withBranch.length > 0);
    for (const t of withBranch) {
        assert.ok(t.function.parameters.properties.branch.enum.includes('rejected'), `${t.function.name} lacks "rejected"`);
    }
});

test('branch:"rejected" after an approval wires an on_rejected edge; the plain edge stays plain', async () => {
    const { dw, ap, yes, no } = await approvalWithBranches();
    const out = dw.def.edges.filter(e => e.from === ap.id);
    assert.deepStrictEqual(out.find(e => e.to === no.id), { from: ap.id, to: no.id, label: 'on_rejected' });
    assert.strictEqual(out.find(e => e.to === yes.id)?.label, undefined);
});

test('removing the approval does not bridge its rejected target', async () => {
    const { dw, ap, yes, no } = await approvalWithBranches();
    await call(dw, 'builder_remove_step', { stepId: ap.id });
    const fromTrigger = dw.def.edges.filter(e => e.from === dw.def.trigger.id).map(e => e.to);
    assert.ok(fromTrigger.includes(yes.id), 'the approve path is bridged');
    assert.ok(!fromTrigger.includes(no.id), 'the rejected branch must not become a plain edge');
});

test('moving the approval takes its rejected branch along', async () => {
    const { dw, ap, no } = await approvalWithBranches();
    await call(dw, 'builder_add_notification', { afterStepId: dw.def.trigger.id, title: 'First', body: 'x', label: 'first' });
    const first = dw.def.steps.find(s => s.label === 'first');
    await call(dw, 'builder_update_step', { stepId: ap.id, patch: { afterStepId: first.id } });
    assert.ok(dw.def.edges.some(e => e.from === ap.id && e.to === no.id && e.label === 'on_rejected'));
    assert.ok(!dw.def.edges.some(e => e.to === no.id && e.from !== ap.id), 'no plain edge into the rejected branch');
});

test('replacing the approval with another type drops the rejected edge', async () => {
    const { dw, ap, no } = await approvalWithBranches();
    await call(dw, 'builder_replace_step', { stepId: ap.id, newType: 'notification', spec: { title: 'x', body: 'y' } });
    assert.ok(!dw.def.edges.some(e => e.from === ap.id && e.to === no.id), 'the on_rejected edge went with the type');
});

test('bindings on an approval are checked against the output contract', async () => {
    const { dw, ap } = await approvalWithBranches();
    // A dry run's stand-in with a key no decision ever carries.
    rememberStepShape(dw, ap, { approved: true, by: 'dry_run', prompt: 'Ship it?', _dryRun: true });
    const check = (path) => validateAndFixBindings({ v: { kind: 'ref', path } }, dw.def, { draftWrap: dw });
    for (const key of ['approved', 'by', 'reason', 'decidedAt', 'answers', 'votes']) {
        assert.strictEqual(check(`steps.${ap.id}.output.${key}`).error, null, key);
    }
    assert.ok(check(`steps.${ap.id}.output.prompt`).error, 'a key outside the contract is refused');
});
