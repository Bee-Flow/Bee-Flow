// @typecheck
'use strict';
/**
 * The collaborators of one call into a "Find repeating work" module: the real
 * ones, each loaded on first use, with whatever the caller passed in their
 * place. A test hands in its stores and model this way and never touches the
 * module system; a collaborator it replaced is never loaded.
 *
 *   const LOADERS = { llmClient: () => require('../../core/llm/llmClient') };
 *   async function run(input, overrides = null) {
 *       const d = depsWith(LOADERS, overrides);
 *       await d.llmClient.chatForcedTool(…);
 *   }
 *
 * An override that is `undefined` counts as not given; `null` is a value
 * (for example "no PII guard installed").
 */

const { lazyDeps } = require('../../core/meetingNotes/lazyDeps');

/**
 * @template {Record<string, () => any>} L
 * @param {L} loaders
 * @param {Record<string, any>|null|undefined} overrides
 * @returns {{ [K in keyof L]: ReturnType<L[K]> }}
 */
function depsWith(loaders, overrides) {
    const { deps, init } = lazyDeps(loaders);
    init(/** @type {any} */ (Object.fromEntries(Object.entries(overrides || {}).filter(([, v]) => v !== undefined))));
    return deps;
}

module.exports = { depsWith };
