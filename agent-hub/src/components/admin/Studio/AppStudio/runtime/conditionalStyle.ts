/**
 * App Studio runtime: conditional style (package LK15). The rule lists of
 * server/appStudio/componentSpecs/styleRuleShape.js, evaluated with the shared expression engine.
 *
 *   node.styleWhen       applyStyleWhen() lays the knobs of every rule whose formula is true over
 *                        the node's style, in order (a later match wins), before resolveNodeStyle
 *                        translates the result. The editor canvas, the run view and the headless
 *                        render all go through AppRenderer, so they paint the same.
 *   columns[].cellStyle  cellRuleStyle() gives the inline style of one table or data_grid cell,
 *                        with `item` (the row) and `value` (the cell's value) in scope.
 *
 * A formula that fails or is not true leaves the base style. A node or column without a rule list
 * takes none of this code: the node comes back as the same object.
 */

import { tryEvaluate } from '@shared/expr/engine.mjs';
import { resolveBoxFill } from './styleResolver/box';
import { roleTextColor, resolveColor } from './styleResolver/text';
import { ROLE_COLORS, WEIGHT_VALUES } from './styleResolver.constants';
import type { CSSProperties } from 'react';
import type { AppNode, NodeStyle } from '../inspector/appDefinition';

/** One rule as stored. Every part may be missing or wrong in an old or hand-edited definition. */
interface StyleRule {
    when?: { kind?: string; expr?: unknown } | string | null;
    style?: Record<string, unknown> | null;
}

type Scope = Record<string, unknown>;

/** The rules of a list value (anything else: none). */
function rulesOf(value: unknown): StyleRule[] {
    return Array.isArray(value) ? value.filter((r): r is StyleRule => !!r && typeof r === 'object') : [];
}

function exprOf(rule: StyleRule): string | null {
    const when = rule.when;
    if (typeof when === 'string') return when;
    return when && typeof when === 'object' && typeof when.expr === 'string' ? when.expr : null;
}

/** The knobs of the rules that hold, merged in order, and the first formula error. */
export function matchedRuleStyle(rules: unknown, scope: Scope): { style: Record<string, unknown> | null; error: string | null } {
    let style: Record<string, unknown> | null = null;
    let error: string | null = null;
    for (const rule of rulesOf(rules)) {
        const expr = exprOf(rule);
        if (!expr || !rule.style || typeof rule.style !== 'object') continue;
        const r = tryEvaluate(expr, scope);
        if (r.error) {
            error = error || String(r.error);
            continue;
        }
        if (r.value) style = { ...(style || {}), ...rule.style };
    }
    return { style, error };
}

/**
 * The node with its conditional style laid over its style, and the first formula error (for the
 * editor's badge). The same node object when it has no rule list or no rule holds.
 */
export function applyStyleWhen(node: AppNode, scope: Scope): { node: AppNode; error: string | null } {
    if (!Array.isArray(node.styleWhen)) return { node, error: null };
    const { style, error } = matchedRuleStyle(node.styleWhen, scope);
    if (!style) return { node, error };
    return { node: { ...node, style: { ...(node.style || {}), ...style } as NodeStyle }, error };
}

/** A colour knob value as the text of a cell: a role reads in every theme, a hex stays as written. */
function cellTextColor(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    if (Object.hasOwn(ROLE_COLORS, value)) return roleTextColor(value);
    return resolveColor(value);
}

/** The knobs of a cellStyle rule (color, backgroundColor, weight) as CSS. */
function cellCss(style: Record<string, unknown>): CSSProperties {
    const css: CSSProperties = {};
    const color = cellTextColor(style.color);
    if (color) css.color = color;
    const fill = resolveBoxFill(typeof style.backgroundColor === 'string' ? style.backgroundColor : null);
    if (fill) css.background = fill;
    const weight = typeof style.weight === 'string' ? WEIGHT_VALUES[style.weight] : undefined;
    if (weight) css.fontWeight = weight;
    return css;
}

/**
 * The inline style of one cell: `base` (the cell's own), with the knobs of every cellStyle rule
 * that holds for this row and value laid over it. `base` itself when the column has no rules or
 * none holds.
 */
export function cellRuleStyle(rules: unknown, scope: Scope, item: unknown, value: unknown, base: CSSProperties): CSSProperties {
    if (!Array.isArray(rules) || !rules.length) return base;
    const { style } = matchedRuleStyle(rules, { ...scope, item, value });
    return style ? { ...base, ...cellCss(style) } : base;
}
