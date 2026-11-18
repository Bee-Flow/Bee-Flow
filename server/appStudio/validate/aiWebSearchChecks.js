// @typecheck strict
'use strict';

/**
 * The validator's web-search rule (appStudio/aiWebSearch.mts): an ai_generate or ai_extract step
 * with `webSearch: true` in an app whose own aiWebSearch switch is off can never run, so the
 * builder hears it as an error now rather than as a failed step later.
 */

/** An ai_generate / ai_extract step that asks for web search in an app whose own switch is off can never run. */
/**
 * @param {{ webSearch?: unknown }} step
 * @param {string} path
 * @param {{ aiWebSearchEnabled?: boolean, pushE: (finding: Record<string, string>) => void }} ctx
 */
function checkAiWebSearch(step, path, ctx) {
    if (step.webSearch !== true || ctx.aiWebSearchEnabled) return;
    ctx.pushE({
        code: 'web_search.not_enabled', severity: 'error', path: `${path}.webSearch`,
        message: 'This AI step asks for web search but web search is not enabled for the app.',
        hint: 'The app OWNER enables it under App settings → What the AI can do (the builder cannot switch it on). Until then, remove webSearch or this step fails.',
    });
}

module.exports = { checkAiWebSearch };
