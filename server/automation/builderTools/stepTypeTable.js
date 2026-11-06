// @typecheck strict
/**
 * Which step types can the AI builder AUTHOR, and how? ONE table.
 *
 * Three hand-kept lists would answer this and drift apart: the type enum
 * of builder_add_steps / builder_replace_step (schemas.js), the ADD_FOR_TYPE map
 * the apply paths dispatch on (stepBuilders/index.js), and the step list in the
 * prompt (builderPrompt.js). Drift looks like `guard` and `tokenize` having an apply function and
 * being in no enum and no prompt, `return_to_app` being taught by the prompt and
 * having no tool, and the validator's VALID_STEP_TYPES knowing a dozen types none of
 * them mention. So they all read this file:
 *
 *   - the batch enum is BATCH_STEP_TYPES, the replace enum REPLACEABLE_STEP_TYPES;
 *   - ADD_FOR_TYPE is built FROM the table and refuses to load when a table entry
 *     has no builder (or a builder has no entry);
 *   - the prompt names the canvas-only types from here (canvasOnlyNotice) and
 *     teaches nothing that is not in `authoring: 'batch'`;
 *   - stepTypeTable.test.js compares the table with the validator's
 *     VALID_STEP_TYPES, so a new runtime step type cannot be added without
 *     deciding, here, whether the builder can make it.
 *
 * `family` and `userLabel` say where a person finds the step and what it is
 * called there: the canvas ribbon's tab (agent-hub flow/ribbon/ribbonCategories.ts
 * CATEGORY_DEFS, in that order; `start` is the empty canvas's "how it starts"
 * cards, `apps` the suite and Other apps tabs) and the palette's label
 * (flow/nodeDefs.ts, flow/stepPalette.ts). Kept by hand: the client is ESM
 * TypeScript the server cannot load. builderPrompt/stepFamilies.js renders the
 * "What you can build" block from them, so the model speaks the user's words.
 * `opFamily: 'array_op'` marks the list operations `array_op` dispatches on `op`.
 *
 * `authoring`:
 *   batch        creatable in builder_add_steps (and builder_replace_step, except
 *                `array_op`, which is a family dispatched on `op`);
 *   tool         has its own single-step tool and is deliberately not in the batch
 *                (a note is never wired, so it has no place in a chain);
 *   managed      created by another tool as part of something else (the trigger
 *                tools, builder_create_layer);
 *   retired      still readable in old definitions, no longer authorable;
 *   canvas_only  the runtime supports it and the builder cannot make it, with the
 *                `reason` the model is told. The model leaves an existing one alone.
 *
 * Pure data: no requires, so schemas.js, the prompt and the tests can all load it.
 */

'use strict';

// Order = the order the batch enum has always had, then the Privacy Shield
// steps. `replace: false` keeps a type out of builder_replace_step's enum.
/**
 * @typedef {'start' | 'ai' | 'logic' | 'people' | 'data' | 'apps' | 'blocks'} StepFamily
 * @typedef {{ type: string, authoring: string, replace?: boolean, opFamily?: string, builderOnly?: boolean,
 *   family?: StepFamily, userLabel?: string, tool?: string, via?: string,
 *   reason?: string, behaviour?: string }} StepTypeEntry
 */

/** @type {readonly StepTypeEntry[]} */
const STEP_TYPE_TABLE = Object.freeze([
    { type: 'integration_action', authoring: 'batch', family: 'apps', userLabel: 'An app\'s action' },
    { type: 'ai_step', authoring: 'batch', family: 'ai', userLabel: 'AI step' },
    { type: 'data_extraction', authoring: 'batch', family: 'ai', userLabel: 'Extract data' },
    { type: 'condition', authoring: 'batch', family: 'logic', userLabel: 'Condition' },
    { type: 'switch', authoring: 'batch', family: 'logic', userLabel: 'Condition' },
    { type: 'notification', authoring: 'batch', family: 'people', userLabel: 'Notification' },
    { type: 'set', authoring: 'batch', family: 'data', userLabel: 'Edit data' },
    { type: 'http_request', authoring: 'batch', family: 'logic', userLabel: 'Call a web service' },
    { type: 'datatable', authoring: 'batch', family: 'data', userLabel: 'Datatable' },
    { type: 'generate_document', authoring: 'batch', family: 'data', userLabel: 'Make a document' },
    { type: 'fill_document', authoring: 'batch', family: 'data', userLabel: 'Fill a document' },
    { type: 'slide', authoring: 'batch', family: 'data', userLabel: 'Slide' },
    { type: 'presentation', authoring: 'batch', family: 'data', userLabel: 'Presentation' },
    // `builderOnly`: a family the builder dispatches on `op` (filter, limit, ...),
    // not a runtime step type of its own. The ribbon's "Lists" pill holds its members.
    { type: 'array_op', authoring: 'batch', replace: false, builderOnly: true, family: 'data', userLabel: 'Lists' },
    { type: 'code', authoring: 'batch', family: 'logic', userLabel: 'Code' },
    { type: 'datetime', authoring: 'batch', family: 'data', userLabel: 'Date & time' },
    { type: 'wait', authoring: 'batch', family: 'people', userLabel: 'Wait' },
    { type: 'stop_error', authoring: 'batch', family: 'logic', userLabel: 'Stop with an error' },
    { type: 'form_page', authoring: 'batch', family: 'people', userLabel: 'Form page' },
    { type: 'approval', authoring: 'batch', family: 'people', userLabel: 'Ask someone to approve' },
    { type: 'call_layer', authoring: 'batch', family: 'blocks', userLabel: 'Flowlet' },
    { type: 'knowledge_write', authoring: 'batch', family: 'data', userLabel: 'To knowledge base' },
    { type: 'kb_query_log', authoring: 'batch', family: 'data', userLabel: 'Knowledge base query log' },
    { type: 'loop', authoring: 'batch', family: 'logic', userLabel: 'Repeat for each' },
    { type: 'filter', authoring: 'batch', opFamily: 'array_op', family: 'data', userLabel: 'Filter a list' },
    { type: 'limit', authoring: 'batch', opFamily: 'array_op', family: 'data', userLabel: 'Shorten list' },
    { type: 'dedupe', authoring: 'batch', opFamily: 'array_op', family: 'data', userLabel: 'Remove duplicates' },
    { type: 'aggregate', authoring: 'batch', opFamily: 'array_op', family: 'data', userLabel: 'Collect one field' },
    { type: 'summarize', authoring: 'batch', opFamily: 'array_op', family: 'data', userLabel: 'Add up or count' },
    { type: 'flatten', authoring: 'batch', opFamily: 'array_op', family: 'data', userLabel: 'Flatten a list' },
    // The Privacy Shield steps (core/automationRunner/execPrivacy.js): a plain
    // `sourceRef` path string, no binding object. One "Privacy Shield" entry on
    // the canvas, three modes in its editor.
    { type: 'guard', authoring: 'batch', family: 'logic', userLabel: 'Privacy Shield: find personal data' },
    { type: 'tokenize', authoring: 'batch', family: 'logic', userLabel: 'Privacy Shield: hide personal data' },
    { type: 'untokenize', authoring: 'batch', family: 'logic', userLabel: 'Privacy Shield: show real values again' },
    // Tables as first-class data: open an uploaded spreadsheet / CSV as tables,
    // and edit a table without code (builderTools/stepBuilders/tableSteps.js).
    { type: 'read_table', authoring: 'batch', family: 'data', userLabel: 'Read table' },
    { type: 'table', authoring: 'batch', family: 'data', userLabel: 'Edit table' },
    // A reusable building block (a published Step, kind='block') by its id, from
    // the "Building blocks you may use" list (builderPickerCatalog.js); no
    // single-step tool (stepBuilders/callBlock.js).
    { type: 'call_block', authoring: 'batch', family: 'blocks', userLabel: 'Step' },

    { type: 'note', authoring: 'tool', tool: 'builder_add_note', family: 'logic', userLabel: 'Note' },

    { type: 'trigger', authoring: 'managed', via: 'builder_propose_trigger / builder_add_trigger', family: 'start', userLabel: 'How it starts' },
    { type: 'layer_output', authoring: 'managed', via: 'builder_create_layer / builder_set_layer_contract', family: 'blocks', userLabel: 'Flowlet output' },

    { type: 'parse_json', authoring: 'retired' },

    // `reason` = why the builder cannot make it; `behaviour` = what an existing
    // one does, so the model reads a draft that holds one correctly.
    {
        type: 'parallel', authoring: 'canvas_only', family: 'logic', userLabel: 'Parallel',
        reason: 'branches are drawn on the canvas; no builder tool lays them out',
        behaviour: 'its branches run side by side. Two steps wired from the same step already do that.',
    },
    {
        type: 'return_to_app', authoring: 'canvas_only', family: 'logic', userLabel: 'Back to the app',
        reason: 'it names screens of the Studio App that started the run, and the builder is not given the app\'s screen ids',
        behaviour: 'TERMINAL: it ends the run and hands the app a screen to open, a message and what to refresh. Nothing after it ever runs, so never wire anything to its output; never inside a loop, a parallel branch or a flowlet.',
    },
]);

/** @param {(entry: StepTypeEntry) => boolean} pred */
const typesWhere = (pred) => STEP_TYPE_TABLE.filter(pred).map((e) => e.type);

/** The `type` enum of builder_add_steps. */
const BATCH_STEP_TYPES = Object.freeze(typesWhere((e) => e.authoring === 'batch'));

/** The `newType` enum of builder_replace_step, and the keys of ADD_FOR_TYPE. */
const REPLACEABLE_STEP_TYPES = Object.freeze(typesWhere((e) => e.authoring === 'batch' && e.replace !== false));

/** [{type, reason, behaviour}] — what the runtime runs and the builder cannot create. */
const CANVAS_ONLY_STEP_TYPES = Object.freeze(STEP_TYPE_TABLE
    .filter((e) => e.authoring === 'canvas_only')
    .map(({ type, reason, behaviour }) => Object.freeze({ type, reason, behaviour })));

/**
 * The step-menu entries for the canvas-only types, one per type, in the same
 * shape as the creatable entries around them (two spaces, the type, a dash). They
 * say plainly that the model cannot create the step AND what an existing one does,
 * so it neither tries nor promises one, and still reads a draft that has one (a
 * terminal step ends the run: nothing may be wired after it).
 */
function canvasOnlyMenu() {
    const lines = CANVAS_ONLY_STEP_TYPES.map((e) => `  ${e.type.padEnd(16)} — CANVAS-ONLY, you cannot create it (${e.reason}). If the request needs one, build the rest and say in your summary what is left for the canvas; leave an existing one untouched. If a draft has one: ${e.behaviour}`);
    return lines.join('\n');
}

/** The step types the single `builder_add_array_op` tool covers by `op`. */
const ARRAY_OP_FAMILY = Object.freeze(typesWhere((e) => e.opFamily === 'array_op'));

module.exports = {
    STEP_TYPE_TABLE,
    ARRAY_OP_FAMILY,
    BATCH_STEP_TYPES,
    REPLACEABLE_STEP_TYPES,
    CANVAS_ONLY_STEP_TYPES,
    canvasOnlyMenu,
};
