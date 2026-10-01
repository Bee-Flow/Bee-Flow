/**
 * outputFields — what a ref path yields, and the loop.<var>.<field> check.
 *
 * REGRESSION (2026-09-12): a step iterating steps.a_2.output.results (a
 * nextcloud_read_file with a forEach) bound `loop.r.content`; every cell was
 * empty at run time because a fan-out entry is {index, item, output, status}
 * and the text sat under output. These tests pin the shape knowledge that
 * check needs, source by source, and the repair that ends the measured loop.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/outputFields.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
    parseArrayItemFields, topLevelFieldsOf, itemFieldsOf, fieldsAtRef, checkLoopRef, describeItem,
} = require('./outputFields');

const NC_ITEM = ['name', 'path', 'type', 'size', 'contentType', 'modified', 'fileId'];
const NC_READ = ['path', 'size', 'contentType', 'extractedVia', 'truncated', 'content', 'meta'];

const A1 = { id: 'a1', type: 'integration_action', tool: 'nextcloud_list_files' };
const A2 = { id: 'a2', type: 'integration_action', tool: 'nextcloud_read_file', forEach: { overRef: 'steps.a1.output.items', itemVar: 'f' } };
const graph = (...steps) => ({ trigger: { id: 'trg', kind: 'manual' }, steps, edges: [] });
const FE_A2 = { overRef: 'steps.a2.output.results', itemVar: 'r' };
const FE_A1 = { overRef: 'steps.a1.output.items', itemVar: 'f' };

// ── 1/2: parseArrayItemFields ────────────────────────────────────────────

test('parseArrayItemFields keeps every name of the braced list, annotations stripped', () => {
    const got = parseArrayItemFields('array of { name, path, type ("file"|"folder"), size, contentType, modified, fileId }');
    assert.deepStrictEqual(got, NC_ITEM, 'type survives its ("file"|"folder") annotation');
});

test('parseArrayItemFields is null without a brace or without "array of"', () => {
    assert.strictEqual(parseArrayItemFields('array of string (labels after the change)'), null);
    assert.strictEqual(parseArrayItemFields('array (same as calendar_list_events.results)'), null);
    assert.strictEqual(parseArrayItemFields(undefined), null);
});

test('parseArrayItemFields does not read a nested object\'s members as item fields', () => {
    assert.deepStrictEqual(parseArrayItemFields('array of { id, values: { a, b }, title }'), ['id', 'values', 'title']);
});

// ── 3: a plain curated list ──────────────────────────────────────────────

test('steps.<id>.output.<array> of an integration_action reads the curated item shape', () => {
    const r = fieldsAtRef(graph(A1), 'steps.a1.output.items');
    assert.deepStrictEqual(r.fields, NC_ITEM);
    assert.strictEqual(r.source, 'curated');
    assert.strictEqual(r.arrayField, 'items');
    assert.deepStrictEqual(r.upstream, { stepId: 'a1', tool: 'nextcloud_list_files', type: 'integration_action' });
    assert.strictEqual(r.outputFields, null);
    assert.strictEqual(r.itemFields, null);
});

test('the path is normalised the way bindings.js stores it ($, brackets, whitespace)', () => {
    assert.deepStrictEqual(fieldsAtRef(graph(A1), ' $steps[a1].output["items"] ').fields, NC_ITEM);
});

// ── 4: fan-out ───────────────────────────────────────────────────────────

test('steps.<id>.output.results of a forEach step is a fan-out envelope with dotted output./item. paths', () => {
    const r = fieldsAtRef(graph(A1, A2), 'steps.a2.output.results');
    assert.strictEqual(r.source, 'fanout');
    for (const f of ['index', 'item', 'output', 'status', 'output.content', 'item.path']) {
        assert.ok(r.fields.includes(f), `fields include ${f}`);
    }
    assert.ok(r.outputFields.includes('content'));
    assert.deepStrictEqual(r.itemFields, NC_ITEM);
    assert.deepStrictEqual(r.upstream, { stepId: 'a2', tool: 'nextcloud_read_file', type: 'integration_action' });
    assert.strictEqual(r.arrayField, 'results');
});

test('a self-referencing overRef cannot recurse forever', () => {
    const loopy = { id: 'z', type: 'integration_action', tool: 'nextcloud_read_file', forEach: { overRef: 'steps.z.output.results', itemVar: 'z' } };
    const r = fieldsAtRef(graph(loopy), 'steps.z.output.results');
    assert.strictEqual(r.source, 'fanout');
    assert.deepStrictEqual(r.outputFields, NC_READ);
});

// ── 5: fan-out over other step types ─────────────────────────────────────

test('a data_extraction fan-out lists its declared fields as output fields', () => {
    const ex = { id: 'ex', type: 'data_extraction', fields: [{ name: 'datum' }, { name: 'totaal' }], forEach: FE_A2 };
    const r = fieldsAtRef(graph(A1, A2, ex), 'steps.ex.output.results');
    assert.deepStrictEqual(r.outputFields, ['datum', 'totaal']);
    assert.ok(r.fields.includes('output.totaal'));
    // its item is a fan-out entry of a2 — the envelope names, not a1's file
    assert.ok(r.itemFields.includes('output.content'));
});

test('per-type output fields: ai_step schema, set fields, http_request, datatable ops; unknown stays null', () => {
    const steps = [
        A1,
        { id: 'ai', type: 'ai_step', outputSchema: { type: 'object', properties: { score: {}, tier: {} } }, forEach: FE_A1 },
        { id: 'ai0', type: 'ai_step', forEach: FE_A1 },
        { id: 'st', type: 'set', fields: { total: { kind: 'literal', value: 1 } }, forEach: FE_A1 },
        { id: 'http', type: 'http_request', forEach: FE_A1 },
        { id: 'dtw', type: 'datatable', op: 'add_row', forEach: FE_A1 },
        { id: 'dtr', type: 'datatable', op: 'find_rows', forEach: FE_A1 },
        { id: 'dtd', type: 'datatable', op: 'delete_row', forEach: FE_A1 },
        { id: 'code', type: 'code', forEach: FE_A1 },
    ];
    const g = graph(...steps);
    const outputs = id => fieldsAtRef(g, `steps.${id}.output.results`).outputFields;
    assert.deepStrictEqual(outputs('ai'), ['score', 'tier']);
    assert.strictEqual(outputs('ai0'), null, 'an ai_step without a schema has an unknown shape, not an empty one');
    assert.deepStrictEqual(outputs('st'), ['total']);
    assert.deepStrictEqual(outputs('http'), ['status', 'headers', 'body']);
    assert.deepStrictEqual(outputs('dtw'), ['row', 'id', 'created', 'updated']);
    assert.deepStrictEqual(outputs('dtr'), ['rows', 'returned', 'found', 'hasMore', 'nextCursor']);
    assert.strictEqual(outputs('dtd'), null);
    assert.strictEqual(outputs('code'), null);
    // every fan-out still knows the item it iterated
    assert.deepStrictEqual(fieldsAtRef(g, 'steps.code.output.results').itemFields, NC_ITEM);
});

// ── 6: pass-through steps ────────────────────────────────────────────────

test('filter/limit/dedupe .items pass the upstream list through unchanged', () => {
    const flt = { id: 'flt', type: 'filter', arrayRef: 'steps.a2.output.results', expr: 'true' };
    const lim = { id: 'lim', type: 'limit', arrayRef: 'steps.flt.output.items', count: 3 };
    const g = graph(A1, A2, flt, lim);
    assert.deepStrictEqual(fieldsAtRef(g, 'steps.flt.output.items'), fieldsAtRef(g, 'steps.a2.output.results'));
    assert.deepStrictEqual(fieldsAtRef(g, 'steps.lim.output.items').fields, fieldsAtRef(g, 'steps.a2.output.results').fields);
});

test('a set in list mode passes the rows through plus the fields it adds', () => {
    const st = { id: 'st', type: 'set', arrayRef: 'steps.a1.output.items', fields: { extra: { kind: 'literal', value: 1 }, name: { kind: 'literal', value: 'x' } } };
    const r = fieldsAtRef(graph(A1, st), 'steps.st.output.items');
    assert.deepStrictEqual(r.fields, [...NC_ITEM, 'extra'], 'a field the rows already had is not listed twice');
    assert.strictEqual(r.source, 'curated');
});

test('a set in list mode over an unknown list stays unknown — its own fields do not make the rows "known"', () => {
    const st = { id: 'st', type: 'set', arrayRef: 'vars.rows', fields: { extra: { kind: 'literal', value: 1 } } };
    const r = fieldsAtRef(graph(st), 'steps.st.output.items');
    assert.strictEqual(r.fields, null);
    assert.deepStrictEqual(r.upstream, { stepId: 'st', tool: null, type: 'set' });
});

// ── 7: trigger.output ────────────────────────────────────────────────────

test('trigger.output of an app_event trigger lists the declared fields', () => {
    const g = { trigger: { id: 'trg', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } }, steps: [], edges: [] };
    const r = fieldsAtRef(g, 'trigger.output');
    assert.strictEqual(r.source, 'trigger');
    assert.ok(r.fields.includes('subject'));
    assert.deepStrictEqual(r.upstream, { stepId: 'trg', tool: null, type: 'trigger' });
});

test('trigger.output of a manual trigger is unknown', () => {
    const r = fieldsAtRef(graph(), 'trigger.output');
    assert.strictEqual(r.fields, null);
    assert.strictEqual(r.source, null);
});

test('trigger.output.<list> reads the entry shape off the declared sample; a list of strings is unknown', () => {
    const cal = { trigger: { id: 'trg', kind: 'app_event', appEvent: { provider: 'google-calendar', event: 'event.upcoming' } }, steps: [], edges: [] };
    const r = fieldsAtRef(cal, 'trigger.output.attendees');
    assert.strictEqual(r.source, 'trigger');
    assert.ok(r.fields.includes('email'));
    assert.strictEqual(r.arrayField, 'attendees');
    const gm = { trigger: { id: 'trg', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } }, steps: [], edges: [] };
    assert.strictEqual(fieldsAtRef(gm, 'trigger.output.labelIds').fields, null);
});

// ── 8: unknowns ──────────────────────────────────────────────────────────

test('an unknown step id, a loop ref and a vars ref are all-null', () => {
    const nothing = { fields: null, source: null, upstream: null, arrayField: null, outputFields: null, itemFields: null };
    assert.deepStrictEqual(fieldsAtRef(graph(A1), 'steps.nope.output.items'), nothing);
    assert.deepStrictEqual(fieldsAtRef(graph(A1), 'loop.x.y'), nothing);
    assert.deepStrictEqual(fieldsAtRef(graph(A1), 'vars.rows'), nothing);
    assert.deepStrictEqual(fieldsAtRef(graph(A1), 'steps.a1.output.items.name'), nothing, 'only exactly steps.<id>.output.<field>');
    assert.deepStrictEqual(fieldsAtRef(graph(A1), null), nothing);
});

test('a step type with no described list keeps its upstream so an error can still name it', () => {
    const r = fieldsAtRef(graph({ id: 'dt', type: 'datetime' }), 'steps.dt.output.items');
    assert.strictEqual(r.fields, null);
    assert.deepStrictEqual(r.upstream, { stepId: 'dt', tool: null, type: 'datetime' });
});

test('a step inside a loop body is found too', () => {
    const lp = { id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'i', body: [A1] };
    assert.deepStrictEqual(fieldsAtRef(graph(lp), 'steps.a1.output.items').fields, NC_ITEM);
});

// ── 9: runtime shapes win ────────────────────────────────────────────────

test('a runtime descriptor on the draft wrap beats the curated shape', () => {
    const dw = { _runtimeShapes: { nextcloud_list_files: { items: { _array: { name: 'string', path: 'string', extra: 'string' }, _length: 3 } } } };
    const r = fieldsAtRef(graph(A1), 'steps.a1.output.items', dw);
    assert.strictEqual(r.source, 'runtime');
    assert.ok(r.fields.includes('extra'));
    assert.deepStrictEqual(itemFieldsOf('nextcloud_list_files', 'items', dw), { fields: ['name', 'path', 'extra'], source: 'runtime' });
    assert.deepStrictEqual(topLevelFieldsOf('nextcloud_list_files', dw), { fields: ['items'], source: 'runtime' });
});

test('a runtime empty array says nothing about an entry — the curated shape still answers', () => {
    const dw = { _runtimeShapes: { nextcloud_list_files: { path: 'string', count: 'integer', items: 'array<empty>' } } };
    assert.deepStrictEqual(itemFieldsOf('nextcloud_list_files', 'items', dw), { fields: NC_ITEM, source: 'curated' });
    assert.deepStrictEqual(topLevelFieldsOf('nextcloud_list_files', dw), { fields: ['path', 'count', 'items'], source: 'runtime' });
});

test('topLevelFieldsOf: curated keys skip _-prefixed entries; sample is the fallback; unknown tool is null', () => {
    assert.deepStrictEqual(topLevelFieldsOf('nextcloud_read_file'), { fields: NC_READ, source: 'curated' });
    assert.deepStrictEqual(topLevelFieldsOf('no_such_tool'), { fields: null, source: null });
    assert.deepStrictEqual(itemFieldsOf('no_such_tool', 'items'), { fields: null, source: null });
    assert.deepStrictEqual(itemFieldsOf('gmail_modify_labels', 'labelIds'), { fields: null, source: null }, 'a list of strings has no item fields, and is not "no fields" either');
});

test('itemFieldsOf falls back to the first sample entry when the shape string has no braced list', () => {
    // calendar_search_events: shape says "array (same as …)", sample is []; unknown.
    assert.deepStrictEqual(itemFieldsOf('calendar_search_events', 'results'), { fields: null, source: null });
    const dw = { _runtimeShapes: {} };
    assert.deepStrictEqual(itemFieldsOf('gmail_search', 'results', dw).source, 'curated');
});

// ── 10: checkLoopRef ─────────────────────────────────────────────────────

test('the measured failure: loop.r.content over a fan-out is repaired to loop.r.output.content', () => {
    const r = checkLoopRef(graph(A1, A2), 'loop.r.content', FE_A2);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.path, 'loop.r.output.content');
    assert.match(r.note, /"loop\.r\.content" read as "loop\.r\.output\.content"/);
    assert.match(r.note, /steps\.a2\.output\.results is \{index, item, output, status\}/);
});

test('a field the plain item does not have is refused with the item shape attached', () => {
    const r = checkLoopRef(graph(A1, A2), 'loop.f.content', FE_A1);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.missing, 'content');
    assert.strictEqual(r.at, 'loop.f.content');
    assert.deepStrictEqual(r.itemFields, NC_ITEM);
    assert.strictEqual(r.fanout, false);
    assert.strictEqual(r.outputFields, null);
    assert.deepStrictEqual(r.upstream, { stepId: 'a1', tool: 'nextcloud_list_files', type: 'integration_action' });
});

test('a known path, a deeper path under a known field, and the bare var all pass without a repair', () => {
    const g = graph(A1, A2);
    assert.deepStrictEqual(checkLoopRef(g, 'loop.r.output.content', FE_A2), { ok: true });
    assert.deepStrictEqual(checkLoopRef(g, 'loop.r.output.meta.pages', FE_A2), { ok: true });
    assert.deepStrictEqual(checkLoopRef(g, 'loop.r.index', FE_A2), { ok: true });
    assert.deepStrictEqual(checkLoopRef(g, 'loop.r.item.name', FE_A2), { ok: true });
    assert.deepStrictEqual(checkLoopRef(g, 'loop.r', FE_A2), { ok: true });
    assert.deepStrictEqual(checkLoopRef(g, 'loop.f.name', FE_A1), { ok: true });
});

test('a deeper path is repaired too, and the envelope name alone is a field of its own', () => {
    const r = checkLoopRef(graph(A1, A2), 'loop.r.meta.pages', FE_A2);
    assert.strictEqual(r.path, 'loop.r.output.meta.pages');
    assert.deepStrictEqual(checkLoopRef(graph(A1, A2), 'loop.r.output', FE_A2), { ok: true });
});

test('output.<unknown> on a fan-out whose output IS described is refused — "output" alone does not cover it', () => {
    const r = checkLoopRef(graph(A1, A2), 'loop.r.output.nope', FE_A2);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.missing, 'output.nope');
    assert.strictEqual(r.fanout, true);
    assert.deepStrictEqual(r.outputFields, NC_READ);
});

test('output.<anything> passes when the fan-out step\'s output shape is unknown', () => {
    const code = { id: 'code', type: 'code', forEach: FE_A1 };
    const fe = { overRef: 'steps.code.output.results', itemVar: 'c' };
    assert.deepStrictEqual(checkLoopRef(graph(A1, code), 'loop.c.output.anything', fe), { ok: true });
    // …but the item half is still known, so item.<unknown> is not.
    assert.strictEqual(checkLoopRef(graph(A1, code), 'loop.c.item.nope', fe).ok, false);
});

test('a name under BOTH output and item is ambiguous, never silently picked', () => {
    const r = checkLoopRef(graph(A1, A2), 'loop.r.path', FE_A2);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.ambiguous, true);
    assert.deepStrictEqual(r.candidates, ['loop.r.output.path', 'loop.r.item.path']);
});

test('unknown shape, a foreign var, no forEach and a non-loop ref are all ok', () => {
    const g = graph(A1, A2, { id: 'dt', type: 'datetime' });
    assert.deepStrictEqual(checkLoopRef(g, 'loop.x.y', { overRef: 'steps.dt.output.items', itemVar: 'x' }), { ok: true });
    assert.deepStrictEqual(checkLoopRef(g, 'loop.q.content', FE_A2), { ok: true }, 'another check owns a mismatched var');
    assert.deepStrictEqual(checkLoopRef(g, 'loop.r.content', undefined), { ok: true });
    assert.deepStrictEqual(checkLoopRef(g, 'steps.a1.output.items', FE_A2), { ok: true });
    assert.deepStrictEqual(checkLoopRef(g, 'loop.x.y', { overRef: 'vars.rows', itemVar: 'x' }), { ok: true });
});

test('the check sees the normalised path and reports it that way', () => {
    const r = checkLoopRef(graph(A1, A2), '$loop[r].content', FE_A2);
    assert.strictEqual(r.path, 'loop.r.output.content');
    assert.match(r.note, /"loop\.r\.content" read as/);
});

// ── describeItem ─────────────────────────────────────────────────────────

test('describeItem phrases a plain item and a fan-out entry', () => {
    const g = graph(A1, A2);
    assert.strictEqual(
        describeItem(fieldsAtRef(g, 'steps.a1.output.items')),
        'the forEach item (an entry of steps.a1.output.items from nextcloud_list_files) has: name, path, type, size, contentType, modified, fileId',
    );
    assert.strictEqual(
        describeItem(fieldsAtRef(g, 'steps.a2.output.results')),
        'the forEach item (an entry of steps.a2.output.results from nextcloud_read_file) is {index, item, output, status}; output has: path, size, contentType, extractedVia, truncated, content, meta',
    );
});

test('describeItem is null for an unknown shape and caps long lists at 20 names', () => {
    assert.strictEqual(describeItem(fieldsAtRef(graph({ id: 'dt', type: 'datetime' }), 'steps.dt.output.items')), null);
    assert.strictEqual(describeItem(null), null);
    const many = Array.from({ length: 25 }, (_, i) => `f${i}`);
    const dw = { _runtimeShapes: { nextcloud_list_files: { items: { _array: Object.fromEntries(many.map(f => [f, 'string'])), _length: 1 } } } };
    const phrase = describeItem(fieldsAtRef(graph(A1), 'steps.a1.output.items', dw));
    assert.ok(phrase.endsWith('f19, …'), phrase);
    assert.ok(!phrase.includes('f20'));
});

test('describeItem names a trigger list without a tool', () => {
    const cal = { trigger: { id: 'trg', kind: 'app_event', appEvent: { provider: 'google-calendar', event: 'event.upcoming' } }, steps: [], edges: [] };
    assert.match(describeItem(fieldsAtRef(cal, 'trigger.output.attendees')), /^the forEach item \(an entry of trigger\.output\.attendees\) has: email/);
});

// ── a forEach upgraded to a repeat ("Koppelingen bijwerken") ─────────────

const { upgradeDefinition } = require('../../shared/mapping/index.mjs');
const { autoBindRequiredInputs } = require('./stepBuilders/inputBindings');

/** A1 → A2 (forEach over A1's items, reading the item's path), and that graph upgraded. */
function beforeAndAfterUpgrade() {
    const a2 = { ...A2, inputs: { path: { kind: 'ref', path: 'loop.f.path' } } };
    const before = graph(A1, a2);
    const lastRun = { trigger: { output: {} }, steps: { a1: { output: { items: [{ name: 'a.pdf', path: '/a.pdf' }] } } } };
    const { definition: after } = upgradeDefinition(before, { lastRun });
    assert.ok(after.steps[1].repeat && !after.steps[1].forEach, 'the forEach became a repeat');
    return { before, after };
}

test('a repeat step is the same fan-out as the forEach it was', () => {
    const { before, after } = beforeAndAfterUpgrade();
    const r = fieldsAtRef(after, 'steps.a2.output.results');
    assert.strictEqual(r.source, 'fanout');
    assert.deepStrictEqual(r.itemFields, NC_ITEM, 'the item fields come from the list the repeat runs over');
    assert.deepStrictEqual(r, fieldsAtRef(before, 'steps.a2.output.results'));
});

test('the next step after a repeat is offered the envelope, never the tool\'s own fields', () => {
    const { before, after } = beforeAndAfterUpgrade();
    const args = g => ({ graph: g, tool: 'nextcloud_read_file', inputs: {}, forEach: null, missing: ['content', 'meta'], afterStepId: 'a2' });
    const got = autoBindRequiredInputs(args(after));
    assert.ok(!got.candidates.some(c => c.why === 'upstream-same-name'), 'steps.a2.output.content does not exist at run time');
    assert.deepStrictEqual(got.candidates.map(c => [c.key, c.path, c.why]), [
        ['content', 'loop.r.output.content', 'needs-forEach'],
        ['meta', 'loop.r.output.meta', 'needs-forEach'],
    ]);
    assert.deepStrictEqual(got, autoBindRequiredInputs(args(before)));
});
