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

// Columns one `orderBy` may name (queryCompilerOrder.MAX_ORDER_BY; bindings.lockstep.test.js holds the two together).
const MAX_ORDER_BY = 3;

/**
 * Query vocabulary of the record / records / aggregate bindings (and of the
 * step filters that share their grammar) that came after schema version 2.
 * Each is optional and absent from a definition that does not use it:
 *   orderBy            [{ field, dir? }] on up to MAX_ORDER_BY columns; `sort`
 *                      keeps reading its first entry only
 *   filter.all / .not  { all: [entry, …] } and { not: entry } groups, and
 *                      groups inside groups (to filterGroups.MAX_FILTER_DEPTH);
 *                      a flat list and a one-level { any: [clauses] } are the base
 *   filter.otherField  { field, op, otherField }: two columns of one row compared
 */
const BINDING_QUERY_EXTENSIONS = Object.freeze([
    Object.freeze({ key: 'orderBy', since: 3 }),
    Object.freeze({ key: 'filter.all', since: 3 }),
    Object.freeze({ key: 'filter.not', since: 3 }),
    Object.freeze({ key: 'filter.nested', since: 3 }),
    Object.freeze({ key: 'filter.otherField', since: 3 }),
]);

module.exports = {
    MAX_ORDER_BY,
    BINDING_QUERY_EXTENSIONS,
    BINDING_KINDS,
    INPUT_MAPPING_KINDS,
    FORMULA_SCOPE_ROOTS,
    CURRENT_USER_KEYS,
};
