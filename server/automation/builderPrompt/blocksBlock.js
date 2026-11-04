// @typecheck strict
'use strict';

/**
 * "Building blocks you may use": the reusable Steps (published kind='block'
 * automations) a call_block step may run, with each block's inputs and
 * outputs, so the model binds them like any other step instead of leaving the
 * block for the canvas.
 *
 * A sibling of catalogRender.js's picker blocks (agents, knowledge bases), in
 * the same four renderings and for the same reasons:
 *   undefined/null  → ''      the caller never asked (an MCP draft load)
 *   blocksError     → the "could not read" marker, never the "none" line
 *   no usable block → the "none" line
 *   [rows]          → one line per usable block, capped with an "and N more" line.
 * A block that touches an app this user has not connected (`available:false`)
 * is left out, as the canvas palette leaves it out.
 *
 * Rendered into the late dynamic message (builderPrompt.renderPickerContextMessage),
 * never the system prompt: the list changes when somebody publishes a block.
 * Pure and order-preserving.
 */

// Blow-up guards. When one bites the render says so: a list that stops and
// looks complete is how a model concludes a block does not exist.
const BLOCKS_CAP = 30;
const INPUTS_PER_BLOCK = 20;
const OUTPUTS_PER_BLOCK = 20;
const DESCRIPTION_CHARS = 100;

/**
 * @param {unknown} v
 * @param {number} max
 */
const oneLine = (v, max) => {
    const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * @param {unknown[]} list
 * @param {number} cap
 * @param {(item: any) => string} fmt
 */
const capped = (list, cap, fmt) => {
    const shown = list.slice(0, cap).map(fmt).join(', ');
    return list.length > cap ? `${shown}, …+${list.length - cap} more` : shown;
};

/**
 * @typedef {import('../builderPickerCatalog').BlockRow} BlockRow
 * @param {BlockRow} b
 */
function blockLine(b) {
    const inputs = Array.isArray(b.inputs) ? b.inputs.filter(p => p && p.name) : [];
    const outputs = Array.isArray(b.outputs) ? b.outputs.filter(Boolean) : [];
    const desc = b.description ? ` · ${oneLine(b.description, DESCRIPTION_CHARS)}` : '';
    const ins = inputs.length ? capped(inputs, INPUTS_PER_BLOCK, p => `${p.name}${p.required ? '*' : ''} (${p.type || 'string'})`) : '(none)';
    const outs = outputs.length ? capped(outputs, OUTPUTS_PER_BLOCK, String) : '(none declared)';
    return `- ${b.id} · "${oneLine(b.name || b.id, 60)}"${desc}\n  inputs: ${ins} · outputs: ${outs}`;
}

/**
 * @param {{ blocks?: BlockRow[] | null, blocksError?: string | null } | null | undefined} catalog
 * @returns {string}
 */
function renderBlocksBlock(catalog) {
    if (!catalog || catalog.blocks === undefined || catalog.blocks === null) return '';
    const head = '## Building blocks you may use';
    if (catalog.blocksError) {
        return `${head}\n\n_(the list of building blocks could not be read just now — do not guess a blockId and do not tell the user they have none. Build the flow from the other steps, or ask the user to try again.)_`;
    }
    const usable = (Array.isArray(catalog.blocks) ? catalog.blocks : []).filter(b => b && b.id && b.available !== false);
    if (!usable.length) {
        return `${head}\n\n_(none — this user has no published building block they can use, so a call_block step cannot be built. Do not invent one.)_`;
    }
    const more = usable.length - BLOCKS_CAP;
    const moreLine = more > 0 ? `\n…and ${more} more building block${more === 1 ? '' : 's'} not listed — ask the user for the block's name rather than guessing an id.` : '';
    // The worked example names a REAL block from the list, as the datatables
    // block does: a prompt that says "never invent an id" must not show one.
    const ex = usable[0];
    const exInput = (ex.inputs || []).find(p => p && p.required) || (ex.inputs || [])[0];
    const exInputs = exInput ? `${exInput.name}:{kind:"ref", path:"steps.x.output.y"}` : '';
    const exOut = (ex.outputs || [])[0] || '<output>';
    return `${head} (call_block blockId — an id from this list, never invented)

${usable.slice(0, BLOCKS_CAP).map(blockLine).join('\n')}${moreLine}

A call_block step: {type:"call_block", spec:{blockId:"${ex.id}", inputs:{${exInputs}}}}. Bind every input marked * (a ref, a template or a literal); an input the block does not list is refused. Read what it returns as steps.<id>.output.${exOut}. A building block cannot call another building block.`;
}

module.exports = { renderBlocksBlock, BLOCKS_CAP };
