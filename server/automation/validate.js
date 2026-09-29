/**
 * Validate an automation definition before save / run.
 *
 * Checks:
 *   - Required top-level shape (trigger, steps[], edges[]).
 *   - Each step has a unique id (per graph).
 *   - DAG is acyclic via Kahn's algorithm.
 *   - condition.expr parses under the restricted grammar.
 *   - integration_action.tool is a string (catalog lookup happens at run time).
 *   - Inline layers (`definition.layers`, root-only map of mini-definitions):
 *     map shape + key format, per-layer graph rules (layer_input trigger,
 *     exactly one layer_output, no approval, no nesting), call_layer
 *     references resolve, required layer params are bound, and the
 *     layer-reference graph is acyclic and within the depth cap.
 *
 * Reference paths (`{{steps.x.output.y}}`) are NOT validated as blocking
 * errors. The runtime resolves missing refs to `undefined` safely, and
 * forward refs / typos there shouldn't stop the user from saving or
 * running their automation. They are returned as warnings instead.
 *
 * The rules themselves live in validate/: constants.js (the vocabularies and
 * ceilings), completenessCodes.js (the draft/activate ladder), helpers.js
 * (graph/string plumbing), fieldChecks.js + setOperations.js +
 * piiCategories.js (shared per-step checks), stepRules.js (the per-step-type
 * field rules), graph.js (one graph), callLayer.js / callBlock.js /
 * layerGraph.js (the call references), and definition.js (the whole document).
 * This file is the entry point those modules are reached through.
 */

const { validateDefinition } = require('./validate/definition');
const { COMPLETENESS_CODES } = require('./validate/completenessCodes');
const { topoOrder } = require('./validate/helpers');
const { collectCallLayerSteps } = require('./validate/callLayer');
const { collectCallBlockSteps } = require('./validate/callBlock');
const { LAYER_KEY_RE, MAX_STEPS, MAX_EDGES, MAX_TOTAL_NODES } = require('./validate/constants');

module.exports = { validateDefinition, COMPLETENESS_CODES, topoOrder, collectCallLayerSteps, collectCallBlockSteps, LAYER_KEY_RE, MAX_STEPS, MAX_EDGES, MAX_TOTAL_NODES };
