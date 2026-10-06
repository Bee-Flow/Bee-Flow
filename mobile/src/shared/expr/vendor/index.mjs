/**
 * Shared expression language — single source of truth for both the automation
 * runtime (server, via server/automation/expr.js which re-requires this) and
 * App Studio (client, via the `@shared` Vite alias).
 *
 * See engine.mjs for the grammar + safety model and functions.mjs for the
 * whitelist. Requires Node ≥22.12 on the server (require(esm)); pinned in
 * server/package.json engines.
 */
export {
    parseExpr,
    compile,
    evaluate,
    tryEvaluate,
    collectHostCalls,
    ExprError,
    FUNCTIONS,
    EXPR_FUNCTIONS,
    EXPR_FUNCTION_NAMES,
} from './engine.mjs';
export {
    TOPIC_FN,
    TOPIC_HOST_SPEC,
    MAX_TOPIC_LABELS,
    MAX_TOPIC_LABEL_CHARS,
    MAX_TOPIC_TEXT_CHARS,
    topicLabel,
    normalizeTopicText,
    topicCallsOf,
    makeTopicHost,
} from './topics.mjs';
export { templateText, isScalarList } from './templateText.mjs';
export {
    isIdentifierKey,
    formatKey,
    appendKey,
    appendWildcard,
    appendMatch,
    formatPath,
    readPath,
    parsePath,
    isValidPath,
    canonicalPath,
    pathKeys,
    splitLast,
    parseJsonText,
    extractJsonText,
    stepInto,
    stepMatch,
    jsonCacheFor,
    walkTokens,
    getPath,
    getRelativePath,
    scanTemplate,
    replaceTemplate,
} from './path.mjs';
