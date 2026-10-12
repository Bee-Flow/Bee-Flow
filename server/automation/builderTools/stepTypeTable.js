/**
 * Which step types can the AI builder AUTHOR, and how? ONE table.
 *
 * Three hand-kept lists used to answer this and had drifted apart: the type enum
 * of builder_add_steps / builder_replace_step (schemas.js), the ADD_FOR_TYPE map
 * the apply paths dispatch on (stepBuilders/index.js), and the step list in the
 * prompt (builderPrompt.js). `guard` and `tokenize` had an apply function and
 * were in no enum and no prompt, `return_to_app` was taught by the prompt and
 * had no tool, and the validator's VALID_STEP_TYPES knew a dozen types none of
 * them mentioned. Now they all read this file:
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
const STEP_TYPE_TABLE = Object.freeze([
    { type: 'integration_action', authoring: 'batch' },
    { type: 'ai_step', authoring: 'batch' },
    { type: 'data_extraction', authoring: 'batch' },
    { type: 'condition', authoring: 'batch' },
    { type: 'switch', authoring: 'batch' },
    { type: 'notification', authoring: 'batch' },
    { type: 'set', authoring: 'batch' },
    { type: 'http_request', authoring: 'batch' },
    { type: 'datatable', authoring: 'batch' },
    { type: 'generate_document', authoring: 'batch' },
    { type: 'fill_document', authoring: 'batch' },
    { type: 'slide', authoring: 'batch' },
    { type: 'presentation', authoring: 'batch' },
    // `builderOnly`: a family the builder dispatches on `op` (filter, limit, ...),
    // not a runtime step type of its own.
    { type: 'array_op', authoring: 'batch', replace: false, builderOnly: true },
    { type: 'code', authoring: 'batch' },
    { type: 'datetime', authoring: 'batch' },
    { type: 'wait', authoring: 'batch' },
    { type: 'stop_error', authoring: 'batch' },
    { type: 'form_page', authoring: 'batch' },
    { type: 'approval', authoring: 'batch' },
    { type: 'call_layer', authoring: 'batch' },
    { type: 'knowledge_write', authoring: 'batch' },
    { type: 'loop', authoring: 'batch' },
    { type: 'filter', authoring: 'batch', family: 'array_op' },
    { type: 'limit', authoring: 'batch', family: 'array_op' },
    { type: 'dedupe', authoring: 'batch', family: 'array_op' },
    { type: 'aggregate', authoring: 'batch', family: 'array_op' },
    { type: 'summarize', authoring: 'batch', family: 'array_op' },
    { type: 'flatten', authoring: 'batch', family: 'array_op' },
    // The Privacy Shield steps (core/automationRunner/execPrivacy.js): a plain
    // `sourceRef` path string, no binding object.
    { type: 'guard', authoring: 'batch' },
    { type: 'tokenize', authoring: 'batch' },
    { type: 'untokenize', authoring: 'batch' },

    { type: 'note', authoring: 'tool', tool: 'builder_add_note' },

    { type: 'trigger', authoring: 'managed', via: 'builder_propose_trigger / builder_add_trigger' },
    { type: 'layer_output', authoring: 'managed', via: 'builder_create_layer / builder_set_layer_contract' },

    { type: 'parse_json', authoring: 'retired' },

    // `reason` = why the builder cannot make it; `behaviour` = what an existing
    // one does, so the model reads a draft that holds one correctly.
    {
        type: 'parallel', authoring: 'canvas_only',
        reason: 'branches are drawn on the canvas; no builder tool lays them out',
        behaviour: 'its branches run side by side. Two steps wired from the same step already do that.',
    },
    {
        type: 'call_block', authoring: 'canvas_only',
        reason: 'the builder is not given the list of reusable Steps (ids and parameters), so it could only guess',
        behaviour: 'it calls a reusable Step and returns that Step\'s outputs.',
    },
    {
        type: 'return_to_app', authoring: 'canvas_only',
        reason: 'it names screens of the Studio App that started the run, and the builder is not given the app\'s screen ids',
        behaviour: 'TERMINAL: it ends the run and hands the app a screen to open, a message and what to refresh. Nothing after it ever runs, so never wire anything to its output; never inside a loop, a parallel branch or a flowlet.',
    },
]);

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
const ARRAY_OP_FAMILY = Object.freeze(typesWhere((e) => e.family === 'array_op'));

module.exports = {
    STEP_TYPE_TABLE,
    ARRAY_OP_FAMILY,
    BATCH_STEP_TYPES,
    REPLACEABLE_STEP_TYPES,
    CANVAS_ONLY_STEP_TYPES,
    canvasOnlyMenu,
};
