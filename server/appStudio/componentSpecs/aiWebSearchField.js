// @typecheck strict
/**
 * App Studio catalog: the `webSearch` field of the native AI steps (ai_generate, ai_extract),
 * schema v3, optional. With `true` the step's model gets agent_search and read_url
 * (appStudio/aiWebSearch.mts), but only while the app's own aiWebSearch switch is on.
 *
 * Plain .js like the rest of componentSpecs: agent-hub's tests and typecheck load this directory.
 */

'use strict';

const AI_WEB_SEARCH_FIELD = {
    type: 'boolean', since: 3,
    description: 'Lets this AI step search the web and read public pages before it answers. '
        + 'Runs only while the app owner has turned on web search in the app settings (aiWebSearch, which the builder cannot write), '
        + 'and the workspace allows web search. Leave it out for an answer from the step\'s own data.',
};

/**
 * The field table with `webSearch` added at its end, in place, like withAiReliability: ACTION_SPECS
 * and STEP_SPECS share the AI field tables, so both get the field.
 * @template {Record<string, unknown>} T
 * @param {T} fields
 * @returns {T & { webSearch: typeof AI_WEB_SEARCH_FIELD }}
 */
function withAiWebSearch(fields) {
    return Object.assign(fields, { webSearch: AI_WEB_SEARCH_FIELD });
}

module.exports = { AI_WEB_SEARCH_FIELD, withAiWebSearch };
