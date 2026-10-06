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
    getList,
    getRelativePath,
    scanTemplate,
    replaceTemplate,
} from './path.mjs';
export {
    splitTopLevel,
    splitCallArgs,
    findTopLevelSymbol,
    textContains,
    textStartsWith,
    textEndsWith,
    isEmptyValue,
    equalsValue,
    QUANTIFIER_FN,
    QUANTIFIER_OF_FN,
    TEST_OF_OP,
    OP_OF_TEST,
    UNARY_TESTS,
    elementPasses,
    quantify,
    FILE_TYPE_KEYS,
    fileTypeOf,
    isFileRecord,
    fileTypesNamedIn,
    fileTypeField,
    fieldShape,
    quantifiedCall,
    readQuantifiedCall,
    singularKey,
    ruleFieldOptions,
} from './rules.mjs';
export {
    isListRoute,
    routeListPath,
    routeOutputPaths,
    rebaseRefs,
    stepReadsPath,
    followRouteAround,
    followRouteEdit,
    staleSuccessors,
    followSuccessors,
    switchCaseChanges,
    relabelSwitchEdges,
} from './routeFollow.mjs';
export { isWholeRunRoute, wholeRunListReads, loopsAfterWholeRun } from './wholeRun.mjs';
export { listPathLabel } from './pathLabel.mjs';
