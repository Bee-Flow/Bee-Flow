/**
 * The repeat ladder — the same rejected call, sent again.
 *
 * A rejected mutator leaves the draft as it was, so identical arguments meet
 * an identical draft and an identical error, and nothing in that error used
 * to say so. Measured 2026-09-12/13 with the fast local model: one refused
 * builder_add_steps resent byte-identical three rounds running, a refused
 * builder_update_steps fifteen times — "stop retrying" in the hint was not
 * obeyed either. So (builderTools.js rejectionLadder / applyToolCall):
 *   rung 1  the error, plus the patch it carries when the server knows the
 *           one exact edit (_suggestedPatch, described in the hint);
 *   rung 2  the identical resend: the patch is APPLIED before dispatch and
 *           the call lands (_autoRepaired); without a patch the result says
 *           it is a repeat and hands over the one call to send (resendAs);
 *   rung 3  _stop — the route ends the turn and tells the user.
 * "Identical" is key-order independent, and for a batch also means "still
 * contains the entry that failed".
 *
 * Which refusals carry a patch is stepBuilders' / bindings' business and is
 * pinned here as it IS: a required input the previous step's top-level
 * output can answer for (set inputs.<key>), a loop var that does not match
 * forEach.itemVar (set forEach.itemVar). A required input inside a forEach
 * over an UNKNOWN item shape carries none — "a guess against an unknown
 * shape is not a patch" (builderTools.addSteps.test.js) — so that is the
 * no-patch rung here.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/repeatLadder.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { applyToolCall, emptyDefinition, rejectionSignature, isRepeat } = require('../builderTools');
const { canonicalJson } = require('./suggestedPatch');

const STR = { type: 'string' };
const SCHEMAS = {
    gmail_search: { type: 'object', properties: { query: { ...STR, description: 'search query' }, maxResults: { type: 'number' } }, required: ['query'] },
    gmail_read: { type: 'object', properties: { messageId: STR }, required: ['messageId'] },
};

// A wrap on which gmail_search's output is KNOWN to carry a top-level `query`
// (what the search ran on): the dry-run taught it, so it sits in the
// runtime shapes — the curated shape has results/total/message only. That is
// what makes "bind query from the previous search" one exact edit.
function wrap() {
    return {
        userId: 'u_test',
        def: emptyDefinition(),
        _inputSchemasByTool: SCHEMAS,
        _inspectedTools: new Set(Object.keys(SCHEMAS)),
        _resultDetail: 'full',
        _runtimeShapes: {
            gmail_search: { query: 'string', total: 'integer', results: { _array: { id: 'string', subject: 'string' }, _length: 2 } },
        },
    };
}

const lit = (value) => ({ kind: 'literal', value });
const ref = (path) => ({ kind: 'ref', path });

async function seedSearch(dw) {
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const a = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: { query: lit('is:unread') }, label: 'First search' }, dw);
    assert.ok(!a.error, a.error);
    return a.added.id;
}

test('rung 1: a required input the previous step can answer for carries a set op on inputs.<key>, lifted into the batch entry', async () => {
    const dw = wrap();
    const firstId = await seedSearch(dw);
    const entry = { tempId: 's2', type: 'integration_action', spec: { tool: 'gmail_search', label: 'Second search' } };
    const r = await applyToolCall('builder_add_steps', { steps: [entry] }, dw);
    assert.ok(r.error && r.failedIndex === 0, r.error);
    assert.match(r.error, new RegExp(`^steps\\[0\\] \\(\\$s2\\): gmail_search: required input "query" is not bound\\. The previous step ${firstId} \\(gmail_search\\) outputs a top-level "query", bind it only if that is the value you mean: query:\\{kind:"ref", path:"steps\\.${firstId}\\.output\\.query"\\}\\.$`));
    // stepBuilders speaks relative to its own args (`inputs.query`);
    // addSteps lifts that under the entry and signs the entry, so the op
    // still finds it when the batch comes back reshaped.
    assert.deepStrictEqual(r._suggestedPatch, {
        ops: [{
            op: 'set',
            path: 'steps[0].spec.inputs.query',
            value: { kind: 'ref', path: `steps.${firstId}.output.query` },
            entrySig: '{"spec":{"label":"Second search","tool":"gmail_search"},"tempId":"s2","type":"integration_action"}',
        }],
    });
    assert.match(r._fixHint, /^Reject reason: a required input is missing\. /);
    assert.match(r._fixHint, /A ready-made patch is attached as _suggestedPatch: set steps\[0\]\.spec\.inputs\.query\.$/);
    assert.strictEqual(r._repeated, undefined, 'the first rejection is not a repeat');
    assert.strictEqual(dw._lastRejected.count, 1);
    assert.deepStrictEqual(dw._lastRejected.patch, r._suggestedPatch, 'the patch is remembered for the resend');
    assert.strictEqual(dw.def.steps.length, 1, 'nothing added');
});

test('rung 1: a loop var that does not match forEach.itemVar carries a set op on forEach.itemVar', async () => {
    const dw = wrap();
    const firstId = await seedSearch(dw);
    const entry = { tempId: 'rd', type: 'integration_action', spec: { tool: 'gmail_read', forEach: { overRef: `steps.${firstId}.output.results`, itemVar: 'm' }, inputs: { messageId: ref('loop.x.id') } } };
    const r = await applyToolCall('builder_add_steps', { steps: [entry] }, dw);
    assert.ok(r.error && r.failedIndex === 0, r.error);
    assert.match(r.error, /inputs read "loop\.x\.id", but this step iterates as loop\.m \(forEach\.itemVar\) — loop\.x is not bound here\. Use loop\.m… for the current item, or set itemVar:"x"\.$/);
    assert.strictEqual(r._suggestedPatch.ops.length, 1);
    assert.deepStrictEqual({ ...r._suggestedPatch.ops[0], entrySig: undefined }, { op: 'set', path: 'steps[0].spec.forEach.itemVar', value: 'x', entrySig: undefined });
    assert.match(r._fixHint, /^Reject reason: the loop var in a binding does not match/);
    assert.match(r._fixHint, /set steps\[0\]\.spec\.forEach\.itemVar\.$/);
    // The same refusal on the single-step tool: the path is the builder's
    // own, no entry to lift into.
    const single = await applyToolCall('builder_add_action', { tool: 'gmail_read', forEach: { overRef: `steps.${firstId}.output.results`, itemVar: 'm' }, inputs: { messageId: ref('loop.x.id') } }, dw);
    assert.deepStrictEqual(single._suggestedPatch, { ops: [{ op: 'set', path: 'forEach.itemVar', value: 'x' }] });
});

test('rung 2 with a patch: the identical resend is dispatched patched, lands, names the repair, and clears the memory', async () => {
    const dw = wrap();
    const firstId = await seedSearch(dw);
    const call = { steps: [{ tempId: 's2', type: 'integration_action', spec: { tool: 'gmail_search', label: 'Second search' } }] };
    const r1 = await applyToolCall('builder_add_steps', structuredClone(call), dw);
    assert.ok(r1.error && r1._suggestedPatch, 'first: refused with a patch');
    const r2 = await applyToolCall('builder_add_steps', structuredClone(call), dw);
    assert.ok(!r2.error, `the patched resend lands: ${r2.error}`);
    assert.strictEqual(r2.added.length, 1);
    assert.strictEqual(r2._repeated, undefined, 'a landed call is not a repeat');
    assert.deepStrictEqual(r2._autoRepaired, [`steps[0].spec.inputs.query = {"kind":"ref","path":"steps.${firstId}.output.query"}`], '_autoRepaired names the path that was set');
    assert.match(r2._note, /^Your resend was identical, so the fix the error named was applied: steps\[0\]\.spec\.inputs\.query = /);
    assert.match(r2._note, /It is built now — do NOT resend it; continue with the next step\.$/);
    const built = dw.def.steps.find(s => s.id === r2.added[0].id);
    assert.deepStrictEqual(built.inputs, { query: { kind: 'ref', path: `steps.${firstId}.output.query` } }, 'the step carries the binding the patch wrote');
    assert.strictEqual(dw.def.steps.length, 2);
    assert.strictEqual(dw._lastRejected, null, 'a successful mutation clears the ladder');
    // The same again is now a duplicate of a step minted this turn — a
    // no-op, not a third rung.
    const r3 = await applyToolCall('builder_add_steps', structuredClone(call), dw);
    assert.ok(!r3.error, r3.error);
    assert.strictEqual(r3.added[0].reused, true);
    assert.strictEqual(dw.def.steps.length, 2);
});

test('rung 2 with a patch, itemVar form: the resend is repaired on the forEach, not on the binding', async () => {
    const dw = wrap();
    const firstId = await seedSearch(dw);
    const call = { steps: [{ tempId: 'rd', type: 'integration_action', spec: { tool: 'gmail_read', forEach: { overRef: `steps.${firstId}.output.results`, itemVar: 'm' }, inputs: { messageId: ref('loop.x.id') } } }] };
    const r1 = await applyToolCall('builder_add_steps', structuredClone(call), dw);
    assert.ok(r1.error && r1._suggestedPatch, r1.error);
    const r2 = await applyToolCall('builder_add_steps', structuredClone(call), dw);
    assert.ok(!r2.error, `patched resend lands: ${r2.error}`);
    assert.deepStrictEqual(r2._autoRepaired, ['steps[0].spec.forEach.itemVar = "x"']);
    const built = dw.def.steps.find(s => s.id === r2.added[0].id);
    assert.strictEqual(built.forEach.itemVar, 'x');
    assert.deepStrictEqual(built.inputs.messageId, { kind: 'ref', path: 'loop.x.id' }, 'the binding the model wrote is kept');
    assert.strictEqual(dw._lastRejected, null);
});

test('rung 2 without a patch: _repeated 2 and the one call to send; rung 3: _stop with the label', async () => {
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const dt = await applyToolCall('builder_add_datetime', { op: 'now' }, dw);
    // A forEach over a datetime step's results: the item shape is unknown,
    // so the refusal names the binding to write and carries NO patch.
    const call = { steps: [{ tempId: 'u', type: 'integration_action', spec: { tool: 'gmail_search', label: 'Search per item', forEach: { overRef: `steps.${dt.added.id}.output.results`, itemVar: 'f' } } }] };
    const r1 = await applyToolCall('builder_add_steps', structuredClone(call), dw);
    assert.ok(r1.error && r1.failedIndex === 0, r1.error);
    assert.strictEqual(r1.error, `steps[0] ($u): gmail_search: required input "query" is not bound — the step would fail at run time. Inside this forEach bind it from the item, e.g. query: {kind:"ref", path:"loop.f.query"}.`);
    assert.strictEqual(r1._suggestedPatch, undefined, 'a guess against an unknown shape is not a patch');
    assert.strictEqual(r1._fixHint, 'Reject reason: a required input is missing. Add that binding and resend the same step — the other bindings were fine.');
    assert.strictEqual(r1._repeated, undefined);

    const r2 = await applyToolCall('builder_add_steps', structuredClone(call), dw);
    assert.ok(r2.error, 'still refused — nothing was applied to it');
    assert.strictEqual(r2._repeated, 2);
    assert.strictEqual(r2._autoRepaired, undefined);
    assert.match(r2._fixHint, /^Reject reason: a required input is missing\. .* This is the SAME call as your previous attempt \(2 times now\), rejected for the same reason — re-sending identical arguments cannot succeed\. Change exactly what the error names, then send exactly this ONE call next and nothing else: builder_add_steps\(\{"steps":\[\{"tempId":"u","type":"integration_action","spec":\{"tool":"gmail_search","label":"Search per item","forEach":\{"overRef":"steps\.dt_[0-9a-f]+\.output\.results","itemVar":"f"\}\}\}\]\}\)$/);
    assert.ok(!/attached patch was applied/.test(r2._fixHint), 'no patch, so no claim that one was applied');
    assert.strictEqual(r2._stop, undefined);
    assert.strictEqual(dw._lastRejected.count, 2);

    const r3 = await applyToolCall('builder_add_steps', structuredClone(call), dw);
    assert.strictEqual(r3._repeated, 3);
    assert.deepStrictEqual(r3._stop, {
        reason: 'repeated_rejection',
        tool: 'builder_add_steps',
        error: r3.error.slice(0, 300),
        entryIndex: 0,
        label: 'Search per item',
    });
    assert.match(r3._fixHint, /This is the SAME call as your previous attempt \(3 times now\)\. Stopped: the same step was rejected 3 times\.$/);
    assert.strictEqual(dw.def.steps.length, 1, 'the datetime step only — nothing was ever added');
});

test('the label of the failing step: label, else tool, else type — for a batch entry and for a single-step call', async () => {
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const dt = await applyToolCall('builder_add_datetime', { op: 'now' }, dw);
    const fe = { overRef: `steps.${dt.added.id}.output.results`, itemVar: 'f' };
    const stopOf = async (name, args) => {
        let r;
        for (let i = 0; i < 3; i++) r = await applyToolCall(name, structuredClone(args), dw);
        assert.ok(r._stop, `stopped: ${r.error}`);
        return r._stop;
    };
    // No label → the tool.
    assert.strictEqual((await stopOf('builder_add_steps', { steps: [{ type: 'integration_action', spec: { tool: 'gmail_search', forEach: fe } }] })).label, 'gmail_search');
    // Single-step tool, no label → the tool; entryIndex is null outside a batch.
    const single = await stopOf('builder_add_action', { tool: 'gmail_search', forEach: fe });
    assert.strictEqual(single.label, 'gmail_search');
    assert.strictEqual(single.entryIndex, null);
    assert.strictEqual(single.tool, 'builder_add_action');
    // No label, no tool → the type.
    assert.strictEqual((await stopOf('builder_add_steps', { steps: [{ tempId: 'x', type: 'data_extraction', spec: { fields: [{ name: 'a', type: 'string' }] } }] })).label, 'data_extraction');
});

test('an obeying resend that still contains the failing entry is the same attempt', async () => {
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const dt = await applyToolCall('builder_add_datetime', { op: 'now' }, dw);
    // Entry 0 lands, entry 1 is refused (unknown item shape, no patch).
    const batch = {
        steps: [
            { tempId: 'a', type: 'set', spec: { fields: { when: ref(`steps.${dt.added.id}.output.iso`) } } },
            { tempId: 'u', type: 'integration_action', spec: { tool: 'gmail_search', forEach: { overRef: `steps.${dt.added.id}.output.results`, itemVar: 'f' } } },
            { tempId: 'n', type: 'notification', spec: { title: 'after', body: 'x' } },
        ],
    };
    const r1 = await applyToolCall('builder_add_steps', structuredClone(batch), dw);
    assert.ok(r1.error && r1.failedIndex === 1 && r1.added.length === 1, r1.error);
    assert.strictEqual(dw.def.steps.length, 2, 'datetime + entry 0');
    // The model obeys the protocol — entries 1.. only, anchored as told —
    // but resends the failing entry UNCHANGED. That is rung 2.
    const obeying = { steps: [
        { ...structuredClone(batch.steps[1]), spec: { ...structuredClone(batch.steps[1].spec), afterStepId: r1.lastAppliedId } },
        structuredClone(batch.steps[2]),
    ] };
    assert.deepStrictEqual(obeying.steps[0], r1.resendAs.args.steps[0], 'the resendAs entry verbatim');
    const r2 = await applyToolCall('builder_add_steps', obeying, dw);
    assert.ok(r2.error && r2.failedIndex === 0, r2.error);
    assert.strictEqual(r2._repeated, 2, 'obeying the resend contract with the same entry is a repeat');
    assert.strictEqual(dw.def.steps.length, 2, 'nothing more was built');
    // The same obeying resend once more: the third rung, with the entry
    // index of THIS call (0), not of the batch it started in (1).
    const r3 = await applyToolCall('builder_add_steps', structuredClone(obeying), dw);
    assert.strictEqual(r3._repeated, 3);
    assert.strictEqual(r3._stop.reason, 'repeated_rejection');
    assert.strictEqual(r3._stop.entryIndex, 0, 'the entry index of THIS call');
    // Pinned as it is: the memory holds the LATEST rejection's signatures
    // only, so the raw entry without its anchor — the shape of r1, which r2
    // replaced — is a fresh attempt now. (A model alternating the two shapes
    // would climb no higher than rung 2; not seen in a trace so far.)
    const rawAgain = await applyToolCall('builder_add_steps', { steps: [structuredClone(batch.steps[1])] }, dw);
    assert.ok(rawAgain.error && !rawAgain._repeated, 'the r1 shape is not remembered past r2');
    // A resend whose failing entry was actually changed is a fresh attempt
    // — and lands.
    const fixed = { steps: [
        { tempId: 'u', type: 'integration_action', spec: { tool: 'gmail_search', forEach: { overRef: `steps.${dt.added.id}.output.results`, itemVar: 'f' }, inputs: { query: ref('loop.f.query') }, afterStepId: r1.lastAppliedId } },
        structuredClone(batch.steps[2]),
    ] };
    const r4 = await applyToolCall('builder_add_steps', fixed, dw);
    assert.ok(!r4.error, `the changed entry lands: ${r4.error}`);
    assert.strictEqual(r4._repeated, undefined);
    assert.strictEqual(dw.def.steps.length, 4, 'datetime, entry 0, and the two resent entries');
    assert.strictEqual(dw._lastRejected, null);
});

test('the resend that OBEYS resendAs is repaired too: the lifted patch is signed on the raw entry AND the resendAs shape', async () => {
    // Measured with a two-entry batch: signed on the raw entry only, the
    // model that did exactly what rung 1 said (send resendAs) was told it
    // resent identical arguments that cannot succeed, and the repair the
    // server already had landed on the THIRD round.
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const batch = { steps: [
        { tempId: 'list', type: 'integration_action', spec: { tool: 'gmail_search', inputs: { query: lit('is:unread') } } },
        { tempId: 'rd', type: 'integration_action', spec: { tool: 'gmail_read', forEach: { overRef: 'steps.$list.output.results', itemVar: 'f' }, inputs: { messageId: ref('loop.item.id') } } },
    ] };
    const r1 = await applyToolCall('builder_add_steps', structuredClone(batch), dw);
    assert.ok(r1.error && r1.failedIndex === 1 && r1.added.length === 1, r1.error);
    assert.ok(r1._suggestedPatch, 'refused with a patch');
    const op = r1._suggestedPatch.ops[0];
    assert.strictEqual(op.path, 'steps[1].spec.forEach.itemVar');
    assert.ok(Array.isArray(op.entrySig) && op.entrySig.length === 2, 'signed on both shapes');
    assert.strictEqual(op.entrySig[0], canonicalJson(batch.steps[1]), 'the raw entry');
    assert.strictEqual(op.entrySig[1], canonicalJson(r1.resendAs.args.steps[0]), 'the resendAs entry');
    // The obeying resend, verbatim.
    const r2 = await applyToolCall(r1.resendAs.tool, structuredClone(r1.resendAs.args), dw);
    assert.ok(!r2.error, `the obeying resend lands: ${r2.error}`);
    assert.deepStrictEqual(r2._autoRepaired, ['steps[0].spec.forEach.itemVar = "item" (found by entry signature — it is no longer at steps[1])']);
    assert.strictEqual(r2._repeated, undefined);
    assert.strictEqual(dw._lastRejected, null);
    assert.strictEqual(dw.def.steps.length, 2);
    assert.strictEqual(dw.def.steps[1].forEach.itemVar, 'item');
    assert.strictEqual(dw.def.steps[1].forEach.overRef, `steps.${r1.added[0].id}.output.results`);

    // The whole-batch resend still lands at r2 as well, with entry 0 reused.
    const dw2 = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw2);
    const a1 = await applyToolCall('builder_add_steps', structuredClone(batch), dw2);
    assert.ok(a1.error && a1.failedIndex === 1, a1.error);
    const a2 = await applyToolCall('builder_add_steps', structuredClone(batch), dw2);
    assert.ok(!a2.error, `the whole-batch resend lands: ${a2.error}`);
    assert.strictEqual(a2.added[0].reused, true);
    assert.deepStrictEqual(a2._autoRepaired, ['steps[1].spec.forEach.itemVar = "item"']);
    assert.strictEqual(dw2.def.steps.length, 2);
});

test('a patched prefix that lands does not make a LATER entry\'s first refusal a repeat — and the repair is reported on the partial result', async () => {
    // Measured: entry A auto-repaired and built, entry B refused for the
    // first time but reported as attempt 2 of the same failure; the next
    // resend of B stopped the turn after B's SECOND refusal, and the itemVar
    // change on A was never mentioned.
    const dw = wrap();
    const firstId = await seedSearch(dw);
    const batch = { steps: [
        { tempId: 'rd', type: 'integration_action', spec: { tool: 'gmail_read', forEach: { overRef: `steps.${firstId}.output.results`, itemVar: 'm' }, inputs: { messageId: ref('loop.x.id') } } },
        { tempId: 's2', type: 'integration_action', spec: { tool: 'gmail_search', inputs: { query: ref('nowhere.query') } } },
    ] };
    const r1 = await applyToolCall('builder_add_steps', structuredClone(batch), dw);
    assert.ok(r1.error && r1.failedIndex === 0 && r1._suggestedPatch, r1.error);
    const r2 = await applyToolCall('builder_add_steps', structuredClone(batch), dw);
    assert.ok(r2.error, 'entry 1 is refused');
    assert.strictEqual(r2.failedIndex, 1);
    assert.strictEqual(r2.added.length, 1, 'the repaired entry 0 landed');
    assert.strictEqual(dw.def.steps.find(s => s.id === r2.added[0].id).forEach.itemVar, 'x');
    assert.strictEqual(r2._repeated, undefined, 'a first refusal of entry 1 is not a repeat');
    assert.deepStrictEqual(r2._autoRepaired, ['steps[0].spec.forEach.itemVar = "x"']);
    assert.ok(r2._warnings.some(w => w === 'Your resend was identical, so the fix the earlier error named was applied before dispatch: steps[0].spec.forEach.itemVar = "x".'), JSON.stringify(r2._warnings));
    assert.ok(!/SAME call|attached patch was applied/.test(r2._fixHint), r2._fixHint);
    assert.strictEqual(dw._lastRejected.count, 1);
    // resendAs of entry 1, verbatim: now a repeat — rung 2, not the stop.
    const r3 = await applyToolCall(r2.resendAs.tool, structuredClone(r2.resendAs.args), dw);
    assert.ok(r3.error, r3.error);
    assert.strictEqual(r3._repeated, 2);
    assert.strictEqual(r3._stop, undefined);
    const r4 = await applyToolCall(r2.resendAs.tool, structuredClone(r2.resendAs.args), dw);
    assert.strictEqual(r4._repeated, 3);
    assert.strictEqual(r4._stop.reason, 'repeated_rejection');
    assert.strictEqual(dw.def.steps.length, 2, 'the seed search and the repaired read only');
});

test('rejectionSignature is key-order independent, at every depth', async () => {
    const a = { steps: [{ tempId: 'x', type: 'set', spec: { fields: { p: { kind: 'ref', path: 'nowhere.p' }, q: lit(1) }, label: 'L' } }] };
    const b = { steps: [{ spec: { label: 'L', fields: { q: lit(1), p: { path: 'nowhere.p', kind: 'ref' } } }, type: 'set', tempId: 'x' }] };
    const sa = rejectionSignature('builder_add_steps', a, { failedIndex: 0 });
    const sb = rejectionSignature('builder_add_steps', b, { failedIndex: 0 });
    assert.strictEqual(sa.sig, sb.sig, 'the call signature');
    assert.strictEqual(sa.entrySig, sb.entrySig, 'the failing entry signature');
    assert.notStrictEqual(sa.sig, rejectionSignature('builder_add_steps', { steps: [{ ...a.steps[0], tempId: 'y' }] }, null).sig, 'a different call is a different signature');
    assert.ok(isRepeat({ ...sa, count: 1 }, 'builder_add_steps', b));
    assert.ok(!isRepeat({ ...sa, count: 1 }, 'builder_add_set', a.steps[0].spec), 'a different tool is never a repeat of it');
    // Through the loop: the reordered resend climbs the ladder.
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const r1 = await applyToolCall('builder_add_steps', structuredClone(a), dw);
    assert.ok(r1.error && !r1._repeated, r1.error);
    const r2 = await applyToolCall('builder_add_steps', structuredClone(b), dw);
    assert.strictEqual(r2._repeated, 2, 'keys in another order are the same call');
});
