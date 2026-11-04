'use strict';

/**
 * "Building blocks you may use" (blocksBlock.js): the four renderings of a
 * picker list, a worked example built from a REAL block, the cap said out loud,
 * and the block riding along in the late dynamic message.
 *
 * Run: cd server && node --test automation/builderPrompt/blocksBlock.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderBlocksBlock, BLOCKS_CAP } = require('./blocksBlock');
const { renderPickerBlocks, renderBlocksBlock: reExported } = require('./catalogRender');

const BLOCK = (over) => ({
    id: 'blk_vat', name: 'Check VAT number', description: 'Looks a VAT\nnumber up', category: null,
    inputs: [{ name: 'vat', type: 'string', required: true, description: '' }, { name: 'country', type: 'string', required: false, description: '' }],
    outputs: ['valid', 'company'], available: true, ...over,
});

test('not asked, could not read, none: three different answers', () => {
    assert.equal(renderBlocksBlock(null), '');
    assert.equal(renderBlocksBlock({ blocks: undefined }), '');
    const failed = renderBlocksBlock({ blocks: [], blocksError: 'db down' });
    assert.match(failed, /could not be read just now — do not guess a blockId and do not tell the user they have none/);
    const none = renderBlocksBlock({ blocks: [BLOCK({ available: false })], blocksError: null });
    assert.match(none, /_\(none — this user has no published building block they can use, so a call_block step cannot be built\. Do not invent one\.\)_/);
});

test('a list: one line per usable block with its inputs and outputs, and an example that names a real one', () => {
    const text = renderBlocksBlock({ blocks: [BLOCK(), BLOCK({ id: 'blk_off', name: 'Off', available: false })], blocksError: null });
    assert.ok(text.startsWith('## Building blocks you may use (call_block blockId — an id from this list, never invented)\n\n'));
    assert.match(text, /- blk_vat · "Check VAT number" · Looks a VAT number up\n {2}inputs: vat\* \(string\), country \(string\) · outputs: valid, company/);
    assert.ok(!text.includes('blk_off'), 'a block on an app the user lacks is left out, as on the canvas');
    assert.match(text, /\{type:"call_block", spec:\{blockId:"blk_vat", inputs:\{vat:\{kind:"ref", path:"steps\.x\.output\.y"\}\}\}\}/);
    assert.match(text, /steps\.<id>\.output\.valid/);
});

test('a block with no inputs or outputs still renders, and the cap says how many it cut', () => {
    const bare = renderBlocksBlock({ blocks: [BLOCK({ inputs: [], outputs: [], description: '' })], blocksError: null });
    assert.match(bare, /- blk_vat · "Check VAT number"\n {2}inputs: \(none\) · outputs: \(none declared\)/);
    const many = Array.from({ length: BLOCKS_CAP + 2 }, (_, i) => BLOCK({ id: `blk_${i}` }));
    const text = renderBlocksBlock({ blocks: many, blocksError: null });
    assert.match(text, /…and 2 more building blocks not listed/);
    assert.ok(!text.includes(`blk_${BLOCKS_CAP}`));
});

test('the same list renders the same bytes, and it rides in the picker message', () => {
    const catalog = { blocks: [BLOCK()], blocksError: null };
    assert.equal(renderBlocksBlock(catalog), renderBlocksBlock(structuredClone(catalog)));
    assert.equal(reExported, renderBlocksBlock);
    const msg = renderPickerBlocks({ ...catalog, knowledgeBases: [], knowledgeBasesError: null });
    assert.ok(msg.indexOf('## Knowledge bases you may use') < msg.indexOf('## Building blocks you may use'));
    assert.equal(renderPickerBlocks({ apps: [] }), '', 'not asked: nothing');
});
