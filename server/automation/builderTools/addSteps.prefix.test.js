/**
 * builder_add_steps — the built prefix stays, and a resend never builds an
 * entry twice.
 *
 * Measured 2026-09-12/13 with the fast local model: a batch of four whose
 * entry 1 was refused came back byte-identical three rounds running. Under
 * the old all-or-nothing rollback that resend was the only move that could
 * succeed once the entry was fixed — and it built entry 0 twice when the
 * model fixed entry 1 but kept entry 0 in the call. These tests pin the
 * partial-result contract (addSteps.js `fail`) and the per-turn memory
 * (`_tempIds` / `_builtThisTurn` / `_mintedThisTurn` on draftWrap) that
 * make the resend harmless, through the facade (applyToolCall) so the
 * echo the model reads (_draftSteps / _wiring) is part of the contract.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/addSteps.prefix.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
// M5: a notification body is stored as a compose; it reads as the template it was written as.
const { textAsTemplate } = require('../../shared/mapping/index.mjs');
const { applyToolCall, emptyDefinition } = require('../builderTools');

const STR = { type: 'string' };
const SCHEMAS = {
    gmail_search: { type: 'object', properties: { query: { ...STR, description: 'search query' }, maxResults: { type: 'number' } }, required: ['query'] },
    gmail_read: { type: 'object', properties: { messageId: STR }, required: ['messageId'] },
};

// The route's per-turn wrap, as builderTools.addSteps.test.js builds it:
// the schema map (so the inspect gate and the required-input check are
// live), the tools already inspected, and the lean profile's full echo.
function wrap({ inspected = Object.keys(SCHEMAS) } = {}) {
    return {
        userId: 'u_test',
        def: emptyDefinition(),
        _inputSchemasByTool: SCHEMAS,
        _inspectedTools: new Set(inspected),
        _resultDetail: 'full',
    };
}

const lit = (value) => ({ kind: 'literal', value });
const ref = (path) => ({ kind: 'ref', path });
const edgePairs = (def) => def.edges.map(e => [e.from, e.to]);

// The four-entry batch of the measured loop, in shape: a list step, a search
// whose binding names a root that does not exist, a per-item read over the
// search, and a notification that reads the list AND the read.
function fourEntries({ searchQuery = ref('nowhere.query') } = {}) {
    return [
        { tempId: 'list', type: 'datetime', spec: { op: 'now', label: 'When' } },
        { tempId: 'search', type: 'integration_action', spec: { tool: 'gmail_search', inputs: { query: searchQuery }, label: 'Find mail' } },
        { tempId: 'read', type: 'integration_action', spec: { tool: 'gmail_read', forEach: { overRef: 'steps.$search.output.results', itemVar: 'm' }, inputs: { messageId: ref('loop.m.id') }, label: 'Read each' } },
        { tempId: 'note', type: 'notification', spec: { title: 'Done', body: 'At {{steps.$list.output.iso}}: {{steps.$read.output.results}}', label: 'Tell me' } },
    ];
}

test('the built prefix stays and the partial result says how to continue; a byte-identical resend is harmless; the obeying resend finishes the batch', async () => {
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);

    // (1) Entry 1 is refused: entry 0 is built and stays built.
    const r = await applyToolCall('builder_add_steps', { steps: fourEntries() }, dw);
    assert.ok(r.error, 'the batch is refused at entry 1');
    assert.match(r.error, /^steps\[1\] \(\$search\): /, 'the error names the entry');
    assert.match(r.error, /has unknown root "nowhere"/, 'and the binding root that does not exist');
    assert.strictEqual(r.failedIndex, 1);
    assert.strictEqual(r.resendFrom, 1);
    assert.strictEqual(r.added.length, 1, 'entry 0 is in `added`');
    assert.strictEqual(r.added[0].tempId, 'list');
    assert.strictEqual(r.lastAppliedId, r.added[0].id, 'lastAppliedId is the last entry that landed');
    assert.deepStrictEqual(r.idMap, { list: r.added[0].id }, 'idMap carries the built handle');
    // The one call that continues the batch: the failing entry, anchored
    // after the last built one.
    assert.strictEqual(r.resendAs.tool, 'builder_add_steps');
    assert.strictEqual(r.resendAs.args.steps.length, 1);
    assert.strictEqual(r.resendAs.args.steps[0].tempId, 'search');
    assert.strictEqual(r.resendAs.args.steps[0].spec.afterStepId, r.lastAppliedId, 'resendAs anchors after lastAppliedId');
    // The hint leads with the entry's own reason and follows with the contract.
    assert.match(r._fixHint, /^Reject reason: /);
    assert.match(r._fixHint, /Entries 0\.\.0 are built \(ids dt_[0-9a-f]+\) and stay built\. Fix entry 1 and resend ONLY entries 1\.\./);
    // The draft: one step, wired from the trigger.
    assert.deepStrictEqual(dw.def.steps.map(s => s.id), [r.added[0].id]);
    assert.deepStrictEqual(edgePairs(dw.def), [['trg', r.added[0].id]]);
    // The echo rides on the partial result — the model resends from index 1
    // against a graph it has been shown.
    assert.ok(Array.isArray(r._draftSteps) && r._draftSteps.some(s => s.id === r.added[0].id), 'partial result carries _draftSteps');
    assert.strictEqual(typeof r._wiring, 'string', 'partial result carries _wiring');
    assert.ok(r._wiring.includes(r.added[0].id), '_wiring names the built step');
    assert.strictEqual(r._rolledBack, undefined, 'no batch-wide rollback any more');
    // Per-turn memory on the wrap.
    assert.strictEqual(dw._tempIds.list, r.added[0].id);
    assert.ok(dw._mintedThisTurn.has(r.added[0].id));

    // (2) The byte-identical resend: entry 0 is reported back, not built
    //     again; entry 1 fails again, and the ladder says it is a repeat.
    const listId = r.added[0].id;
    const again = await applyToolCall('builder_add_steps', { steps: fourEntries() }, dw);
    assert.ok(again.error, 'still refused at entry 1');
    assert.strictEqual(again.failedIndex, 1);
    assert.strictEqual(again.added.length, 1);
    assert.strictEqual(again.added[0].reused, true, 'entry 0 comes back reused');
    assert.strictEqual(again.added[0].id, listId, 'with the same id');
    assert.strictEqual(dw.def.steps.length, 1, 'still one step in the draft');
    assert.deepStrictEqual(edgePairs(dw.def), [['trg', listId]], 'and no second edge');
    assert.strictEqual(again._repeated, 2, 'the ladder counts the identical resend');
    assert.match(again._fixHint, /SAME call as your previous attempt \(2 times now\)/);
    assert.ok(again._warnings.some(w => /^steps\[0\] \(\$list\): already built in this turn as dt_[0-9a-f]+ — not added twice\.$/.test(w)), JSON.stringify(again._warnings));

    // (3) The obeying resend: entries 1.. only, anchored as told, with the
    //     later entries still reaching entry 0 through its handle.
    const rest = fourEntries({ searchQuery: lit('is:unread') }).slice(1);
    rest[0].spec.afterStepId = again.lastAppliedId;
    const done = await applyToolCall('builder_add_steps', { steps: rest }, dw);
    assert.ok(!done.error, `the obeying resend lands: ${done.error}`);
    assert.strictEqual(done.added.length, 3);
    assert.ok(done.added.every(a => !a.reused), 'all three are new');
    assert.deepStrictEqual(Object.keys(done.idMap).sort(), ['list', 'note', 'read', 'search'], 'idMap = this call + what the turn built before');
    assert.strictEqual(done.idMap.list, listId, 'the earlier handle still resolves');
    const { search, read, note } = done.idMap;
    assert.deepStrictEqual(dw.def.steps.map(s => s.id), [listId, search, read, note], 'four steps, in order');
    assert.deepStrictEqual(edgePairs(dw.def), [['trg', listId], [listId, search], [search, read], [read, note]], 'one chain, in order');
    const byId = Object.fromEntries(dw.def.steps.map(s => [s.id, s]));
    assert.strictEqual(byId[read].forEach.overRef, `steps.${search}.output.results`, 'overRef rewritten to the id minted in THIS call');
    assert.strictEqual(textAsTemplate(byId[note].body), `At {{steps.${listId}.output.iso}}: {{steps.${read}.output.results}}`, 'a handle from the EARLIER call is rewritten through _tempIds');
    assert.strictEqual(dw._lastRejected, null, 'a successful mutation clears the ladder');
});

test('a resend of a built entry with a changed label is a no-op — the label is not part of the step', async () => {
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const first = await applyToolCall('builder_add_steps', { steps: [{ tempId: 'a', type: 'datetime', spec: { op: 'now', label: 'Now' } }] }, dw);
    assert.ok(!first.error, first.error);
    const relabelled = await applyToolCall('builder_add_steps', { steps: [{ tempId: 'a', type: 'datetime', spec: { op: 'now', label: 'Current time' } }] }, dw);
    assert.ok(!relabelled.error, relabelled.error);
    assert.strictEqual(relabelled.added[0].reused, true);
    assert.strictEqual(relabelled.added[0].id, first.added[0].id);
    assert.strictEqual(dw.def.steps.length, 1, 'not built twice');
    assert.strictEqual(dw.def.steps[0].label, 'Now', 'the built step keeps its label — a no-op changes nothing');
    assert.ok(relabelled._warnings.some(w => /already built in this turn/.test(w)));
});

test('the same tempId with a DIFFERENT spec, sent while a resend is in flight (after a rejection), is skipped with the builder_update_step note; the entries after it apply', async () => {
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const first = await applyToolCall('builder_add_steps', { steps: [{ tempId: 'a', type: 'datetime', spec: { op: 'now' } }] }, dw);
    assert.ok(!first.error, first.error);
    const aId = first.added[0].id;
    // A refused call: the next batch is a resend, and a drifted handle in it
    // is the built step, not a new one.
    const bad = await applyToolCall('builder_add_steps', { steps: [{ tempId: 'x', type: 'data_extraction', spec: { fields: [{ name: 'a', type: 'string' }] } }] }, dw);
    assert.ok(bad.error && dw._lastRejected, 'a rejection is remembered');
    const r = await applyToolCall('builder_add_steps', {
        steps: [
            { tempId: 'a', type: 'wait', spec: { seconds: 5 } },
            { tempId: 'b', type: 'set', spec: { fields: { when: ref('steps.$a.output.iso') } } },
        ],
    }, dw);
    assert.ok(!r.error, `skipped, never refused: ${r.error}`);
    assert.strictEqual(r.added.length, 2);
    assert.deepStrictEqual({ ...r.added[0] }, { tempId: 'a', id: aId, type: 'datetime', reused: true, differs: true }, 'the built one is reported, flagged as differing');
    assert.strictEqual(r.added[1].type, 'set');
    assert.strictEqual(dw.def.steps.length, 2, 'entry 1 was applied; no wait step was built');
    assert.ok(!dw.def.steps.some(s => s.type === 'wait'));
    assert.strictEqual(dw.def.steps[1].fields.when.path, `steps.${aId}.output.iso`, '"$a" keeps pointing at the step it named');
    assert.ok(r._warnings.some(w => new RegExp(`^steps\\[0\\] \\(\\$a\\): "\\$a" was already built as ${aId} with a different spec; the built one was kept\\. Change it with builder_update_step\\(\\{stepId:"${aId}", patch:\\{…\\}\\}\\)\\.$`).test(w)), JSON.stringify(r._warnings));
});

test('the same tempId with a DIFFERENT spec after a SUCCESS is a recycled handle: refused with a fresh handle, nothing wired to the old step', async () => {
    // Measured: a second chain in the same turn re-used the "a"/"read"
    // handles of the first; the new steps were dropped and their bindings
    // pointed at the first chain.
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const first = await applyToolCall('builder_add_steps', { steps: [{ tempId: 'a', type: 'datetime', spec: { op: 'now' } }] }, dw);
    assert.ok(!first.error, first.error);
    const aId = first.added[0].id;
    const r = await applyToolCall('builder_add_steps', {
        steps: [
            { tempId: 'a', type: 'wait', spec: { seconds: 5 } },
            { tempId: 'b', type: 'set', spec: { fields: { when: ref('steps.$a.output.iso') } } },
        ],
    }, dw);
    assert.ok(r.error, 'refused');
    assert.strictEqual(r.failedIndex, 0);
    assert.match(r.error, new RegExp(`^steps\\[0\\] \\(\\$a\\): tempId "a" already names ${aId} \\(datetime\\) in this turn and this entry is a different step\\.`));
    assert.match(r._fixHint, /^Reject reason: tempId "a" is already bound this turn\. Resend this entry as tempId "a2" and write steps\.\$a2… \/ "\$a2" in the entries after it/);
    assert.strictEqual(r.resendAs.args.steps[0].tempId, 'a2', 'resendAs already carries the free handle');
    assert.strictEqual(r.resendAs.args.steps[0].type, 'wait');
    assert.deepStrictEqual(r.added, [], 'entries before it: none');
    assert.strictEqual(dw.def.steps.length, 1, 'no wait, no set');
    assert.ok(!dw.def.steps.some(s => s.type === 'wait' || s.type === 'set'));
    // Obeying the hint lands, and "$a" still means the first step.
    const ok = await applyToolCall('builder_add_steps', {
        steps: [
            { tempId: 'a2', type: 'wait', spec: { seconds: 5 } },
            { tempId: 'b', type: 'set', spec: { fields: { when: ref('steps.$a.output.iso'), after: ref('steps.$a2.output.waited') } } },
        ],
    }, dw);
    assert.ok(!ok.error, ok.error);
    assert.strictEqual(dw.def.steps.length, 3);
    assert.strictEqual(dw.def.steps[2].fields.when.path, `steps.${aId}.output.iso`);
    assert.strictEqual(dw.def.steps[2].fields.after.path, `steps.${ok.idMap.a2}.output.waited`);
});

test('a step removed earlier in the turn is not "already built": the re-added entry gets a NEW id and the handle follows it', async () => {
    // Measured: remove-and-re-add left the draft without the step, wired the
    // consumer to the dead id, and told the model to patch a step that no
    // longer existed.
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const readSpec = { tool: 'gmail_read', forEach: { overRef: 'steps.$search.output.results', itemVar: 'm' }, inputs: { messageId: ref('loop.m.id') }, label: 'Read each' };
    const built = await applyToolCall('builder_add_steps', { steps: [
        { tempId: 'search', type: 'integration_action', spec: { tool: 'gmail_search', inputs: { query: lit('is:unread') } } },
        { tempId: 'read', type: 'integration_action', spec: structuredClone(readSpec) },
    ] }, dw);
    assert.ok(!built.error, built.error);
    const oldRead = built.idMap.read;
    const removed = await applyToolCall('builder_remove_step', { stepId: oldRead }, dw);
    assert.ok(!removed.error, removed.error);
    assert.ok(!dw.def.steps.some(s => s.id === oldRead));
    // Same spec, same handle, plus a consumer of it.
    const again = await applyToolCall('builder_add_steps', { steps: [
        { tempId: 'read', type: 'integration_action', spec: structuredClone(readSpec) },
        { tempId: 'note', type: 'notification', spec: { title: 'Done', body: '{{steps.$read.output.results}}' } },
    ] }, dw);
    assert.ok(!again.error, again.error);
    assert.strictEqual(again.added[0].reused, undefined, 'built anew, not reused');
    assert.notStrictEqual(again.added[0].id, oldRead, 'a NEW id');
    const newRead = dw.def.steps.find(s => s.tool === 'gmail_read');
    assert.ok(newRead && newRead.id === again.added[0].id, 'the read step is back in the draft');
    assert.strictEqual(textAsTemplate(dw.def.steps.find(s => s.type === 'notification').body), `{{steps.${newRead.id}.output.results}}`, 'the consumer points at the new id');
    assert.ok(again._warnings.some(w => new RegExp(`^\\$read: was built earlier this turn as ${oldRead}, but that step has since been removed`).test(w)), JSON.stringify(again._warnings));
    assert.strictEqual(dw._tempIds.read, newRead.id);
    assert.ok(!dw._mintedThisTurn.has(oldRead));
    assert.deepStrictEqual(edgePairs(dw.def).filter(([, to]) => to === newRead.id), [[built.idMap.search, newRead.id]], 'chained after the tail');
});

test('a removed batch-built step re-added under a different handle, or with the same handle and a changed spec, is built — and the removed id is named', async () => {
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const first = await applyToolCall('builder_add_steps', { steps: [
        { tempId: 'a', type: 'set', spec: { fields: { x: lit(1) } } },
        { tempId: 'w', type: 'wait', spec: { seconds: 30 } },
        { tempId: 'b', type: 'set', spec: { fields: { y: lit(2) } } },
    ] }, dw);
    assert.ok(!first.error, first.error);
    const waitId = first.idMap.w;
    assert.ok(!(await applyToolCall('builder_remove_step', { stepId: waitId }, dw)).error);
    // The fingerprint branch: same spec, explicit anchor, another handle.
    const re = await applyToolCall('builder_add_steps', { steps: [{ tempId: 'w2', type: 'wait', spec: { seconds: 30, afterStepId: first.idMap.b } }] }, dw);
    assert.ok(!re.error, re.error);
    assert.strictEqual(re.added[0].reused, undefined);
    assert.notStrictEqual(re.added[0].id, waitId);
    assert.ok(dw.def.steps.some(s => s.id === re.added[0].id && s.type === 'wait'));
    assert.ok(re._warnings.some(w => w.includes(waitId) && /has since been removed/.test(w)), JSON.stringify(re._warnings));
    // The handle branch: the original handle with a different spec, after
    // ITS step was removed — free again, so built (not skipped, not refused).
    assert.ok(!(await applyToolCall('builder_remove_step', { stepId: re.added[0].id }, dw)).error);
    const re2 = await applyToolCall('builder_add_steps', { steps: [{ tempId: 'w', type: 'wait', spec: { seconds: 45, afterStepId: first.idMap.b } }] }, dw);
    assert.ok(!re2.error, re2.error);
    assert.strictEqual(re2.added[0].reused, undefined);
    assert.strictEqual(dw.def.steps.find(s => s.type === 'wait').seconds, 45);
    assert.strictEqual(dw._tempIds.w, re2.added[0].id);
});

test('two distinct entries with the same spec in ONE call are two steps: a call is never a resend of itself', async () => {
    // Measured: [wait, notif, wait, notif] built 2 steps and mapped $w2 to
    // $w1; a condition whose branches both ended in 'Done' lost the else copy.
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const poll = { steps: [
        { tempId: 'p1', type: 'http_request', spec: { url: 'https://x.test/poll', method: 'GET' } },
        { tempId: 'w1', type: 'wait', spec: { seconds: 30 } },
        { tempId: 'p2', type: 'http_request', spec: { url: 'https://x.test/poll', method: 'GET' } },
        { tempId: 'w2', type: 'wait', spec: { seconds: 30 } },
        { tempId: 'p3', type: 'http_request', spec: { url: 'https://x.test/poll', method: 'GET' } },
    ] };
    const r = await applyToolCall('builder_add_steps', structuredClone(poll), dw);
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.added.length, 5);
    assert.ok(r.added.every(a => !a.reused), 'none reused');
    assert.strictEqual(new Set(r.added.map(a => a.id)).size, 5, 'five distinct ids');
    assert.strictEqual(dw.def.steps.filter(s => s.type === 'wait').length, 2, 'two wait steps');
    assert.notStrictEqual(r.idMap.w2, r.idMap.w1);
    assert.ok(edgePairs(dw.def).some(([f, t]) => f === r.idMap.p2 && t === r.idMap.w2), 'the second wait chains after the second poll');
    // The same batch again, in a later call: every entry is the one built.
    const again = await applyToolCall('builder_add_steps', structuredClone(poll), dw);
    assert.ok(!again.error, again.error);
    assert.ok(again.added.every(a => a.reused === true), JSON.stringify(again.added));
    assert.deepStrictEqual(again.added.map(a => a.id), r.added.map(a => a.id), 'entry for entry');
    assert.strictEqual(dw.def.steps.length, 5, 'nothing added twice');

    // Both branch tails end in the same notification.
    const dw2 = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw2);
    const b = await applyToolCall('builder_add_steps', { steps: [
        { tempId: 'c', type: 'condition', spec: { expr: 'true' } },
        { tempId: 'a', type: 'set', spec: { fields: { v: lit('then') }, afterStepId: '$c', branch: 'then' } },
        { tempId: 'b', type: 'set', spec: { fields: { v: lit('else') }, afterStepId: '$c', branch: 'else' } },
        { tempId: 'n1', type: 'notification', spec: { title: 'Done', body: 'Finished', afterStepId: '$a' } },
        { tempId: 'n2', type: 'notification', spec: { title: 'Done', body: 'Finished', afterStepId: '$b' } },
    ] }, dw2);
    assert.ok(!b.error, b.error);
    assert.ok(b.added.every(a => !a.reused), JSON.stringify(b.added));
    assert.strictEqual(dw2.def.steps.filter(s => s.type === 'notification').length, 2, 'two notifications');
    assert.ok(edgePairs(dw2.def).some(([f, t]) => f === b.idMap.b && t === b.idMap.n2), 'the else branch ends in its own notification');
});

test('after a reused prefix the failing entry is still anchored: lastAppliedId is the reused id, never null', async () => {
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const batch = { steps: [
        { tempId: 'a', type: 'datetime', spec: { op: 'now' } },
        { tempId: 'x', type: 'data_extraction', spec: { fields: [{ name: 'a', type: 'string' }] } }, // no source
    ] };
    const r1 = await applyToolCall('builder_add_steps', structuredClone(batch), dw);
    assert.ok(r1.error && r1.failedIndex === 1, r1.error);
    assert.strictEqual(r1.lastAppliedId, r1.added[0].id);
    const r2 = await applyToolCall('builder_add_steps', structuredClone(batch), dw);
    assert.ok(r2.error && r2.failedIndex === 1, r2.error);
    assert.strictEqual(r2.added[0].reused, true);
    assert.strictEqual(r2.lastAppliedId, r2.added[0].id, 'the reused entry is the last one that landed');
    assert.strictEqual(r2.resendAs.args.steps[0].spec.afterStepId, r2.added[0].id, 'resendAs carries the anchor');
    assert.ok(!/chains after "null"/.test(r2._fixHint), r2._fixHint);
    assert.match(r2._fixHint, new RegExp(`chains after "${r2.added[0].id}"`));
});

test('per-entry rollback: entry 2 fails after 0..1 built — the graph is exactly the post-entry-1 state', async () => {
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const r = await applyToolCall('builder_add_steps', {
        steps: [
            { tempId: 'a', type: 'datetime', spec: { op: 'now' } },
            { tempId: 'b', type: 'set', spec: { fields: { when: ref('steps.$a.output.iso') } } },
            { tempId: 'c', type: 'set', spec: { fields: { bad: ref('nowhere.at.all') } } },
            { tempId: 'd', type: 'notification', spec: { title: 'never', body: 'x' } },
        ],
    }, dw);
    assert.ok(r.error && r.failedIndex === 2, `entry 2 is the one refused: ${r.error}`);
    assert.strictEqual(r.added.length, 2);
    const [a, b] = r.added.map(x => x.id);
    assert.deepStrictEqual(dw.def.steps.map(s => s.id), [a, b], 'steps: exactly entries 0 and 1');
    assert.deepStrictEqual(edgePairs(dw.def), [['trg', a], [a, b]], 'edges: exactly the chain up to entry 1');
    assert.strictEqual(r.lastAppliedId, b);
    assert.strictEqual(r.resendAs.args.steps[0].tempId, 'c');
    assert.strictEqual(r.resendAs.args.steps[0].spec.afterStepId, b);
    assert.deepStrictEqual(Object.keys(r.idMap).sort(), ['a', 'b'], 'the refused entry and the one after it minted nothing');
});

test('an inspect-gate refusal inside a batch keeps the prefix, inlines the schema, and the resend passes the gate', async () => {
    const dw = wrap({ inspected: [] });
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const r = await applyToolCall('builder_add_steps', {
        steps: [
            { tempId: 'a', type: 'datetime', spec: { op: 'now' } },
            // Non-trivial inputs on a tool the model never inspected, and the
            // required `query` not among them → the §B3 gate.
            { tempId: 's', type: 'integration_action', spec: { tool: 'gmail_search', inputs: { maxResults: lit(5) } } },
            { tempId: 'n', type: 'notification', spec: { title: 'after', body: '{{steps.$s.output.total}}' } },
        ],
    }, dw);
    assert.ok(r.error && r.failedIndex === 1, `gated at entry 1: ${r.error}`);
    assert.strictEqual(r._needsInspect, 'gmail_search');
    assert.ok(r.toolSchema && r.toolSchema.inputs.query.required === true, 'the schema is inlined on the partial result');
    assert.deepStrictEqual(r.toolSchema.requiredInputs, ['query']);
    assert.strictEqual(r.added.length, 1, 'entry 0 stays');
    assert.strictEqual(dw.def.steps.length, 1);
    assert.ok(dw._inspectedTools.has('gmail_search'), 'the rejection marks the tool inspected');
    // Resend from index 1 with the required input bound: one round, no
    // builder_inspect_tool in between.
    const resend = await applyToolCall('builder_add_steps', {
        steps: [
            { tempId: 's', type: 'integration_action', spec: { tool: 'gmail_search', inputs: { maxResults: lit(5), query: lit('is:unread') }, afterStepId: r.lastAppliedId } },
            { tempId: 'n', type: 'notification', spec: { title: 'after', body: '{{steps.$s.output.total}}' } },
        ],
    }, dw);
    assert.ok(!resend.error, `the resend passes the gate: ${resend.error}`);
    assert.strictEqual(resend.added.length, 2);
    assert.strictEqual(dw.def.steps.length, 3);
    assert.deepStrictEqual(edgePairs(dw.def), [['trg', r.added[0].id], [r.added[0].id, resend.idMap.s], [resend.idMap.s, resend.idMap.n]]);
});

test('batch-level pre-validation still applies nothing: tempId grammar, unknown type, duplicate tempId in one call', async () => {
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const cases = [
        { steps: [{ tempId: 'a', type: 'datetime', spec: { op: 'now' } }, { tempId: '1bad', type: 'datetime', spec: { op: 'now' } }], rx: /steps\[1\]: tempId "1bad" must match/ },
        { steps: [{ tempId: 'a', type: 'datetime', spec: { op: 'now' } }, { tempId: 'b', type: 'nonsense', spec: {} }], rx: /steps\[1\]: unknown type "nonsense"/ },
        { steps: [{ tempId: 'a', type: 'datetime', spec: { op: 'now' } }, { tempId: 'a', type: 'wait', spec: { seconds: 1 } }], rx: /steps\[1\]: duplicate tempId "a"/ },
    ];
    for (const { steps, rx } of cases) {
        const r = await applyToolCall('builder_add_steps', { steps }, dw);
        assert.match(r.error, rx);
        assert.strictEqual(r.added, undefined, 'no partial result — the loop never started');
        assert.strictEqual(r.failedIndex, undefined);
        assert.strictEqual(r.resendAs, undefined);
        assert.strictEqual(dw.def.steps.length, 0, 'entry 0 was NOT built');
        assert.deepStrictEqual(edgePairs(dw.def), []);
        assert.deepStrictEqual(Object.keys(dw._tempIds || {}), [], 'nothing minted, no handle remembered');
    }
});

test('a duplicate action stays an error on the single-step tool; inside a batch, a duplicate of a step minted this turn is a no-op', async () => {
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const first = await applyToolCall('builder_add_steps', {
        steps: [{ tempId: 's', type: 'integration_action', spec: { tool: 'gmail_search', inputs: { query: lit('is:unread') } } }],
    }, dw);
    assert.ok(!first.error, first.error);
    const sId = first.idMap.s;
    // The single-step tool: nothing there says "resend", so the same call
    // twice is a mistake and is refused.
    const single = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: { query: lit('is:unread') } }, dw);
    assert.ok(single.error && /identical inputs/.test(single.error), `single-step duplicate refused: ${single.error}`);
    assert.strictEqual(dw.def.steps.length, 1);
    // The batch: a different handle, and the spec drifted (a bare literal
    // where the built step has the {kind:"literal"} envelope) — so neither
    // the fingerprint nor the handle finds it; the tool+inputs match against
    // a step minted this turn does.
    const batch = await applyToolCall('builder_add_steps', {
        steps: [
            { tempId: 's2', type: 'integration_action', spec: { tool: 'gmail_search', inputs: { query: 'is:unread' } } },
            { tempId: 'n', type: 'notification', spec: { title: 'x', body: '{{steps.$s2.output.total}}' } },
        ],
    }, dw);
    assert.ok(!batch.error, `in-batch duplicate is a no-op: ${batch.error}`);
    assert.deepStrictEqual({ ...batch.added[0] }, { tempId: 's2', id: sId, type: 'integration_action', tool: 'gmail_search', reused: true });
    assert.strictEqual(dw.def.steps.length, 2, 'one search, one notification');
    assert.strictEqual(textAsTemplate(dw.def.steps[1].body), `{{steps.${sId}.output.total}}`, 'the new handle points at the step that was reused');
    assert.ok(batch._warnings.some(w => new RegExp(`^steps\\[0\\] \\(\\$s2\\): gmail_search with these inputs was already built in this turn as ${sId} — not added twice\\.$`).test(w)), JSON.stringify(batch._warnings));
    // A step minted in an EARLIER turn (a fresh wrap over the same draft) is
    // not "this turn": the batch refuses it like the single-step tool does.
    const nextTurn = { ...wrap(), def: dw.def };
    const stale = await applyToolCall('builder_add_steps', {
        steps: [{ tempId: 's3', type: 'integration_action', spec: { tool: 'gmail_search', inputs: { query: lit('is:unread') } } }],
    }, nextTurn);
    assert.ok(stale.error && stale.failedIndex === 0 && /identical inputs/.test(stale.error), `next turn: refused: ${stale.error}`);
    assert.strictEqual(dw.def.steps.length, 2);
});
