// @typecheck strict
/**
 * App Studio catalog: conditional style rules (package LK15).
 *
 * A rule list is a short ordered list of `{ when: {kind:'formula', expr}, style: {…knobs} }`.
 * At render every rule whose formula is true lays its knobs over the base style, in order, so a
 * later match wins. Two places hold one:
 *
 *   node.styleWhen            on a component, with the look knobs that component's type already
 *                             has (STYLE_WHEN_KNOBS ∩ its knobs; canonicalize/styleWhen.mts)
 *   columns[].cellStyle       on a table or data_grid column, per cell, with `item` (the row) and
 *                             `value` (the cell's value) in scope, and only the knobs of
 *                             CELL_STYLE_KNOBS (cleanCellStyle below)
 *
 * Layout knobs (span, sizes, heights, placement, margins, columns) are never conditional, so the
 * height and grid checks the validator runs stay true whatever the data says.
 *
 * This file is a leaf (it requires only ./limits and ./colorValue): componentSpecs/objectShapes.js
 * reads cleanCellStyle while the catalogue itself is still loading. Nothing here is ever filled
 * from a default: a node or column without the key keeps its bytes.
 */

'use strict';

const { LIMITS } = require('./limits');
const { isColorOrRoleValue } = require('./colorValue');

/** The knobs a rule of node.styleWhen may set, where the node's type has the knob. */
const STYLE_WHEN_KNOBS = Object.freeze([
    'color', 'background', 'border', 'radius', 'weight',
    // box group (styleKnobGroups/box.js), minus the margins
    'shadow', 'opacity', 'borderWidth', 'borderSides', 'borderColor', 'backgroundColor',
    // text group (styleKnobGroups/text.js)
    'font', 'textSize', 'lineHeight', 'tracking', 'transform',
]);

/** The knobs a rule of a column's cellStyle may set: the text colour, a fill and the weight. */
const CELL_STYLE_KNOBS = Object.freeze(['color', 'backgroundColor', 'weight']);

// styleKnobs.COLOR_ROLES and the weight values, written out: this file loads before the knob table.
const COLOR_ROLES = Object.freeze(['primary', 'neutral', 'success', 'warning', 'danger', 'info']);
const WEIGHTS = Object.freeze(['regular', 'medium', 'semibold', 'bold']);

/**
 * @typedef {(code: string, path: string, message: string) => void} Push
 * @typedef {{ when: { kind: 'formula', expr: unknown }, style: Record<string, unknown> }} StyleRule
 * @typedef {(style: unknown, path: string) => Record<string, unknown> | undefined} RuleStyleCleaner
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The condition of one rule as stored: `{kind:'formula', expr}`. A bare expression string is
 * what a builder writes first and is wrapped. Anything else is no condition (undefined).
 * @param {unknown} raw
 * @param {string} path
 * @param {Push} push
 */
function cleanWhen(raw, path, push) {
    const source = typeof raw === 'string' ? raw : (isObject(raw) && raw.kind === 'formula' ? raw.expr : undefined);
    if (typeof source !== 'string' || !source.trim()) return undefined;
    let expr = source;
    if (expr.length > LIMITS.MAX_FORMULA_LEN) {
        expr = expr.slice(0, LIMITS.MAX_FORMULA_LEN);
        push('string.truncated', `${path}.expr`, `Formula truncated to ${LIMITS.MAX_FORMULA_LEN} chars.`);
    }
    return { kind: /** @type {'formula'} */ ('formula'), expr };
}

/**
 * A rule list as stored, or undefined when nothing in it can be used (the key is then left out).
 * A rule without a usable condition or without a knob left after cleaning is dropped, and the
 * list keeps at most `max` rules.
 * @param {unknown} raw
 * @param {string} path
 * @param {Push} push
 * @param {{ max: number, label: string, cleanStyle: RuleStyleCleaner }} opts
 * @returns {StyleRule[] | undefined}
 */
function cleanRuleList(raw, path, push, { max, label, cleanStyle }) {
    if (!Array.isArray(raw)) {
        push('style_rules.invalid', path, `${label} must be a list of { when: "<formula>", style: { … } } — dropped.`);
        return undefined;
    }
    /** @type {StyleRule[]} */
    const out = [];
    let cut = false;
    raw.forEach((rule, i) => {
        const at = `${path}[${i}]`;
        if (out.length >= max) {
            if (!cut) push('style_rules.too_many', path, `${label} keeps at most ${max} rules — the rest were dropped.`);
            cut = true;
            return;
        }
        const when = isObject(rule) ? cleanWhen(rule.when, `${at}.when`, push) : undefined;
        if (!when) {
            push('style_rules.rule_dropped', at, `A ${label} rule needs when: a formula (e.g. "item.status == 'late'") — dropped.`);
            return;
        }
        const style = cleanStyle(isObject(rule) ? rule.style : undefined, `${at}.style`);
        if (!style || !Object.keys(style).length) {
            push('style_rules.rule_dropped', at, `A ${label} rule needs at least one style knob it may set — dropped.`);
            return;
        }
        out.push({ when, style });
    });
    return out.length ? out : undefined;
}

/**
 * The knobs of one cellStyle rule, or undefined when none is usable.
 * @param {unknown} raw
 * @returns {Record<string, unknown> | undefined}
 */
function cleanCellRuleStyle(raw) {
    if (!isObject(raw)) return undefined;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const knob of CELL_STYLE_KNOBS) {
        const v = raw[knob];
        if (v === undefined || v === null) continue;
        if (knob === 'weight' ? (typeof v === 'string' && WEIGHTS.includes(v)) : isColorOrRoleValue(v, COLOR_ROLES)) out[knob] = v;
    }
    return out;
}

/**
 * columns[].cellStyle as stored (componentSpecs/objectShapes.js `cellStyle`). A knob that is not
 * one of CELL_STYLE_KNOBS, or a value it cannot use, is left out of the rule.
 * @param {unknown} raw
 * @param {Push} push
 * @param {string} path
 */
function cleanCellStyle(raw, push, path) {
    const reportingStyle = /** @type {RuleStyleCleaner} */ ((style, at) => {
        const kept = cleanCellRuleStyle(style);
        const dropped = isObject(style) ? Object.keys(style).filter((k) => !kept || !(k in kept)) : [];
        if (dropped.length) push('style_rules.knob_dropped', at, `cellStyle sets only ${CELL_STYLE_KNOBS.join(', ')} (a role or #rrggbb for the colours) — dropped: ${dropped.join(', ')}.`);
        return kept;
    });
    return cleanRuleList(raw, path, push, { max: LIMITS.MAX_CELL_STYLE_RULES, label: 'cellStyle', cleanStyle: reportingStyle });
}

const RULE_SHAPE = '[{ when: "<formula>", style: { <knob>: <value> } }]';

/**
 * The spec of a cellStyle column key. `first` is the index line (at most 72 characters, no ';').
 * @param {string} first
 */
function cellStyleSpec(first) {
    return {
        type: 'object',
        objectShape: 'cellStyle',
        since: 3,
        description: `${first} `
            + `A list ${RULE_SHAPE} of at most ${LIMITS.MAX_CELL_STYLE_RULES} rules, checked per cell in order: every rule whose formula is true applies, a later one wins. `
            + 'In the formula `item` is the row and `value` this cell\'s value, e.g. { when: "value > 1000", style: { color: "danger", weight: "bold" } } or { when: "item.status == \'late\'", style: { backgroundColor: "warning" } }. '
            + `Knobs: ${CELL_STYLE_KNOBS.join(', ')}; a colour is a role (${COLOR_ROLES.join(', ')}) or #rrggbb. A role follows light, dark and high contrast, so prefer it. `
            + 'A formula that fails leaves the cell as it is. Set it through the column list of app_update_component { id, props: { columns: [...] } }.',
    };
}

module.exports = { STYLE_WHEN_KNOBS, CELL_STYLE_KNOBS, RULE_SHAPE, cleanRuleList, cleanCellStyle, cellStyleSpec };
