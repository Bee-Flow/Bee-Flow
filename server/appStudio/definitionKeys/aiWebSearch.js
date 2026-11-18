// @typecheck strict
'use strict';

/**
 * aiWebSearch: { enabled: boolean }, the app's own switch for web search in its AI steps.
 *
 * An ai_generate or ai_extract step with `webSearch: true` may search the web and read pages
 * (appStudio/aiWebSearch.mts) only while this is on. HUMAN-set, like `aiBrowsing` and
 * `allowedLinkHosts`: the builder tools have no way to write it, because a search query can carry
 * the app's record data to the search provider, and that is the owner's decision. The workspace's
 * Web Search integration and a configured search provider are checked on top of it, at run time.
 */

/** @param {unknown} value */
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {unknown} value
 * @param {(code: string, path: string, message: string) => void} push
 */
function canon(value, push) {
    if (!isObject(value)) {
        push('aiWebSearch.invalid', 'aiWebSearch', 'aiWebSearch must be an object { enabled } — dropped.');
        return undefined;
    }
    return { enabled: /** @type {Record<string, unknown>} */ (value).enabled === true };
}

/**
 * @param {unknown} value
 * @param {{ pushE: (finding: Record<string, string>) => void }} ctx
 */
function validate(value, { pushE }) {
    const v = /** @type {Record<string, unknown>} */ (value);
    if (!isObject(value) || typeof v.enabled !== 'boolean' || Object.keys(v).some((k) => k !== 'enabled')) {
        pushE({
            code: 'shape.ai_web_search', severity: 'error', path: 'aiWebSearch',
            message: 'aiWebSearch must be { enabled: true | false }.',
            hint: 'Only a person sets this, in the app settings.',
        });
    }
}

module.exports = {
    key: 'aiWebSearch',
    since: 3,
    canon,
    validate,
    public: false,
    shape: '{ enabled: boolean }',
    description: 'Web search for the AI steps of this app, set by a person only. '
        + 'While enabled, an ai_generate or ai_extract step with webSearch: true may search the web and read public pages. '
        + 'The builder cannot write it: ask the app owner to turn on web search in the app settings.',
};
