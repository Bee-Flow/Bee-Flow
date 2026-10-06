/**
 * The expression language the automation runtime evaluates — conditions,
 * filters, `{{ }}` formulas — for the flow editor on the phone.
 *
 * `vendor/` holds the engine VERBATIM: agent-hub/src/shared/expr and
 * server/shared/expr are one file in two places, and this is the third copy.
 * Metro cannot import from agent-hub, so the files are copied, and
 * exprVendor.lockstep.test.ts fails the moment any copy differs by a byte.
 * Never edit the .mjs files here; copy the web's over them.
 *
 * This facade adds types and one helper. The engine itself has no dependencies,
 * so the phone can check an expression exactly as the server will run it.
 */

import { ExprError, compile } from './vendor/index.mjs';

export {
    EXPR_FUNCTION_NAMES,
    EXPR_FUNCTIONS,
    ExprError,
    FUNCTIONS,
    compile,
    evaluate,
    parseExpr,
    tryEvaluate,
} from './vendor/index.mjs';
export type { ExprFunction, ExprFunctionDoc, ExprNode, ExprPathSegment } from './vendor/index.mjs';

// The value-path grammar the runtime resolves (vendor/path.mjs): build paths
// with appendKey, read them with getPath, scan {{ }} with scanTemplate.
export {
    appendKey,
    appendMatch,
    appendWildcard,
    canonicalPath,
    extractJsonText,
    formatKey,
    formatPath,
    getList,
    getPath,
    getRelativePath,
    isIdentifierKey,
    isValidPath,
    parseJsonText,
    parsePath,
    pathKeys,
    readPath,
    replaceTemplate,
    scanTemplate,
    splitLast,
    stepInto,
    stepMatch,
    walkTokens,
} from './vendor/index.mjs';
export type { PathToken, TemplatePart } from './vendor/index.mjs';

// How a value reads inside a `{{ }}` placeholder (vendor/templateText.mjs):
// a list of plain values joined, anything else as JSON — what the run writes.
export { isScalarList, templateText } from './vendor/index.mjs';

// The Condition node's rules (vendor/rules.mjs): equals, File type, the
// any / every / no quantifiers, and the rule-shape text helpers the rule rows
// are read from and written with.
export {
    FILE_TYPE_KEYS,
    OP_OF_TEST,
    QUANTIFIER_FN,
    QUANTIFIER_OF_FN,
    TEST_OF_OP,
    UNARY_TESTS,
    elementPasses,
    equalsValue,
    fieldShape,
    fileTypeField,
    fileTypeOf,
    fileTypesNamedIn,
    findTopLevelSymbol,
    isEmptyValue,
    isFileRecord,
    quantifiedCall,
    quantify,
    readQuantifiedCall,
    ruleFieldOptions,
    singularKey,
    splitCallArgs,
    splitTopLevel,
    textContains,
    textEndsWith,
    textStartsWith,
} from './vendor/index.mjs';
export type {
    FileTypeKey,
    QuantifierFunction,
    RuleFieldNode,
    RuleFieldOption,
    RuleFieldOptionsOpts,
    RuleFieldShape,
    RuleQuantifier,
} from './vendor/index.mjs';

// Follow the route (vendor/routeFollow.mjs): a step after a Condition that
// works through a list reads what that Condition keeps. And a whole-run
// Condition that reads a list (vendor/wholeRun.mjs).
export {
    followRouteAround,
    followRouteEdit,
    followSuccessors,
    isListRoute,
    isWholeRunRoute,
    loopsAfterWholeRun,
    rebaseRefs,
    relabelSwitchEdges,
    routeListPath,
    routeOutputPaths,
    staleSuccessors,
    stepReadsPath,
    switchCaseChanges,
    wholeRunListReads,
} from './vendor/index.mjs';
export type { RouteDefinition, RouteRebound } from './vendor/index.mjs';

// A path as a person reads it (vendor/pathLabel.mjs), shared with the web builder.
export { listPathLabel } from './vendor/index.mjs';

/** What `checkExpr` says about an expression, without running it. */
export type ExprCheck =
    | { ok: true; refs: string[] }
    | { ok: false; message: string; index: number | null };

/**
 * Parse an expression and name the roots it reads (`steps`, `trigger`, …),
 * or say where it breaks. Never throws, never evaluates: the editor calls it
 * on every keystroke.
 */
export function checkExpr(src: string): ExprCheck {
    try {
        return { ok: true, refs: compile(src).refs };
    } catch (e) {
        if (e instanceof ExprError) {
            return { ok: false, message: e.message, index: typeof e.index === 'number' ? e.index : null };
        }
        return { ok: false, message: e instanceof Error ? e.message : String(e), index: null };
    }
}
