/**
 * App Studio validator: the contrast warning of boxContrast.mts for the colour pairs schema 3
 * adds (package W3-D). One more pass with the same helper, the same code (style.low_contrast)
 * and the same model (a fill against the text on it, in the light and the dark theme the scope
 * shows), over:
 *
 *   tokens      a `token:<name>` colour (design.tokens) as the fill or as the text colour of a
 *               node's own style that sets both (an authored pair; a pair of plain values is
 *               boxContrast's). A token fill under the theme text is not measured here: stored
 *               apps already carry such fills and would gain a warning.
 *   styleWhen   each rule laid over the node's style, when it sets the fill or the text colour
 *   cellStyle   each rule of a table or data_grid column that sets a cell fill, against the
 *               rule's text colour or the theme text
 *
 * The component variants count through nodeShowsFill (an outlined card paints no fill). Text
 * without a fill is not measured: its ground is a surface the theme draws, not an authored
 * colour. Only warnings: the definition saves and publishes. A definition without these keys
 * gets no finding from here.
 */

import { createRequire } from 'node:module';
import { isHexColor, lowContrastWarning, nodeShowsFill, pairFailure, eachSectionNode } from './boxContrast.mts';
import type { Finding } from './boxContrast.mts';

type Obj = Record<string, unknown>;
type Push = (rec: Finding) => void;

const nodeRequire = createRequire(import.meta.url);
const { tokenNameOf } = nodeRequire('../componentSpecs/colorValue.js') as { tokenNameOf: (v: unknown) => string | null };

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

const RULE_HINT = 'This rule changes the fill or the text colour when its condition is true, and the pair it makes is hard to read. Pick a fill and a text colour that read together in the light and the dark theme, or fix theme.appearance to light or dark.';

/** The hex colours of design.tokens, by name. */
function colourTokens(def: Obj): Map<string, string> {
    const tokens = isObj(def.design) && isObj(def.design.tokens) ? def.design.tokens : {};
    return new Map(Object.entries(tokens).filter((e): e is [string, string] => isHexColor(e[1])));
}

interface Ctx { tokens: Map<string, string>; theme: unknown; pushW: Push }

/** A knob value with its token resolved; an unknown token stays as written (and is not measured). */
function resolve(value: unknown, tokens: Map<string, string>): unknown {
    const name = tokenNameOf(value);
    return name !== null && tokens.has(name) ? tokens.get(name) : value;
}

/** Warn at `path` when the fill and text colour of `style` (tokens resolved) read below AA. */
function checkPair(style: Obj, path: string, label: string, ctx: Ctx, hint?: string): void {
    const fill = resolve(style.backgroundColor, ctx.tokens);
    if (!isHexColor(fill)) return;
    const failure = pairFailure(fill, resolve(style.color, ctx.tokens), ctx.theme);
    if (failure) ctx.pushW(lowContrastWarning(path, label, fill, failure, hint));
}

/** Does `rule` change the fill or the text colour of `base` (tokens resolved)? */
function changesPair(rule: Obj, base: Obj, tokens: Map<string, string>): boolean {
    return (['backgroundColor', 'color'] as const).some((k) => rule[k] !== undefined && resolve(rule[k], tokens) !== resolve(base[k], tokens));
}
const usesToken = (style: Obj): boolean => tokenNameOf(style.backgroundColor) !== null || tokenNameOf(style.color) !== null;

function checkNode(node: Obj, path: string, ctx: Ctx): void {
    const base = isObj(node.style) ? node.style : {};
    if (nodeShowsFill(node)) {
        if (usesToken(base) && base.color !== undefined) checkPair(base, `${path}.style.backgroundColor`, 'backgroundColor', ctx);
        const rules = Array.isArray(node.styleWhen) ? node.styleWhen : [];
        rules.forEach((rule, r) => {
            if (!isObj(rule) || !isObj(rule.style) || !changesPair(rule.style, base, ctx.tokens)) return;
            checkPair({ ...base, ...rule.style }, `${path}.styleWhen[${r}].style`, 'The fill', ctx, RULE_HINT);
        });
    }
    const columns = isObj(node.props) && Array.isArray(node.props.columns) ? node.props.columns : [];
    columns.forEach((col, c) => {
        const rules = isObj(col) && Array.isArray(col.cellStyle) ? col.cellStyle : [];
        rules.forEach((rule, r) => {
            if (isObj(rule) && isObj(rule.style)) checkPair(rule.style, `${path}.props.columns[${c}].cellStyle[${r}].style`, 'The cell fill', ctx, RULE_HINT);
        });
    });
}

/** Warn for every token pair, styleWhen rule and cellStyle rule whose text reads below AA on its fill. */
export function checkRuleContrast(def: Obj, screens: unknown, pushW: Push): void {
    const tokens = colourTokens(def);
    eachSectionNode(def, screens, (node, path, theme) => checkNode(node, path, { tokens, theme, pushW }));
}
