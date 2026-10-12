/**
 * Built-in step TYPES that get mistaken for catalog tools.
 *
 * `http_request` is a step type — the runner dispatches it directly
 * (core/automationRunner/execution.js → execOutbound.execHttpRequest) and it
 * appears in no integration's TOOL_REGISTRY entry. When an AI builder passes it
 * as `builder_add_action({tool:'http_request'})` the draft gains a step
 * `{type:'integration_action', tool:'http_request'}` that nothing can dispatch,
 * and the runner reported it as a revoked permission — sending the user to an
 * admin who has nothing to toggle. Same for `set`, `ai_step`, `notification`
 * and every other type below.
 *
 * WHY DETECTION LOOKS LIKE THIS. The tempting test is "is this name in
 * TOOL_REGISTRY?", and it is wrong: a user's real tool set is assembled per
 * request in core/integrations/integrationTools.js and includes four classes
 * that no static list can know — MCP server tools, org custom integrations,
 * agent-callable automations and Step tools, plus the inline-registered
 * `browse_web` and workspace tools. Testing registry absence would reject those
 * legitimate tools. This map instead recognises only names we KNOW are step
 * types, so callers can fail closed on a certain mistake and stay open on
 * everything they cannot know.
 *
 * Callers should still check their own catalog FIRST and only consult this map
 * for a tool the catalog does not know (see applyAddAction). That ordering is
 * what keeps a third-party MCP tool that happens to be called `filter` working.
 *
 * STEP_TYPES reads the step-type table (builderTools/stepTypeTable.js), the same
 * list ADD_FOR_TYPE is built from; builtinStepTools.test.js asserts the two agree.
 */
const { REPLACEABLE_STEP_TYPES } = require('./builderTools/stepTypeTable');

/**
 * Every built-in step type the builder can create: the keys of ADD_FOR_TYPE,
 * which are the REPLACEABLE_STEP_TYPES of the step-type table (a pure data
 * module, so this one can import it where it cannot import stepBuilders).
 * data_extraction, for instance, is a step type like ai_step: nothing for an
 * admin to toggle, so a model reaching for builder_add_action({tool:'data_extraction'})
 * is redirected to builder_add_data_extraction rather than told about permissions.
 */
const STEP_TYPES = new Set(REPLACEABLE_STEP_TYPES);

/**
 * Step types whose builder tool is not simply `builder_add_<type>`.
 * `guard`, `tokenize` and `untokenize` have no add tool at all — they are made
 * in a builder_add_steps batch — so they map to null and the caller falls back to
 * a generic hint.
 */
const TOOL_NAME_OVERRIDES = {
    integration_action: 'builder_add_action',
    code: 'builder_add_code_step',
    guard: null,
    tokenize: null,
    untokenize: null,
    // The five array ops each have a builder_add_<type> tool, but the unified
    // builder_add_array_op is the one small models are given (CORE_TOOL_NAMES),
    // so point every one of them at it.
    filter: 'builder_add_array_op',
    limit: 'builder_add_array_op',
    dedupe: 'builder_add_array_op',
    aggregate: 'builder_add_array_op',
    summarize: 'builder_add_array_op',
    flatten: 'builder_add_array_op',
};

/** Names a model reaches for that are not step types either, but mean one. */
const ALIASES = {
    webhook: 'http_request',
    api_call: 'http_request',
    array_op: 'filter',
};

/** @returns {boolean} true when `name` is a built-in step type, not a tool. */
function isBuiltinStepType(name) {
    if (!name || typeof name !== 'string') return false;
    return STEP_TYPES.has(name) || Object.prototype.hasOwnProperty.call(ALIASES, name);
}

/**
 * The builder tool that creates this step type.
 * @returns {string|null} e.g. 'builder_add_http_request', or null when the type
 *   has no dedicated add tool (or `name` is not a step type at all).
 */
function builderToolForStepType(name) {
    if (!isBuiltinStepType(name)) return null;
    const type = Object.prototype.hasOwnProperty.call(ALIASES, name) ? ALIASES[name] : name;
    if (Object.prototype.hasOwnProperty.call(TOOL_NAME_OVERRIDES, type)) return TOOL_NAME_OVERRIDES[type];
    return `builder_add_${type}`;
}

module.exports = { STEP_TYPES, ALIASES, isBuiltinStepType, builderToolForStepType };
