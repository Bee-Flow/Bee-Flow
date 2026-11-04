/**
 * app_set_action refuses what the canonicalizer would silently cut: a saved
 * action never loses an input, a list entry or the end of a text.
 *
 * Run: cd server && node --test appStudio/builderTools/definitionTools/actions.limits.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applySetActionTool } = require('./actions');
const { emptyDefinition, LIMITS } = require('../../componentSpecs');

const wrapOf = (def = emptyDefinition('Limits')) => ({ userId: 'u1', def, dataModel: { tables: [] }, datasetIds: [] });
const src = (v) => ({ kind: 'static', value: v });
const sources = (n, label = (i) => `Source ${i}`) => Array.from({ length: n }, (_, i) => ({ label: label(i), source: src([i]) }));
const generate = (extra) => ({ kind: 'sequence', steps: [{ kind: 'ai_generate', prompt: 'Summarise', resultVar: 'out', ...extra }] });

test('an AI step with 12 context sources keeps all 12', async () => {
    const wrap = wrapOf();
    const r = await applySetActionTool(wrap, { action: generate({ contextSources: sources(12) }) });
    assert.ok(!r.error, JSON.stringify(r));
    assert.equal(wrap.def.actions[r.actionId].steps[0].contextSources.length, 12);
    assert.ok(!(r._hints || []).some((h) => /context source/.test(h)), 'no repair note: nothing was dropped');
});

test('a 13th context source is rejected with the limit, the value and a _fixHint; nothing is created', async () => {
    const wrap = wrapOf();
    const r = await applySetActionTool(wrap, { action: generate({ contextSources: sources(13) }) });
    assert.match(r.error, /13 context sources — the maximum is 12/);
    assert.match(r._fixHint, /nothing was cut or dropped/);
    assert.deepEqual(Object.keys(wrap.def.actions || {}), [], 'the draft is untouched');
});

test('an update that would drop a context source is rejected and leaves the stored action as it was', async () => {
    const wrap = wrapOf();
    const created = await applySetActionTool(wrap, { action: generate({ contextSources: sources(12) }) });
    const before = JSON.stringify(wrap.def.actions[created.actionId]);
    const r = await applySetActionTool(wrap, { actionId: created.actionId, action: generate({ contextSources: sources(14) }) });
    assert.match(r.error, /14 context sources — the maximum is 12/);
    assert.equal(JSON.stringify(wrap.def.actions[created.actionId]), before);
});

test('a context source label of 121 chars is rejected, 120 is kept whole', async () => {
    const ok = wrapOf();
    const kept = await applySetActionTool(ok, { action: generate({ contextSources: sources(1, () => 'l'.repeat(120)) }) });
    assert.ok(!kept.error, JSON.stringify(kept));
    assert.equal(ok.def.actions[kept.actionId].steps[0].contextSources[0].label.length, 120);
    const r = await applySetActionTool(wrapOf(), { action: generate({ contextSources: sources(1, () => 'l'.repeat(121)) }) });
    assert.match(r.error, /label is 121 chars — the maximum is 120/);
});

test('a schema field description of 2000 is kept, 2001 is rejected naming both numbers', async () => {
    const extract = (n) => ({ kind: 'sequence', steps: [{ kind: 'ai_extract', source: src('x'), schema: [{ name: 'a', type: 'string', description: 'd'.repeat(n) }] }] });
    const ok = wrapOf();
    const kept = await applySetActionTool(ok, { action: extract(2000) });
    assert.ok(!kept.error, JSON.stringify(kept));
    assert.equal(ok.def.actions[kept.actionId].steps[0].schema[0].description.length, 2000);
    const r = await applySetActionTool(wrapOf(), { action: extract(2001) });
    assert.match(r.error, /is 2001 chars — the maximum is 2000/);
    assert.ok(r._fixHint);
});

test('a prompt of 32000 chars is kept, 32001 is rejected', async () => {
    const ok = await applySetActionTool(wrapOf(), { action: generate({ prompt: 'p'.repeat(LIMITS.MAX_AI_PROMPT_LEN) }) });
    assert.ok(!ok.error, JSON.stringify(ok));
    const r = await applySetActionTool(wrapOf(), { action: generate({ prompt: 'p'.repeat(LIMITS.MAX_AI_PROMPT_LEN + 1) }) });
    assert.match(r.error, /32001 chars — the maximum is 32000/);
});

test('any other string cut to a limit is also a rejection (a toast message past the string cap)', async () => {
    const r = await applySetActionTool(wrapOf(), { action: { kind: 'toast', message: 'm'.repeat(LIMITS.MAX_STRING + 10) } });
    assert.ok(r.error, 'refused, not truncated');
    assert.ok(r._fixHint);
});

test('the action count error names the count and the maximum', async () => {
    const def = emptyDefinition('Many');
    def.actions = Object.fromEntries(Array.from({ length: LIMITS.MAX_ACTIONS }, (_, i) => [`act_pad${String(i).padStart(4, '0')}`, { kind: 'toast', message: `m${i}` }]));
    const r = await applySetActionTool(wrapOf(def), { action: { kind: 'toast', message: 'one more' } });
    assert.match(r.error, /The app has 200 actions — the maximum is 200/);
    assert.match(r._fixHint, /app_remove_action/);
    // an update of an existing action is still fine at the cap
    const upd = await applySetActionTool(wrapOf(def), { actionId: 'act_pad0000', action: { kind: 'toast', message: 'changed' } });
    assert.ok(!upd.error, JSON.stringify(upd));
});

test('an approval question with a 40-option select is refused, not cut', async () => {
    const wrap = wrapOf();
    const fields = [{ name: 'pick', type: 'select', label: 'x'.repeat(300), options: Array.from({ length: 40 }, (_, i) => `o${i}`) }];
    const r = await applySetActionTool(wrap, { action: { kind: 'sequence', steps: [{ kind: 'request_approval', prompt: 'Approve', approverUserIds: ['u2'], fields }] } });
    assert.ok(r.error, JSON.stringify(r));
    assert.match(r.error, /maximum is (25|120)/);
    assert.deepEqual(Object.keys(wrap.def.actions || {}), []);
});
