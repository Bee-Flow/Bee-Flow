// @typecheck strict
/**
 * App Studio catalog — the binding kinds and the formula scope: which value
 * shapes a prop or step field may carry, and which roots an expression may read.
 */

'use strict';

// ---------------------------------------------------------------------------
// Bindings & actions
// ---------------------------------------------------------------------------

// v1 binding kinds: static, actionResult. v2 adds data-oriented kinds:
//   formula   — { kind:'formula', expr }               (compiled, never executed)
//   record    — { kind:'record', tableId, recordId?, path? }
//   records   — { kind:'records', tableId, filter?, sort?, limit? }
//   dataset   — { kind:'dataset', datasetId, params? }
//   connector — { kind:'connector', connectorId, params? }  where each param is
//               a literal or { kind:'formula', expr } (client-resolved, then
//               POSTed to the connector-run endpoint — the connector executes
//               acts-as-owner server-side).
//   aggregate  — { kind:'aggregate', tableId, filter?, groupBy?, aggregates?,
//               sort?, limit?, pick? }. groupBy/aggregates use EXACTLY the
//               descriptor the server's compileAggregate already validates, so
//               there is no second vocabulary to keep in sync. This is what
//               makes "count per status" or "median first response" one binding
//               instead of an automation.
const BINDING_KINDS = ['static', 'actionResult', 'formula', 'record', 'records', 'dataset', 'connector', 'aggregate'];
// A binding kind added after the base is listed here with the schema version
// that introduced it ({ kind: 3 }); BINDING_KINDS is a list of names and has no
// entry to carry it. Null-prototype: only own keys are kinds.
/** @type {Record<string, number>} */
const BINDING_KIND_SINCE = Object.create(null);
const INPUT_MAPPING_KINDS = ['static', 'field'];

// The ONLY root identifiers a formula/filter expression may reference. A root
// outside this set is a WARNING (unknown_formula_root) — the expr still
// compiles, but it will resolve to undefined at runtime. Keep in lockstep with
// the runtime scope object the executor (sibling wave) builds.
const FORMULA_SCOPE_ROOTS = [
    'actions',      // { [actionId]: <last result> }
    'form',         // current form field values
    'forms',        // { [formName]: values }
    'screen',       // current screen params
    'vars',         // set_variable state
    'item',         // current repeater/loop item
    'index',        // current repeater/loop index
    'value',        // current field/binding value
    'params',       // call_action params inside a called action ({} otherwise)
    'error',        // inside a step's onError handler: { message, step, code, attempts } (null otherwise)
    'currentUser',  // { id, name, roles, ... }
    'records',      // { [tableId]: rows }
    'datasets',     // { [datasetId]: rows }
    'connectors',   // { [connectorId]: rows } — external connector results
    'now',          // Date.now() ms
    'today',        // ISO date string
];

/**
 * The `currentUser` attributes a formula may read.
 *
 * Lives here — with the rest of the vocabulary — rather than next to the
 * executor, because BOTH sides need it: actionExecutor.buildServerScope builds
 * exactly these keys, and validate.js rejects a formula that asks for anything
 * else. They drifted once already: the editor's scope panel offered
 * `currentUser.name`, the browser resolved it, and the server had only `id` and
 * `roles` — so every audit row an action wrote recorded an empty "Who", and
 * nothing anywhere said so.
 */
const CURRENT_USER_KEYS = ['id', 'name', 'email', 'roleKey', 'isOwner', 'roles'];

module.exports = {
    BINDING_KINDS,
    BINDING_KIND_SINCE,
    INPUT_MAPPING_KINDS,
    FORMULA_SCOPE_ROOTS,
    CURRENT_USER_KEYS,
};
