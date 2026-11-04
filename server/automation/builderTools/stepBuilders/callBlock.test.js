'use strict';

/**
 * call_block from the assistant: a reusable building block (a published Step)
 * added the way the canvas palette adds one, through builder_add_steps, checked
 * against the "Building blocks you may use" list on the draft wrapper.
 *
 * What is pinned:
 *   - the step has the canvas shape {type:'call_block', blockId, inputs, label};
 *   - an unknown id, an empty list, a block on an app the user lacks, a missing
 *     required input and an input the block does not declare are refused with
 *     the real names; an exact title is read as the id, said in a note;
 *   - no list (could not read) is permissive;
 *   - the block's outputs are the step's output shape, so a later ref is checked;
 *   - replace and patch reach the type; the save-time validator gets the list.
 *
 * Run: cd server && node --test automation/builderTools/stepBuilders/callBlock.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyToolCall, emptyDefinition } = require('../../builderTools');
const { applyAddCallBlock, findBlock } = require('./callBlock');
const { blocksByIdOf } = require('../persistence');
const { validateDefinition } = require('../../validate');

const BLOCKS = () => [
    {
        id: 'blk_vat', name: 'Check VAT number', description: 'Looks a VAT number up', category: null,
        inputs: [{ name: 'vat', type: 'string', required: true, description: '' }, { name: 'country', type: 'string', required: false, description: '' }],
        outputs: ['valid', 'company'], available: true,
    },
    { id: 'blk_mail', name: 'Mail digest', description: '', category: null, inputs: [], outputs: ['sent'], available: false },
];

async function wrapWithForm(blocks = BLOCKS()) {
    const wrap = { userId: 'u', def: emptyDefinition(), _blocks: blocks };
    await applyToolCall('builder_propose_trigger', { kind: 'form', form: { fields: [{ name: 'vat', type: 'text' }] } }, wrap);
    return wrap;
}

test('builder_add_steps builds the canvas shape: blockId, bound inputs, the block\'s name as label', async () => {
    const wrap = await wrapWithForm();
    const r = await applyToolCall('builder_add_steps', { steps: [
        { tempId: 'chk', type: 'call_block', spec: { blockId: 'blk_vat', inputs: { vat: { kind: 'ref', path: 'trigger.output.vat' } } } },
    ] }, wrap);
    assert.ok(!r.error, r.error);
    const step = wrap.def.steps.find((s) => s.type === 'call_block');
    assert.equal(step.blockId, 'blk_vat');
    assert.equal(step.label, 'Check VAT number');
    assert.deepEqual(step.inputs.vat, { kind: 'ref', path: 'trigger.output.vat' });
    assert.ok(wrap.def.edges.some((e) => e.to === step.id), 'wired after the trigger');
});

test('refusals name the real blocks and inputs', () => {
    const graph = emptyDefinition();
    const wrap = { _blocks: BLOCKS() };
    assert.match(applyAddCallBlock(graph, {}, wrap).error, /requires a blockId/);
    const unknown = applyAddCallBlock(graph, { blockId: 'blk_nope' }, wrap).error;
    assert.match(unknown, /No building block with id "blk_nope"\. Use one of: blk_vat \("Check VAT number"\)/);
    assert.ok(!unknown.includes('blk_mail'), 'a block the user cannot run is not offered');
    assert.match(applyAddCallBlock(graph, { blockId: 'blk_mail' }, wrap).error, /uses an app this user has not connected/);
    assert.match(applyAddCallBlock(graph, { blockId: 'blk_vat', inputs: {} }, wrap).error, /needs "vat" bound in inputs[^\n]*Its inputs are: vat\*, country/);
    assert.match(applyAddCallBlock(graph, { blockId: 'blk_vat', inputs: { vat: { kind: 'literal', value: '' } } }, wrap).error, /needs "vat" bound/);
    assert.match(applyAddCallBlock(graph, { blockId: 'blk_vat', inputs: { vat: 'NL1', vatNumber: 'x' } }, wrap).error, /has no input "vatNumber"\. Its inputs are: vat\*, country/);
    assert.match(applyAddCallBlock(graph, { blockId: 'blk_vat', inputs: 'vat' }, wrap).error, /inputs must be an object map/);
    assert.equal(graph.steps.length, 0, 'nothing was added');
});

test('an empty list refuses the step outright; no list at all keeps it as sent', () => {
    assert.match(applyAddCallBlock(emptyDefinition(), { blockId: 'blk_vat' }, { _blocks: [] }).error, /no building block they can use[^\n]*Do not retry/);
    const graph = emptyDefinition();
    const r = applyAddCallBlock(graph, { blockId: 'blk_unknown', inputs: { a: 'x' } }, { _blocks: null });
    assert.ok(!r.error, r.error);
    assert.equal(r.added.blockId, 'blk_unknown');
    assert.equal(r.added.label, 'Step');
});

test('an exact title is read as the block\'s id, and the note says so', () => {
    const graph = emptyDefinition();
    const r = applyAddCallBlock(graph, { blockId: 'check vat NUMBER', inputs: { vat: 'NL1' } }, { _blocks: BLOCKS() });
    assert.ok(!r.error, r.error);
    assert.equal(r.added.blockId, 'blk_vat');
    assert.ok(r._warnings.some((w) => /read "check vat NUMBER" as the id of building block blk_vat/.test(w)));
    assert.equal(findBlock(BLOCKS(), 'Mail').block, null, 'a partial title is not a match');
});

test('the block\'s outputs are the step\'s output shape: a later ref to a real output passes, a typo gets the real name', async () => {
    const wrap = await wrapWithForm();
    const r = await applyToolCall('builder_add_steps', { steps: [
        { tempId: 'chk', type: 'call_block', spec: { blockId: 'blk_vat', inputs: { vat: { kind: 'ref', path: 'trigger.output.vat' } } } },
        { tempId: 'ok', type: 'set', spec: { fields: { company: { kind: 'ref', path: 'steps.$chk.output.company' } } } },
        { tempId: 'typo', type: 'set', spec: { fields: { v: { kind: 'ref', path: 'steps.$chk.output.vaild' } } } },
    ] }, wrap);
    assert.ok(!r.error, r.error);
    const said = (r._warnings || []).join('\n');
    assert.ok(!/output\.company/.test(said), 'a declared output is not questioned');
    assert.match(said, /Did you mean steps\.[a-z0-9_]+\.output\.valid\?/, 'the misspelt output is answered with the real one');
});

test('builder_replace_step turns a step into a call_block; builder_update_step patches its inputs', async () => {
    const wrap = await wrapWithForm();
    await applyToolCall('builder_add_steps', { steps: [{ tempId: 'n', type: 'set', spec: { fields: { t: { kind: 'literal', value: 'x' } } } }] }, wrap);
    const id = wrap.def.steps[0].id;
    const rep = await applyToolCall('builder_replace_step', { stepId: id, newType: 'call_block', spec: { blockId: 'blk_vat', inputs: { vat: { kind: 'ref', path: 'trigger.output.vat' } } } }, wrap);
    assert.ok(!rep.error, rep.error);
    assert.equal(wrap.def.steps[0].type, 'call_block');
    assert.equal(wrap.def.steps[0].id, id, 'same id, same wiring');
    const upd = await applyToolCall('builder_update_step', { stepId: id, patch: { inputs: { country: { kind: 'literal', value: 'NL' } } } }, wrap);
    assert.ok(!upd.error, upd.error);
    assert.deepEqual(wrap.def.steps[0].inputs.country, { kind: 'literal', value: 'NL' });
});

test('the save-time validator gets the same list: a known block passes, an unknown one is named', () => {
    const def = {
        trigger: { id: 't', kind: 'manual' },
        steps: [{ id: 'cb', type: 'call_block', blockId: 'blk_vat', inputs: { vat: { kind: 'literal', value: 'NL1' } } }],
        edges: [{ from: 't', to: 'cb' }],
    };
    const availableBlocks = blocksByIdOf(BLOCKS());
    assert.deepEqual(Object.keys(availableBlocks), ['blk_vat', 'blk_mail']);
    assert.ok(!validateDefinition(def, { availableBlocks }).errors.some((e) => e.code.startsWith('call_block.')));
    const gone = validateDefinition({ ...def, steps: [{ ...def.steps[0], blockId: 'blk_gone' }] }, { availableBlocks });
    assert.ok(gone.errors.some((e) => e.code === 'call_block.unknown_block'));
    assert.equal(blocksByIdOf(null), null, 'no list: the structural check only');
});
