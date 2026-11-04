// @typecheck strict
'use strict';

/**
 * call_block: run a reusable building block (a published Step, kind='block')
 * the way the canvas palette's "Steps" group adds one.
 *
 * The step the canvas makes (agent-hub Builder/applyAddNode.ts) is
 * `{type:'call_block', blockId, label, inputs:{}}`; the runner
 * (core/automationRunner/execFlow.execCallBlock) loads the block's PUBLISHED
 * definition, feeds `inputs` into its layer_input params and returns its
 * layer_output fields as the step's output. This builder makes exactly that
 * step, with the inputs bound and checked like every other step's.
 *
 * The gate reads `draftWrap._blocks`, the "Building blocks you may use" list
 * (builderPickerCatalog.buildBlockPickerForUser), with the usual two absent
 * shapes: null/undefined = the list could not be read, so the step is kept as
 * sent (the save-time validator and the run still decide); [] = this user has
 * no building block, so the step is refused. With a list, the id must name a
 * block in it (an exact title is read as its id, said in a note), the block
 * must be usable by this user (every app it touches connected), every input
 * marked required must be bound, and an input name the block does not declare
 * is refused with the real ones, because the runner would drop it silently.
 */

const { newId, appendAfter } = require('../draftGraph');
const { validateAndFixBindings } = require('../bindings');

/**
 * @typedef {{ name: string, type?: string, required?: boolean, description?: string }} BlockInput
 * @typedef {{ id: string, name?: string, description?: string, category?: string | null,
 *   inputs?: BlockInput[], outputs?: string[], available?: boolean }} BlockEntry  one row of the picker list
 */

const isPlainObject = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);
const quoted = (/** @type {BlockEntry} */ b) => `${b.id} ("${b.name || b.id}")`;

/**
 * The block `ref` names: by id, else by an exact (case-insensitive) title when
 * exactly one block carries it.
 * @param {BlockEntry[]} list
 * @param {string} ref
 * @returns {{ block: BlockEntry | null, byTitle: boolean }}
 */
function findBlock(list, ref) {
    const byId = list.find((b) => b.id === ref);
    if (byId) return { block: byId, byTitle: false };
    const lower = ref.toLowerCase();
    const named = list.filter((b) => typeof b.name === 'string' && b.name.trim().toLowerCase() === lower);
    return named.length === 1 ? { block: named[0], byTitle: true } : { block: null, byTitle: false };
}

/**
 * The refusal for a block that is not in the list, or null when it is.
 * @param {BlockEntry[]} list
 * @param {string} blockId
 */
function unknownBlockError(list, blockId) {
    const usable = list.filter((b) => b.available !== false);
    if (!usable.length) {
        return 'This user has no building block they can use, so a call_block step cannot be built. Build the rest of the flow and say in your summary that a reusable Step has to be built and published first. Do not retry.';
    }
    return `No building block with id "${blockId}". Use one of: ${usable.slice(0, 15).map(quoted).join(', ')}${usable.length > 15 ? ', …' : ''}.`;
}

/**
 * Inputs the block does not declare, and required inputs left unbound.
 * @param {BlockEntry} block
 * @param {Record<string, unknown>} inputs
 * @returns {string | null}
 */
function contractError(block, inputs) {
    const declared = (Array.isArray(block.inputs) ? block.inputs : []).filter((p) => p && typeof p.name === 'string');
    const names = new Set(declared.map((p) => p.name));
    const list = declared.length ? declared.map((p) => `${p.name}${p.required ? '*' : ''}`).join(', ') : '(none)';
    const extra = Object.keys(inputs).filter((k) => !names.has(k));
    if (extra.length) {
        return `Building block "${block.name || block.id}" has no input ${extra.map((k) => `"${k}"`).join(', ')}. Its inputs are: ${list} (* = required).`;
    }
    const missing = declared.filter((p) => {
        if (!p.required) return false;
        const b = /** @type {{ kind?: string, value?: unknown } | null | undefined} */ (inputs[p.name]);
        if (b === undefined || b === null) return true;
        return isPlainObject(b) && b.kind === 'literal' && (b.value === '' || b.value === null || b.value === undefined);
    }).map((p) => p.name);
    if (missing.length) {
        return `Building block "${block.name || block.id}" needs ${missing.map((k) => `"${k}"`).join(', ')} bound in inputs (a ref, a template or a non-empty literal). Its inputs are: ${list} (* = required).`;
    }
    return null;
}

/**
 * The block the step names, from the picker list: `{ block }` when it may be
 * used (with a `note` when a title was read as its id), `{ error }` when not.
 * @param {BlockEntry[]} list
 * @param {string} ref
 * @returns {{ block?: BlockEntry, note?: string, error?: string }}
 */
function resolveBlock(list, ref) {
    const found = findBlock(list, ref);
    if (!found.block) return { error: unknownBlockError(list, ref) };
    const block = found.block;
    if (block.available === false) {
        return { error: `Building block ${quoted(block)} uses an app this user has not connected, so it would fail when it runs. Pick another block, or build the steps it needs directly.` };
    }
    return found.byTitle
        ? { block, note: `blockId: read "${ref}" as the id of building block ${quoted(block)}. Pass the id next time.` }
        : { block };
}

/**
 * builder_add_steps {type:"call_block", spec:{blockId, inputs, afterStepId?, branch?, caseName?, label?}}.
 * @param {import('../draftGraph').DraftGraph} graph
 * @param {Record<string, any>} args
 * @param {import('../refCheck').BuilderWrap & { _blocks?: BlockEntry[] | null }} [draftWrap]
 */
function applyAddCallBlock(graph, args, draftWrap) {
    const ref = typeof args.blockId === 'string' ? args.blockId.trim() : '';
    const shapeError = argsError(ref, args.inputs);
    if (shapeError) return { error: shapeError };
    const list = blockList(draftWrap);
    const resolved = list ? resolveBlock(list, ref) : {};
    if (resolved.error) return { error: resolved.error };
    const block = resolved.block || null;
    const { inputs, error, notes: bindNotes } = validateAndFixBindings(args.inputs || {}, graph, { draftWrap });
    if (error) return { error };
    const bad = block ? contractError(block, inputs) : null;
    if (bad) return { error: bad };
    const step = { id: newId('cb'), type: 'call_block', blockId: block ? block.id : ref, inputs, label: stepLabel(args.label, block) };
    appendAfter(graph, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    const warnings = [...(resolved.note ? [resolved.note] : []), ...(bindNotes || [])];
    return { added: step, ...(warnings.length ? { _warnings: warnings } : {}) };
}

/**
 * @param {string} ref
 * @param {unknown} inputs
 */
function argsError(ref, inputs) {
    if (!ref) return 'call_block requires a blockId: an id from the "Building blocks you may use" block. Never invent one.';
    if (inputs !== undefined && inputs !== null && !isPlainObject(inputs)) return 'call_block inputs must be an object map of {inputName: binding}.';
    return null;
}

/**
 * The picker list on the draft wrapper; null when it could not be read.
 * @param {{ _blocks?: BlockEntry[] | null } | undefined} draftWrap
 */
function blockList(draftWrap) {
    const raw = draftWrap ? draftWrap._blocks : null;
    return Array.isArray(raw) ? raw.filter((b) => b && typeof b.id === 'string') : null;
}

/**
 * The model's label, else the block's name, as the canvas labels a new node.
 * @param {unknown} label
 * @param {BlockEntry | null} block
 */
function stepLabel(label, block) {
    const own = typeof label === 'string' ? label.trim() : '';
    return own || (block && block.name) || 'Step';
}

module.exports = { applyAddCallBlock, findBlock };
