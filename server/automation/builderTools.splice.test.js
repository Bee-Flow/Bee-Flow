/**
 * builder_add_* `splice` — insert a step INTO an existing chain instead of
 * fanning it out beside the anchor's current successor.
 *
 * Before this option, "add after X" on a step that already had a successor
 * left the old edge in place: the new step ran in parallel with the old
 * successor, and the only way to put a step in the middle of a chain was
 * remove-and-re-add, which mints a new id and breaks every downstream
 * `steps.<id>.output.*` reference.
 *
 * Run: node --test automation/builderTools.splice.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { applyToolCall, TOOL_SCHEMAS } = require('./builderTools');

const freshWrap = () => ({
    userId: 'u_test',
    def: { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] },
});
const lit = (value) => ({ kind: 'literal', value });
const addSet = (dw, args) => applyToolCall('builder_add_set', { fields: { x: lit(1) }, ...args }, dw);
const edges = (dw) => dw.def.edges.map(e => `${e.from}>${e.to}${e.label ? ':' + e.label : ''}`).sort();
const lastId = (dw) => dw.def.steps[dw.def.steps.length - 1].id;

async function chain(dw) {
    let res = await addSet(dw, { label: 'a' }); assert.ok(!res.error, res.error); const a = lastId(dw);
    res = await addSet(dw, { label: 'b' }); assert.ok(!res.error, res.error); const b = lastId(dw);
    assert.deepStrictEqual(edges(dw), [`${a}>${b}`, `trg>${a}`].sort());
    return { a, b };
}

test('default (no splice): the anchor keeps its successor and the new step fans out beside it', async () => {
    const dw = freshWrap();
    const { a, b } = await chain(dw);
    const res = await addSet(dw, { label: 'mid', afterStepId: a });
    assert.ok(!res.error, res.error);
    const mid = lastId(dw);
    assert.deepStrictEqual(edges(dw), [`${a}>${b}`, `${a}>${mid}`, `trg>${a}`].sort());
});

test('splice:true inserts the new step between the anchor and its successor', async () => {
    const dw = freshWrap();
    const { a, b } = await chain(dw);
    const res = await addSet(dw, { label: 'mid', afterStepId: a, splice: true });
    assert.ok(!res.error, res.error);
    const mid = lastId(dw);
    assert.deepStrictEqual(edges(dw), [`${a}>${mid}`, `${mid}>${b}`, `trg>${a}`].sort());
});

test('splice moves only the matching branch edge of a condition and relabels it plain', async () => {
    const dw = freshWrap();
    await addSet(dw, { label: 'a' }); const a = lastId(dw);
    let res = await applyToolCall('builder_add_condition', { expr: 'true', afterStepId: a }, dw);
    assert.ok(!res.error, res.error);
    const cond = lastId(dw);
    await addSet(dw, { label: 'yes', afterStepId: cond, branch: 'then' }); const yes = lastId(dw);
    await addSet(dw, { label: 'no', afterStepId: cond, branch: 'else' }); const no = lastId(dw);
    res = await addSet(dw, { label: 'first', afterStepId: cond, branch: 'then', splice: true });
    assert.ok(!res.error, res.error);
    const first = lastId(dw);
    assert.deepStrictEqual(edges(dw), [
        `trg>${a}`, `${a}>${cond}`, `${cond}>${first}:then`, `${first}>${yes}`, `${cond}>${no}:else`,
    ].sort());
});

test('splice never moves an on_error edge', async () => {
    const dw = freshWrap();
    const { a, b } = await chain(dw);
    await addSet(dw, { label: 'fallback', afterStepId: a, branch: 'error' }); const fb = lastId(dw);
    const res = await addSet(dw, { label: 'mid', afterStepId: a, splice: true });
    assert.ok(!res.error, res.error);
    const mid = lastId(dw);
    assert.deepStrictEqual(edges(dw), [`trg>${a}`, `${a}>${fb}:on_error`, `${a}>${mid}`, `${mid}>${b}`].sort());
});

test('a spliced-in condition hands the old successor to its then-branch', async () => {
    const dw = freshWrap();
    const { a, b } = await chain(dw);
    const res = await applyToolCall('builder_add_condition', { expr: 'true', afterStepId: a, splice: true }, dw);
    assert.ok(!res.error, res.error);
    const cond = lastId(dw);
    assert.deepStrictEqual(edges(dw), [`trg>${a}`, `${a}>${cond}`, `${cond}>${b}:then`].sort());
});

test('a switch cannot be spliced in - the caller wires nextStepIds instead', async () => {
    const dw = freshWrap();
    const { a } = await chain(dw);
    const before = edges(dw);
    const res = await applyToolCall('builder_add_switch', {
        expr: 'trigger.output.x', cases: [{ name: 'one', value: 1 }], afterStepId: a, splice: true,
    }, dw);
    assert.ok(res.error && /splice/.test(res.error), `expected a splice error, got ${JSON.stringify(res)}`);
    assert.deepStrictEqual(edges(dw), before, 'a refused splice changes nothing');
    assert.ok(!dw.def.steps.some(s => s.type === 'switch'), 'the switch was not added');
});

test('builder_add_steps entries accept splice in their spec', async () => {
    const dw = freshWrap();
    const { a, b } = await chain(dw);
    const res = await applyToolCall('builder_add_steps', {
        steps: [{ tempId: 'mid', type: 'set', spec: { fields: { y: lit(2) }, afterStepId: a, splice: true } }],
    }, dw);
    assert.ok(!res.error, res.error);
    const mid = res.idMap.mid;
    assert.deepStrictEqual(edges(dw), [`${a}>${mid}`, `${mid}>${b}`, `trg>${a}`].sort());
});

test('every tool that offers afterStepId also offers splice', () => {
    for (const t of TOOL_SCHEMAS) {
        const props = t.function.parameters?.properties || {};
        if (!props.afterStepId) continue;
        assert.strictEqual(props.splice?.type, 'boolean', `${t.function.name} lacks splice`);
    }
});

// ── W8: a Condition that works through a list, spliced in ───────────────────

// "Read many" → "Read attachment" (once per attachment of each mail), the
// shape of the demo "Fabrikam attachments by type".
function mailDraft() {
    return {
        userId: 'u_test',
        def: {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'rm', type: 'integration_action', tool: 'gmail_read_many', inputs: {}, label: 'Read many',
                    pinnedOutput: { messages: [{ id: 'm1', from: 'billing@fabrikam.example', attachments: [{ id: 'a1', filename: 'invoice.pdf', mimeType: 'application/pdf' }] }] } },
                { id: 'ra', type: 'integration_action', tool: 'gmail_read_attachment', label: 'Read attachment',
                    forEach: { overRef: 'steps.rm.output.messages[*].attachments', itemVar: 'att', parents: [{ itemVar: 'msg', overRef: 'steps.rm.output.messages' }] },
                    inputs: { attachmentId: { kind: 'ref', path: 'loop.att.id' } } },
            ],
            edges: [{ from: 'trg', to: 'rm' }, { from: 'rm', to: 'ra' }],
        },
    };
}

test('a filter spliced between Read many and Read attachment re-points Read attachment and says so', async () => {
    const dw = mailDraft();
    const res = await applyToolCall('builder_add_array_op', {
        op: 'filter', afterStepId: 'rm', splice: true, arrayRef: 'steps.rm.output.messages', expr: 'contains(item.from, "fabrikam")',
    }, dw);
    assert.ok(!res.error, res.error);
    const f = res.added.id;
    assert.deepStrictEqual(edges(dw), [`${f}>ra`, `rm>${f}`, 'trg>rm'].sort());
    const ra = dw.def.steps.find(s => s.id === 'ra');
    assert.strictEqual(ra.forEach.overRef, `steps.${f}.output.items[*].attachments`);
    assert.deepStrictEqual(ra.forEach.parents, [{ itemVar: 'msg', overRef: `steps.${f}.output.items` }]);
    assert.ok(res._warnings.includes(`Re-pointed ra to read what ${f} keeps: steps.${f}.output.items[*].attachments (it read steps.rm.output.messages).`),
        JSON.stringify(res._warnings));
});

test('builder_add_filter with splice does the same', async () => {
    const dw = mailDraft();
    const res = await applyToolCall('builder_add_filter', { afterStepId: 'rm', splice: true, arrayRef: 'steps.rm.output.messages', expr: 'true' }, dw);
    assert.ok(!res.error, res.error);
    assert.strictEqual(dw.def.steps.find(s => s.id === 'ra').forEach.overRef, `steps.${res.added.id}.output.items[*].attachments`);
});

test('a list switch can be spliced: the old successor moves to its first case and reads it', async () => {
    const dw = mailDraft();
    const res = await applyToolCall('builder_add_switch', {
        afterStepId: 'rm', splice: true, arrayRef: 'steps.rm.output.messages[*].attachments',
        cases: [{ name: 'pdf', expr: 'equals(fileType(item), "pdf")' }, { name: 'word', expr: 'equals(fileType(item), "word")' }],
    }, dw);
    assert.ok(!res.error, res.error);
    const sw = res.added.id;
    assert.deepStrictEqual(dw.def.edges.find(e => e.from === sw), { from: sw, to: 'ra', label: 'case:pdf', caseName: 'pdf' });
    const ra = dw.def.steps.find(s => s.id === 'ra');
    assert.strictEqual(ra.forEach.overRef, `steps.${sw}.output.matchesByCase.pdf`);
    assert.ok(res._warnings.some(w => w.startsWith(`Re-pointed ra to read what ${sw} sends down output "pdf"`)), JSON.stringify(res._warnings));
});

test('a switch without arrayRef is still refused on splice, before anything changes', async () => {
    const dw = mailDraft();
    const before = JSON.stringify(dw.def);
    const res = await applyToolCall('builder_add_switch', { afterStepId: 'rm', splice: true, expr: 'item.kind', cases: [{ name: 'a', value: 'a' }] }, dw);
    assert.match(res.error, /splice is not supported when the new step is a switch without arrayRef/);
    assert.strictEqual(JSON.stringify(dw.def), before);
});

test('a step added after a list Condition reads its output (W2, afterStepId)', async () => {
    const dw = mailDraft();
    const filt = await applyToolCall('builder_add_array_op', { op: 'filter', afterStepId: 'rm', arrayRef: 'steps.rm.output.messages', expr: 'true' }, dw);
    const f = filt.added.id;
    const res = await applyToolCall('builder_add_notification', {
        afterStepId: f, title: 'Mail', body: 'First: {{steps.rm.output.messages[0].from}}',
    }, dw);
    assert.ok(!res.error, res.error);
    assert.strictEqual(res.added.body, `First: {{steps.${f}.output.items[0].from}}`, 'the echo shows the stored step');
    assert.ok(res._warnings.some(w => w.startsWith(`Re-pointed ${res.added.id} to read what ${f} keeps`)));
});

test('builder_update_step moving a step after a list Condition re-points it (W8 move)', async () => {
    const dw = mailDraft();
    const filt = await applyToolCall('builder_add_array_op', { op: 'filter', afterStepId: 'rm', arrayRef: 'steps.rm.output.messages', expr: 'true' }, dw);
    const f = filt.added.id;
    // ra still hangs off rm (the filter was added beside it); move it after the filter.
    const res = await applyToolCall('builder_update_step', { stepId: 'ra', patch: { afterStepId: f } }, dw);
    assert.ok(!res.error, res.error);
    assert.strictEqual(res.updated.forEach.overRef, `steps.${f}.output.items[*].attachments`);
    assert.ok(res._warnings.some(w => w.startsWith(`Re-pointed ra to read what ${f} keeps`)), JSON.stringify(res));
});
