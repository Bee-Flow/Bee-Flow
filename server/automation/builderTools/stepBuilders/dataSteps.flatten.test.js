/**
 * The AI builder's "Flatten a list" (spec J3, F51-F55): builder_add_array_op
 * op "flatten" with its sugar, the plan from the source's sample, editing,
 * the field pickers after it, and the MCP surface.
 *
 * Run: cd server && node --test automation/builderTools/stepBuilders/dataSteps.flatten.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyToolCall, emptyDefinition } = require('../../builderTools');
const { fieldsAtRef } = require('../outputFields');
const { buildToolList } = require('../../mcpBuilder');
const { summariseDefinition, renderAgentDraftState } = require('../../summarise');
const { validateDefinition } = require('../../validate');
const { FLATTEN_MAIL_STEP } = require('../../../shared/expr/corpus.mjs');
const { flattenRows } = require('../../expr');

async function mailDraft() {
    const dw = { userId: 'u_test', def: emptyDefinition() };
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const r = await applyToolCall('builder_add_action', { tool: 'gmail_read_many', inputs: { messageIds: { kind: 'literal', value: ['m1'] } } }, dw);
    return { dw, rm: r.added.id };
}

const flatten = (dw, args) => applyToolCall('builder_add_array_op', { op: 'flatten', ...args }, dw);
const planOf = (parents) => parents.map(({ itemVar, auto, fields }) => ({ itemVar, auto, fields }));
const J1_PLAN = planOf(FLATTEN_MAIL_STEP.parents);

test('J3: arrayRef + childField stores the route and the J1 plan, with the plan sentence', async () => {
    const { dw, rm } = await mailDraft();
    const r = await flatten(dw, { arrayRef: `steps.${rm}.output.messages`, childField: 'attachments', afterStepId: rm });
    assert.equal(r.error, undefined);
    assert.equal(r.added.type, 'flatten');
    assert.equal(r.added.arrayRef, `steps.${rm}.output.messages[*].attachments`);
    assert.equal(r.added.label, 'One row per attachment');
    assert.equal(r.added.parents[0].overRef, `steps.${rm}.output.messages`);
    assert.deepEqual(planOf(r.added.parents), J1_PLAN);
    assert.equal(r.note, 'Flatten: one row per attachment (from each message: from, to, subject, date; messageId and threadId come with each attachment)');
    const v = validateDefinition(dw.def);
    assert.deepEqual([...v.errors, ...v.warnings].map(e => e.code).filter(c => c.startsWith('flatten.')), []);
});

test('the route itself, a repaired route and a bare outer list all land on the same step', async () => {
    for (const ref of ['messages[*].attachments', 'messages[*].attachments[*]', 'messages.attachments', 'messages']) {
        const { dw, rm } = await mailDraft();
        const r = await flatten(dw, { arrayRef: `steps.${rm}.output.${ref}` });
        assert.equal(r.error, undefined, ref);
        assert.equal(r.added.arrayRef, `steps.${rm}.output.messages[*].attachments`, ref);
        assert.deepEqual(planOf(r.added.parents), J1_PLAN, ref);
    }
});

test('F15: keepFields copies exactly those, keeps the fills, and sets auto false', async () => {
    const { dw, rm } = await mailDraft();
    const r = await flatten(dw, { arrayRef: `steps.${rm}.output.messages`, childField: 'attachments', keepFields: ['from', 'subject', 'nope'] });
    assert.deepEqual(r.added.parents[0].fields, [
        { from: 'from', to: 'from', mode: 'copy' },
        { from: 'subject', to: 'subject', mode: 'copy' },
        { from: 'id', to: 'messageId', mode: 'fill' },
        { from: 'threadId', to: 'threadId', mode: 'fill' },
    ]);
    assert.equal(r.added.parents[0].auto, false);
    assert.match(r._warnings.join(' '), /nope/);
});

async function httpDraft() {
    const dw = { userId: 'u_test', def: emptyDefinition() };
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const h = await applyToolCall('builder_add_http_request', { url: 'https://api.contoso.example/orders', method: 'GET' }, dw);
    return { dw, h: h.added.id };
}

test('F16/F28: a source without a sample stores levels without fields, so the run copies the parent fields', async () => {
    const { dw, h } = await httpDraft();
    const r = await flatten(dw, { arrayRef: `steps.${h}.output.body.orders`, childField: 'lines', keepEmpty: true });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.added.parents, [{ overRef: `steps.${h}.output.body.orders`, itemVar: 'order', auto: true }]);
    assert.equal(r.added.keepEmpty, true);
    assert.equal(r.added.label, 'One row per line');
    assert.match(r.note, /from each order: picked from the run's data/);
    const runState = { steps: { [h]: { output: { body: { orders: [{ id: 'o1', customer: 'Fabrikam BV', lines: [{ id: 'l1', sku: 'x' }] }] } } } } };
    assert.deepEqual(flattenRows(runState, r.added).items, [{ id: 'l1', sku: 'x', orderId: 'o1', customer: 'Fabrikam BV' }]);
    const v = validateDefinition(dw.def);
    assert.ok(v.warnings.some(w => w.code === 'flatten.columns_unsaved'));
});

test('keepFields without a sample names the nearest level by the generic-key rule and says it could not check them', async () => {
    const { dw, h } = await httpDraft();
    const r = await flatten(dw, { arrayRef: `steps.${h}.output.body.orders`, childField: 'lines', keepFields: ['id', 'customer'] });
    assert.deepEqual(r.added.parents[0].fields, [{ from: 'id', to: 'orderId', mode: 'copy' }, { from: 'customer', to: 'customer', mode: 'copy' }]);
    assert.equal(r.added.parents[0].auto, false);
    assert.match(r._warnings.join(' '), /no sample/);
});

test('a child list called items is labelled One row per item', async () => {
    const { dw, h } = await httpDraft();
    const r = await flatten(dw, { arrayRef: `steps.${h}.output.body.orders`, childField: 'items' });
    assert.equal(r.added.label, 'One row per item');
});

test('a bare outer list without an inner list is refused with what to pass', async () => {
    const dw = { userId: 'u_test', def: emptyDefinition() };
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const h = await applyToolCall('builder_add_http_request', { url: 'https://api.contoso.example/orders', method: 'GET' }, dw);
    const r = await flatten(dw, { arrayRef: `steps.${h.added.id}.output.body.orders` });
    assert.match(r.error, /childField/);
});

test('F53: builder_update_step re-plans on childField / keepFields and refuses parents that do not fit', async () => {
    const { dw, rm } = await mailDraft();
    const { added } = await flatten(dw, { arrayRef: `steps.${rm}.output.messages`, childField: 'attachments' });
    let r = await applyToolCall('builder_update_step', { stepId: added.id, patch: { keepFields: ['subject'], keepEmpty: true, maxItems: 50 } }, dw);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.updated.parents[0].fields.filter(f => f.mode === 'copy').map(f => f.from), ['subject']);
    assert.equal(r.updated.keepEmpty, true);
    assert.equal(r.updated.maxItems, 50);
    assert.equal('keepFields' in r.updated, false);
    r = await applyToolCall('builder_update_step', { stepId: added.id, patch: { parents: [{ overRef: 'steps.x.output.y', itemVar: 'message', fields: [] }] } }, dw);
    assert.match(r.error, /parents does not fit/);
    r = await applyToolCall('builder_update_step', { stepId: added.id, patch: { childField: 'labelIds' } }, dw);
    assert.equal(r.error, undefined);
    assert.equal(r.updated.arrayRef, `steps.${rm}.output.messages[*].labelIds`);
    assert.equal(r.updated.label, 'One row per labelId');
    assert.equal('childField' in r.updated, false);
});

test('F52: builder_add_steps builds a flatten entry like the array_op tool does', async () => {
    const { dw, rm } = await mailDraft();
    const r = await applyToolCall('builder_add_steps', {
        steps: [{ tempId: 'flat', type: 'flatten', spec: { arrayRef: `steps.${rm}.output.messages`, childField: 'attachments' } }],
    }, dw);
    assert.equal(r.error, undefined, r.error);
    const step = dw.def.steps.find(s => s.type === 'flatten');
    assert.deepEqual(planOf(step.parents), J1_PLAN);
});

test('F46: the field picker and the loop check know the rows of a flatten', async () => {
    const { dw, rm } = await mailDraft();
    const { added } = await flatten(dw, { arrayRef: `steps.${rm}.output.messages`, childField: 'attachments' });
    const at = fieldsAtRef(dw.def, `steps.${added.id}.output.items`, dw);
    assert.deepEqual(at.fields, ['attachmentId', 'filename', 'mimeType', 'size', 'canOCR', 'messageId', 'threadId', 'from', 'to', 'subject', 'date']);
    const r = await applyToolCall('builder_add_action', {
        tool: 'gmail_read_attachment',
        forEach: { overRef: `steps.${added.id}.output.items`, itemVar: 'r' },
        inputs: { messageId: { kind: 'ref', path: 'loop.r.messageId' }, attachmentId: { kind: 'ref', path: 'loop.r.attachmentId' }, filename: { kind: 'ref', path: 'loop.r.filename' } },
    }, dw);
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.added.inputs.attachmentId.path, 'loop.r.attachmentId');
});

test('F55: MCP offers flatten on builder_add_array_op with its sugar', () => {
    const tool = buildToolList().find(t => t.name === 'builder_add_array_op');
    const props = tool.inputSchema.properties;
    assert.ok(props.op.enum.includes('flatten'));
    for (const k of ['childField', 'keepFields', 'keepEmpty']) assert.ok(props[k], k);
});

test('the agent-facing summary says what a flatten makes', async () => {
    const { dw, rm } = await mailDraft();
    await flatten(dw, { arrayRef: `steps.${rm}.output.messages`, childField: 'attachments' });
    assert.match(summariseDefinition(dw.def).summary, /Make one row per attachment of messages \(copies from, to, subject, date\)\./);
    assert.match(renderAgentDraftState(dw.def), /flatten one row per attachment of messages \(copies from, to, subject, date\) over `steps\.[a-z0-9_]+\.output\.messages\[\*\]\.attachments`/);
});

test('F54: the builder prompt (and so the MCP guide) teaches flatten for a table of attachments', () => {
    const { buildFullSystemPrompt } = require('../../builderPrompt');
    const prompt = buildFullSystemPrompt({ catalog: { tools: [] }, codeStepEnabled: false });
    assert.ok(prompt.includes('array_op         — filter/limit/dedupe/aggregate/summarize/flatten'));
    assert.ok(prompt.includes('builder_add_array_op({op:"flatten", arrayRef:"steps.<readMany>.output.messages", childField:"attachments"})'));
    assert.ok(prompt.includes('Google Sheets append still needs `forEach` per row.'));
});
