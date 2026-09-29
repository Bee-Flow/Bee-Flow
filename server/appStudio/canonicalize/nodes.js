/**
 * App Studio canonicalizer — component nodes: the v2 logic fields
 * (visibleWhen / computed / validations / role refs) and the recursive node
 * walk that rebuilds a subtree.
 */

'use strict';

const { LIMITS, EVENT_NAMES, COMPONENT_SPECS, expandStyleKnobs } = require('../componentSpecs');
const { HARD_DEPTH_CAP, isObject, deepCopy, truncate, isFormulaObj } = require('./shared');
const { cleanFormula } = require('./bindings');
const { cleanStyle } = require('./style');
const { cleanProps } = require('./props');

// ---------------------------------------------------------------------------
// v2 node logic — visibility/enablement flags (boolean | formula), computed
// prop overrides, per-field validations, and role references.
// ---------------------------------------------------------------------------

// A boolean OR a {kind:'formula',expr}; anything else is invalid and reported.
function cleanBoolOrFormula(raw, path, push, code) {
    if (typeof raw === 'boolean') return raw;
    if (isFormulaObj(raw)) return cleanFormula(raw, `${path}.expr`, push);
    push(code, path, `${path.split('.').pop()} must be a boolean or {kind:"formula",expr} — dropped.`);
    return undefined;
}

function cleanValidation(rule, path, push) {
    if (!isObject(rule)) {
        push('validation.invalid', path, 'Each validation must be an object { type, ... } — kept for the validator.');
        return deepCopy(rule);
    }
    const out = {};
    if (rule.type !== undefined) out.type = rule.type;
    if (rule.value !== undefined) out.value = typeof rule.value === 'string' ? truncate(rule.value, LIMITS.MAX_STRING, `${path}.value`, push) : deepCopy(rule.value);
    if (rule.format !== undefined) out.format = rule.format;
    if (rule.expr !== undefined) out.expr = typeof rule.expr === 'string' ? truncate(rule.expr, LIMITS.MAX_FORMULA_LEN, `${path}.expr`, push) : deepCopy(rule.expr);
    if (rule.message !== undefined) out.message = typeof rule.message === 'string' ? truncate(rule.message, 300, `${path}.message`, push) : deepCopy(rule.message);
    return out;
}

// Role KEY references (screen/node visibleToRoles) — an array of strings.
function cleanRoleRefs(raw, path, push) {
    if (!Array.isArray(raw)) {
        push('roles.ref_invalid', path, 'visibleToRoles must be an array of role keys — dropped.');
        return undefined;
    }
    const out = [];
    for (const r of raw) {
        if (typeof r === 'string' && r) out.push(r);
        else push('roles.ref_invalid', path, `Dropped non-string role reference ${JSON.stringify(r)}.`);
    }
    return out;
}

// Attach the v2 optional logic fields to `out` (only when present in input, so
// v1 nodes canonicalize to a byte-identical shape).
function attachNodeLogic(out, node, path, push) {
    for (const flag of ['visibleWhen', 'enabledWhen', 'readOnly']) {
        if (node[flag] === undefined) continue;
        const v = cleanBoolOrFormula(node[flag], `${path}.${flag}`, push, 'node.logic_invalid');
        if (v !== undefined) out[flag] = v;
    }
    if (node.computed !== undefined) {
        if (isObject(node.computed)) {
            const computed = {};
            for (const [k, v] of Object.entries(node.computed)) {
                if (isFormulaObj(v)) computed[k] = cleanFormula(v, `${path}.computed.${k}.expr`, push);
                else push('node.computed_invalid', `${path}.computed.${k}`, `computed.${k} must be {kind:"formula",expr} — dropped.`);
            }
            out.computed = computed;
        } else {
            push('node.computed_invalid', `${path}.computed`, 'computed must be an object map of { propKey: {kind:"formula",expr} } — dropped.');
        }
    }
    if (node.validations !== undefined) {
        if (Array.isArray(node.validations)) {
            let arr = node.validations;
            if (arr.length > LIMITS.MAX_VALIDATIONS_PER_FIELD) {
                push('validations.truncated', `${path}.validations`, `Kept the first ${LIMITS.MAX_VALIDATIONS_PER_FIELD} of ${arr.length} validations.`);
                arr = arr.slice(0, LIMITS.MAX_VALIDATIONS_PER_FIELD);
            }
            out.validations = arr.map((rule, i) => cleanValidation(rule, `${path}.validations[${i}]`, push));
        } else {
            push('validations.invalid', `${path}.validations`, 'validations must be an array — dropped.');
        }
    }
    if (node.visibleToRoles !== undefined) {
        const cleaned = cleanRoleRefs(node.visibleToRoles, `${path}.visibleToRoles`, push);
        if (cleaned !== undefined) out.visibleToRoles = cleaned;
    }
}

// ---------------------------------------------------------------------------
// Nodes — returns an ARRAY: a non-container whose children were hoisted
// yields [self, ...hoistedSiblings].
// ---------------------------------------------------------------------------

function canonNode(node, path, depth, ids, push) {
    const id = ids.canonId(node.id, 'component', `${path}.id`);
    const spec = COMPONENT_SPECS[node.type];

    const out = { id, type: node.type };

    if (spec) {
        out.props = cleanProps(node, spec, id, path, push);
        out.style = cleanStyle(node.style, expandStyleKnobs(spec.styleKnobs), spec.defaultStyle, `${path}.style`, push);
    } else {
        // Unknown type — validate.js flags it with a closest-match hint; keep
        // the payload intact (minus aliasing) so nothing the user wrote is lost.
        out.props = isObject(node.props) ? deepCopy(node.props) : {};
        out.style = isObject(node.style) ? deepCopy(node.style) : {};
    }

    if (node.visible === undefined) {
        out.visible = true;
    } else if (typeof node.visible === 'boolean') {
        out.visible = node.visible;
    } else if (isFormulaObj(node.visible)) {
        out.visible = cleanFormula(node.visible, `${path}.visible.expr`, push);
    } else {
        out.visible = true;
        push('node.visible_invalid', `${path}.visible`, `visible must be a boolean or {kind:"formula",expr} — got ${JSON.stringify(node.visible)}, set to true.`);
    }

    // v2 optional logic fields (only emitted when the input carries them).
    attachNodeLogic(out, node, path, push);

    for (const ev of EVENT_NAMES) {
        if (node[ev] === undefined || node[ev] === null) continue;
        if (typeof node[ev] === 'string' && node[ev]) out[ev] = node[ev];
        else push('event.invalid', `${path}.${ev}`, `${ev} must be an action id string — dropped.`);
    }

    const isContainer = !!(spec && spec.container);
    const rawChildren = node.children;
    const hoisted = [];

    if (isContainer) {
        out.children = [];
        if (rawChildren === undefined || rawChildren === null) {
            // fine — empty container
        } else if (!Array.isArray(rawChildren)) {
            push('node.children_dropped', `${path}.children`, 'children must be an array — dropped.');
        } else if (depth >= HARD_DEPTH_CAP) {
            push('node.too_deep', `${path}.children`, `Nesting exceeds the hard depth cap (${HARD_DEPTH_CAP}) — children dropped.`);
        } else {
            rawChildren.forEach((child, i) => {
                if (!isObject(child)) {
                    push('node.invalid', `${path}.children[${i}]`, 'Child is not an object — dropped.');
                    return;
                }
                out.children.push(...canonNode(child, `${path}.children[${i}]`, depth + 1, ids, push));
            });
        }
    } else if (rawChildren !== undefined && rawChildren !== null) {
        // children on a non-container: hoist salvageable component nodes as
        // following siblings, drop the rest.
        if (Array.isArray(rawChildren) && depth < HARD_DEPTH_CAP) {
            let dropped = 0;
            rawChildren.forEach((child, i) => {
                if (isObject(child) && typeof child.type === 'string' && COMPONENT_SPECS[child.type]) {
                    hoisted.push(...canonNode(child, `${path}.children[${i}]`, depth, ids, push));
                } else {
                    dropped++;
                }
            });
            if (hoisted.length) push('node.children_hoisted', `${path}.children`, `"${node.type}" cannot contain children — hoisted ${hoisted.length} child(ren) as following siblings.`);
            if (dropped) push('node.children_dropped', `${path}.children`, `"${node.type}" cannot contain children — dropped ${dropped} unsalvageable child(ren).`);
        } else {
            push('node.children_dropped', `${path}.children`, `"${node.type}" cannot contain children — dropped.`);
        }
    }

    return [out, ...hoisted];
}

module.exports = {
    cleanBoolOrFormula,
    cleanValidation,
    cleanRoleRefs,
    attachNodeLogic,
    canonNode,
};
