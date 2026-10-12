/**
 * refCheck — a refusal must be CERTAIN and a repair must keep the MEANING.
 *
 * REGRESSION (code review 2026-10, findings ai-builder 1-9): the deep path
 * check refused bindings that resolve at run time and rewrote bindings into
 * different ones, and the identical-resend ladder then saved the rewrite:
 *   - a long dry-run list read as 60 entries, yet refused a key entry 70 had;
 *   - one observed output (a dry run, a tool's last run) taken as the full key
 *     set, so an optional `nextCursor` was refused;
 *   - a set step's rows modelled without its operations (rowId, rename) and
 *     a datatable output without `skipped`;
 *   - `headers[1]` rewritten to `headers[name="Received"]` (another entry),
 *     `ranking[0]` to `ranking[name="Alice"]` (a sample value in the saved
 *     definition);
 *   - any 2-letter key "near" any other (`to` → `id`), applied on the resend;
 *   - a forEach over JSON text of a list (the run now reads it as the list:
 *     bind.walkList) must be accepted as written.
 * These pin the rule: refuse only where the shape is known completely; repair
 * automatically only what keeps the meaning (case, `.output.`, the same key in
 * exactly one other place, `[*]` where a list is wanted); everything else is a
 * did-you-mean in a WARNING, never a patch the resend applies.
 *
 * Run: cd server && node --test automation/builderTools/refCheck.certainty.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAndFixBindings, sanitizeForEach, sanitizeArrayRef } = require('./bindings');
const { checkLoopRef } = require('./outputFields');
const { rememberStepShape } = require('./refCheck');
const { getPath } = require('../expr');

const ref = path => ({ kind: 'ref', path });
const CODE = { id: 'c', type: 'code' };
const EX = { id: 'ex', type: 'data_extraction', fields: [{ name: 'id', type: 'string' }, { name: 'bedrag', type: 'number' }] };
const RATES = { id: 'rt', type: 'data_extraction', fields: [{ name: 'rate', type: 'number' }, { name: 'amount', type: 'number' }] };
const TOTAAL = { id: 'tt', type: 'data_extraction', fields: [{ name: 'datum', type: 'date' }, { name: 'totaal', type: 'number' }] };
const LIST = { id: 'l', type: 'integration_action', tool: 'nextcloud_list_files' };
const FAN = { id: 'fan', type: 'integration_action', tool: 'nextcloud_read_file', forEach: { overRef: 'steps.l.output.items', itemVar: 'f' } };
const MCP = { id: 'm', type: 'integration_action', tool: 'crm_list_contacts' };

function wrap(extra = [], more = {}) {
    return { userId: 'u_test', def: { trigger: { id: 't', kind: 'manual' }, steps: [CODE, EX, RATES, TOTAAL, LIST, FAN, MCP, ...extra], edges: [] }, ...more };
}

function check(path, dw, opts = {}) {
    const r = validateAndFixBindings({ v: ref(path) }, dw.def, { draftWrap: dw, ...opts });
    return { path: r.inputs.v && r.inputs.v.path, error: r.error, notes: (r.notes || []).join('\n'), patch: r._suggestedPatch };
}

// ── Finding 1: a long list ──────────────────────────────────────────────

test('a key only one entry of a 100-entry dry-run list has resolves; the resend never binds another field', async () => {
    const { applyToolCall } = require('../builderTools');
    const dw = wrap();
    const messages = Array.from({ length: 100 }, (_, i) => (i === 70 ? { id: `m${i}`, cc: 'boss@x.nl' } : { id: `m${i}` }));
    rememberStepShape(dw, CODE, { messages });
    for (const p of ['steps.c.output.messages[*].cc', 'steps.c.output.messages[70].cc']) {
        const r = check(p, dw);
        assert.equal(r.error, null, `${p}: ${r.error}`);
        assert.equal(r.path, p);
        assert.equal(r.patch, undefined);
    }
    const args = { afterStepId: 'c', fields: { copy: ref('steps.c.output.messages[70].cc') } };
    const first = await applyToolCall('builder_add_set', structuredClone(args), dw);
    assert.ok(!first.error, first.error);
    assert.deepEqual(first.added.fields.copy, ref('steps.c.output.messages[70].cc'));
    assert.equal(getPath({ steps: { c: { output: { messages } } } }, first.added.fields.copy.path), 'boss@x.nl');
});

// ── Finding 2 (and 9): an index into a name/value list ──────────────────

test('an index into a name/value list is kept as written — never turned into a match', () => {
    const dw = wrap();
    const headers = [{ name: 'Received', value: 'from mx1 (hop 1)' }, { name: 'Received', value: 'from relay (hop 2)' }, { name: 'Subject', value: 'Hi' }];
    rememberStepShape(dw, CODE, { payload: { headers }, ranking: [{ name: 'Alice', value: 42 }, { name: 'Bob', value: 17 }], messages: [{ headers }] });
    const dup = check('steps.c.output.payload.headers[1].value', dw);
    assert.equal(dup.error, null);
    assert.equal(dup.path, 'steps.c.output.payload.headers[1].value');
    assert.equal(getPath({ steps: { c: { output: { payload: { headers } } } } }, dup.path), 'from relay (hop 2)');
    assert.doesNotMatch(dup.notes, /\[name="Received"\]/, 'a match would read the FIRST Received');
    assert.doesNotMatch(dup.notes, /order differs/, 'one sample shows no order');

    const top = check('steps.c.output.ranking[0].name', dw);
    assert.equal(top.path, 'steps.c.output.ranking[0].name', 'the top entry stays the top entry');
    assert.doesNotMatch(top.notes, /order differs/);
    assert.match(top.notes, /ranking\[name="Alice"\]/, 'picking by name is said, as advice');

    const tpl = validateAndFixBindings({ v: { kind: 'template', value: 'Top: {{steps.c.output.ranking[0].name}}' } }, dw.def, { draftWrap: dw });
    assert.equal(tpl.inputs.v.value, 'Top: {{steps.c.output.ranking[0].name}}');

    const loop = checkLoopRef(dw.def, 'loop.m.headers[1].value', { overRef: 'steps.c.output.messages', itemVar: 'm' }, dw);
    assert.deepEqual(loop, { ok: true }, 'a loop ref keeps its index too');
});

// ── Finding 3: did-you-mean on short keys ───────────────────────────────

test('a 2-letter key is not "near" every other 2-letter key, and an edit-distance guess is never a patch', async () => {
    const dw = wrap();
    const to = check('steps.ex.output.to', dw);
    assert.match(to.error, /steps\.ex\.output has no "to"/, 'a declared key set still refuses');
    assert.doesNotMatch(to.error, /Did you mean/);
    assert.equal(to.patch, undefined);
    const date = check('steps.rt.output.date', dw);
    assert.match(date.error, /has no "date"/);
    assert.equal(date.patch, undefined, 'date → rate is another field');
    const total = check('steps.tt.output.total', dw);
    assert.match(total.error, /Did you mean steps\.tt\.output\.totaal\?/, 'still said');
    assert.equal(total.patch, undefined, 'still a guess: never applied by the resend');

    const { applyToolCall } = require('../builderTools');
    const args = { afterStepId: 'ex', fields: { recipient: ref('steps.ex.output.to') } };
    const r1 = await applyToolCall('builder_add_set', structuredClone(args), dw);
    assert.ok(r1.error);
    const r2 = await applyToolCall('builder_add_set', structuredClone(args), dw);
    assert.ok(r2.error, 'the identical resend is refused again, not rebound to id');
    assert.ok(!dw.def.steps.some(s => s.type === 'set'));
});

test('the same key in exactly one other place of a complete shape is a patch the resend may apply', () => {
    const r = check('steps.fan.output.content', wrap());
    assert.match(r.error, /Did you mean steps\.fan\.output\.results\[0\]\.output\.content\?/);
    assert.deepEqual(r.patch, { ops: [{ op: 'set', path: 'inputs.v', value: ref('steps.fan.output.results[0].output.content') }] });
});

// ── Finding 4: set and datatable outputs ────────────────────────────────

test('a set step\'s operations and a datatable\'s skipped are part of what the step outputs', () => {
    const SET = { id: 's', type: 'set', arrayRef: 'steps.c.output.rows', fields: { state: ref('item.status') }, operations: [{ op: 'rename', from: 'name', to: 'customer' }, { op: 'rowId', target: 'nr', start: 10 }] };
    const SET_FAN = { id: 's2', type: 'set', arrayRef: 'steps.fan.output.results', fields: {}, operations: [{ op: 'rowId', target: 'nr' }] };
    const FIND = { id: 'f', type: 'datatable', op: 'find_rows', datatableId: 'tbl_1' };
    const ADD = { id: 'a', type: 'datatable', op: 'add_row', datatableId: 'tbl_1', values: {} };
    const dw = wrap([SET, SET_FAN, FIND, ADD]);
    rememberStepShape(dw, CODE, { rows: [{ name: 'Acme', status: 'new' }] });
    for (const p of ['steps.s.output.items[0].customer', 'steps.s.output.items[0].nr', 'steps.s.output.items[*].state', 'steps.s2.output.items[0].nr', 'steps.f.output.skipped', 'steps.a.output.skipped']) {
        const r = check(p, dw);
        assert.equal(r.error, null, `${p}: ${r.error}`);
        assert.equal(r.path, p, `${p} is not rewritten (a set row is a copy, not a forEach entry)`);
    }
    assert.deepEqual(checkLoopRef(dw.def, 'loop.row.customer', { overRef: 'steps.s.output.items', itemVar: 'row' }, dw), { ok: true });
});

// ── Finding 5: one observed output ──────────────────────────────────────

test('a key one observed run lacked is a warning with a did-you-mean, never a refusal or a rewrite', () => {
    const dw = wrap([], { _runtimeShapes: { crm_list_contacts: { items: { _array: { id: 'string', cursor: 'string' }, _length: 3 }, text: 'string' } } });
    const cur = check('steps.m.output.nextCursor', dw);
    assert.equal(cur.error, null, cur.error);
    assert.equal(cur.path, 'steps.m.output.nextCursor');
    assert.match(cur.notes, /has no "nextCursor"/);
    const next = check('steps.m.output.next', dw);
    assert.equal(next.error, null);
    assert.equal(next.path, 'steps.m.output.next');
    assert.equal(next.patch, undefined);
    const moved = check('steps.m.output.cursor', dw);
    assert.equal(moved.path, 'steps.m.output.cursor', 'an optional top-level key is not moved into a list entry');
    assert.match(moved.notes, /Did you mean steps\.m\.output\.items\[0\]\.cursor\?/);

    rememberStepShape(dw, CODE, { items: [{ id: 'a' }] });
    const dry = check('steps.c.output.items[0].email', dw);
    assert.equal(dry.error, null, 'a dry run is one run too');
    assert.match(dry.notes, /has no "email"/);
    assert.equal(check('steps.c.output.items.email', dw).path, 'steps.c.output.items[0].email', 'a key on a list is still repaired');
});

// ── Finding 7: a list wanted, JSON text found ───────────────────────────

// The runtime reads a forEach / Loop / arrayRef source through
// bind.walkList, which takes JSON text of a list as that list; the check
// agrees and keeps the path as written, with no note.
test('a forEach or arrayRef on JSON text of a list is accepted as written, like the run reads it', () => {
    const dw = wrap();
    const out = { list: '[{"sku":"A"},{"sku":"B"}]', obj: '{"a":1}', real: [{ sku: 'C' }] };
    rememberStepShape(dw, CODE, out);
    const { walkList } = require('../bind');
    for (const p of ['steps.c.output.list', 'steps.c.output.list[*]', 'steps.c.output.real']) {
        const r = sanitizeForEach({ overRef: p, itemVar: 'p' }, dw.def, dw);
        assert.equal(r.error, undefined, p);
        assert.equal(r.forEach.overRef, p);
        assert.equal(r.notes, undefined, p);
        assert.ok(Array.isArray(walkList(p, { steps: { c: { output: out } } })), `${p}: the run iterates it`);
        assert.deepEqual(checkLoopRef(dw.def, 'loop.p.sku', r.forEach, dw), { ok: true }, p);
    }
    const ar = sanitizeArrayRef('steps.c.output.list', dw.def, { draftWrap: dw });
    assert.deepEqual(ar, { arrayRef: 'steps.c.output.list', notes: [], error: null });
    // Text that holds an object is no list: said (one observed run), not refused.
    const notList = sanitizeForEach({ overRef: 'steps.c.output.obj', itemVar: 'p' }, dw.def, dw);
    assert.match(notList.notes.join('\n'), /is an object, not a list/);
    assert.ok(!Array.isArray(walkList('steps.c.output.obj', { steps: { c: { output: out } } })));
});
