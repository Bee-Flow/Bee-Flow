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
