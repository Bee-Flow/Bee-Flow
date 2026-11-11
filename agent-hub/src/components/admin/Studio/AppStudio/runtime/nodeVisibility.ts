import { tryEvaluate } from '@shared/expr/engine.mjs';
import type { ExpressionScope } from './RuntimeContext';
import type { FlagInput } from './AppRenderer.types';

/** The two flags a node's visibility is read from (an AppNode, or a raw tab definition). */
export interface VisibilityFlags {
    visible?: FlagInput;
    visibleWhen?: FlagInput;
}

/**
 * Resolve a boolean-or-formula flag against the live scope.
 * → { set:false } when the flag is absent, else { set:true, value, error }.
 *
 * ── WHY THIS TAKES THREE SHAPES ─────────────────────────────────────
 * These flags reach the renderer as `{kind:'formula', expr}`. That is the ONLY
 * expression shape that survives a save: canonicalize.cleanBoolOrFormula keeps
 * a boolean or a formula OBJECT and drops a bare string, and builderTools
 * .normalizeLogicValue wraps the AI's string into the same object before it is
 * ever stored. So both authoring paths — the Logic inspector and the AI builder
 * — persist the object.
 *
 * This function used to accept only the bare STRING, which meant every "Only
 * show when" and "Enabled when" rule in every saved app did nothing at all: the
 * component stayed visible and enabled for everybody, including the rules
 * written to hide things from people who should not see them. Every test
 * covering these used the string form, so the gap was invisible from both
 * sides. The string is still accepted — a definition held in memory before its
 * first save can carry one — but the object is the shape that matters.
 */
export function evalBoolFlag(raw: FlagInput, scope: ExpressionScope) {
    if (raw === undefined || raw === null) return { set: false };
    if (typeof raw === 'boolean') return { set: true, value: raw, error: null };
    const expr = (raw && typeof raw === 'object') ? (raw.expr ?? raw.value) : raw;
    if (typeof expr === 'string' && expr.trim()) {
        const r = tryEvaluate(expr, scope);
        return { set: true, value: !!r.value, error: r.error };
    }
    return { set: false };
}

/** { hidden, error }. visibleWhen wins; else boolean/formula `visible`. */
export function evalVisibility(node: VisibilityFlags, scope: ExpressionScope) {
    const when = evalBoolFlag(node.visibleWhen, scope);
    if (when.set) return { hidden: !when.value, error: when.error };
    const v = evalBoolFlag(node.visible, scope);
    if (v.set) return { hidden: !v.value, error: v.error };
    return { hidden: false, error: null };
}

