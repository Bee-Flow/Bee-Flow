/**
 * App Studio validator — the component tree: per-prop values, style knobs and
 * advanced sizing, node logic (visibility/computed/validations/roles), the
 * deep node walk, and the action-reachability collection.
 */

'use strict';

const {
    LIMITS,
    HEX_RE,
    STYLE_KNOBS,
    expandStyleKnobs,
    containerHeightRoute,
    containerPassesHeightDown,
    FIXED_HEIGHT_PRESETS,
    FORMULA_SCOPE_ROOTS,
    EVENT_NAMES,
    COMPONENT_SPECS,
    COMPONENT_TYPES,
} = require('../componentSpecs');
const { pickClosestId } = require('../../automation/validate/helpers');
const { isObject } = require('./shared');
const { validateFormula } = require('./formulas');
const { checkTableRef, checkTableSource } = require('./refs');
const { validateBinding } = require('./bindings');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// How many children a non-scrolling pane may stack before the ones at the
// bottom are, in practice, off screen. Six is roughly a header + a control row +
// content + a footer; past that something has to scroll or fill.
const PANE_CLIP_CHILDREN = 6;

// ---------------------------------------------------------------------------
// Per-prop value checks driven by COMPONENT_SPECS
// ---------------------------------------------------------------------------

function validatePropValue(key, fs, value, path, ctx) {
    const { pushE, pushW } = ctx;

    if (value === undefined || value === null) {
        if (fs.required) pushE({ code: 'prop.required', severity: 'error', path, message: `Missing required prop \`${key}\`.`, hint: `Provide a ${fs.type} value${fs.default !== undefined && fs.default !== null ? ` (spec default: ${JSON.stringify(fs.default)})` : ''}.` });
        return;
    }

    switch (fs.type) {
        case 'string':
        case 'markdown':
        case 'icon': {
            if (typeof value !== 'string') { pushE({ code: 'prop.type', severity: 'error', path, message: `\`${key}\` must be a string (got ${typeof value}).`, hint: 'Pass a plain string.' }); return; }
            const maxLen = fs.maxLen || LIMITS.MAX_STRING;
            if (value.length > maxLen) pushE({ code: 'prop.too_long', severity: 'error', path, message: `\`${key}\` is ${value.length} chars — the maximum is ${maxLen}.`, hint: 'Shorten the text.' });
            if (fs.required && !value) pushE({ code: 'prop.required', severity: 'error', path, message: `\`${key}\` must be a non-empty string.`, hint: 'Provide a value.' });
            return;
        }
        case 'url': {
            if (typeof value !== 'string') { pushE({ code: 'prop.type', severity: 'error', path, message: `\`${key}\` must be a URL string.`, hint: 'Pass an https:// URL.' }); return; }
            let ok = false;
            try { ok = new URL(value).protocol === 'https:'; } catch { ok = false; }
            if (!ok) pushE({ code: 'prop.url_invalid', severity: 'error', path, message: `\`${key}\` must be a valid https:// URL (got ${JSON.stringify(value.slice(0, 80))}).`, hint: 'Only https URLs are allowed.' });
            return;
        }
        case 'color': {
            if (typeof value !== 'string' || !HEX_RE.test(value)) pushE({ code: 'prop.type', severity: 'error', path, message: `\`${key}\` must be a #rrggbb color.`, hint: 'Use a 6-digit hex literal like #0F766E.' });
            return;
        }
        case 'boolean': {
            if (typeof value !== 'boolean') pushE({ code: 'prop.type', severity: 'error', path, message: `\`${key}\` must be a boolean.`, hint: 'Use true or false.' });
            return;
        }
        case 'int':
        case 'number': {
            if (typeof value !== 'number' || !Number.isFinite(value) || (fs.type === 'int' && !Number.isInteger(value))) {
                pushE({ code: 'prop.type', severity: 'error', path, message: `\`${key}\` must be ${fs.type === 'int' ? 'an integer' : 'a number'}.`, hint: 'Pass a plain number, not a string.' });
                return;
            }
            if ((fs.min !== undefined && fs.min !== null && value < fs.min) || (fs.max !== undefined && fs.max !== null && value > fs.max)) {
                pushE({ code: 'prop.range', severity: 'error', path, message: `\`${key}\` ${value} is out of range ${fs.min}..${fs.max}.`, hint: `Use a value between ${fs.min} and ${fs.max}.` });
            }
            return;
        }
        case 'enum': {
            if (fs.values.includes(value)) return;
            if (fs.allowIsoDate && typeof value === 'string' && ISO_DATE_RE.test(value)) return;
            pushE({ code: 'prop.enum', severity: 'error', path, message: `\`${key}\` ${JSON.stringify(value)} is not a legal value.`, hint: `Use one of: ${fs.values.map((v) => JSON.stringify(v)).join(', ')}${fs.allowIsoDate ? ', or an ISO date (YYYY-MM-DD)' : ''}.` });
            return;
        }
        case 'binding':
            validateBinding(key, value, path, ctx);
            return;
        case 'formula': {
            validateFormula(value, path, ctx, FORMULA_SCOPE_ROOTS);
            return;
        }
        case 'stringList': {
            if (!Array.isArray(value)) { pushE({ code: 'prop.type', severity: 'error', path, message: `\`${key}\` must be an array of strings.`, hint: 'Pass a list of string values.' }); return; }
            if (fs.maxItems && value.length > fs.maxItems) pushE({ code: 'prop.too_many_items', severity: 'error', path, message: `\`${key}\` has ${value.length} items — the maximum is ${fs.maxItems}.`, hint: 'Trim the list.' });
            value.forEach((item, i) => {
                if (typeof item !== 'string') pushE({ code: 'prop.item_invalid', severity: 'error', path: `${path}[${i}]`, message: `\`${key}\` item ${i} must be a string.`, hint: 'Each value is a plain string.' });
                else if (item.length > (fs.itemMaxLen || LIMITS.MAX_STRING)) pushE({ code: 'prop.item_invalid', severity: 'error', path: `${path}[${i}]`, message: `\`${key}\` item ${i} is ${item.length} chars — the maximum is ${fs.itemMaxLen || LIMITS.MAX_STRING}.`, hint: 'Shorten it.' });
            });
            return;
        }
        case 'list': {
            if (!Array.isArray(value)) { pushE({ code: 'prop.type', severity: 'error', path, message: `\`${key}\` must be an array.`, hint: 'Pass a list of objects.' }); return; }
            if (fs.maxItems && value.length > fs.maxItems) pushE({ code: 'prop.too_many_items', severity: 'error', path, message: `\`${key}\` has ${value.length} items — the maximum is ${fs.maxItems}.`, hint: 'Trim the list.' });
            value.forEach((item, i) => {
                const ip = `${path}[${i}]`;
                if (!isObject(item)) { pushE({ code: 'prop.item_invalid', severity: 'error', path: ip, message: `\`${key}\` item ${i} must be an object.`, hint: `Each item needs: ${Object.keys(fs.itemShape).join(', ')}.` }); return; }
                for (const [ik, ifs] of Object.entries(fs.itemShape)) {
                    const iv = item[ik];
                    if (iv === undefined || iv === null) {
                        if (ifs.required) pushE({ code: 'prop.item_required', severity: 'error', path: `${ip}.${ik}`, message: `\`${key}\` item ${i} is missing required \`${ik}\`.`, hint: 'Fill the field.' });
                        continue;
                    }
                    if (ifs.type === 'string') {
                        if (typeof iv !== 'string') pushE({ code: 'prop.item_invalid', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` must be a string.`, hint: 'Pass a plain string.' });
                        else if (iv.length > (ifs.maxLen || LIMITS.MAX_STRING)) pushE({ code: 'prop.item_invalid', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` is ${iv.length} chars — the maximum is ${ifs.maxLen || LIMITS.MAX_STRING}.`, hint: 'Shorten it.' });
                        else if (ifs.required && !iv) pushE({ code: 'prop.item_required', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` must be non-empty.`, hint: 'Fill the field.' });
                    } else if (ifs.type === 'enum' && !ifs.values.includes(iv)) {
                        pushE({ code: 'prop.item_invalid', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` ${JSON.stringify(iv)} is not a legal value.`, hint: `Use one of: ${ifs.values.join(', ')}.` });
                    } else if (ifs.type === 'int') {
                        if (typeof iv !== 'number' || !Number.isInteger(iv) || (ifs.min !== undefined && iv < ifs.min) || (ifs.max !== undefined && iv > ifs.max)) {
                            pushE({ code: 'prop.item_invalid', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` must be an integer${ifs.min !== undefined ? ` ${ifs.min}..${ifs.max}` : ''}.`, hint: 'Pass a plain integer.' });
                        }
                    } else if (ifs.type === 'boolean' && typeof iv !== 'boolean') {
                        pushE({ code: 'prop.item_invalid', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` must be a boolean.`, hint: 'Use true or false.' });
                    } else if (ifs.type === 'list') {
                        // ONE level of nesting, and only one. A data_grid column
                        // carries its own value→tone map, which is a list inside
                        // a list; without this branch the whole map fell through
                        // unchecked, so a typo'd tone reached the runtime and
                        // silently rendered grey. Deeper nesting is not a shape
                        // this schema language should grow — if a prop needs it,
                        // it wants to be a component, not a column field.
                        if (!Array.isArray(iv)) {
                            pushE({ code: 'prop.item_invalid', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` must be an array.`, hint: 'Pass a list of objects.' });
                        } else if (ifs.maxItems && iv.length > ifs.maxItems) {
                            pushE({ code: 'prop.too_many_items', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` has ${iv.length} items — the maximum is ${ifs.maxItems}.`, hint: 'Trim the list.' });
                        } else {
                            iv.forEach((sub, si) => {
                                const sp = `${ip}.${ik}[${si}]`;
                                if (!isObject(sub)) { pushE({ code: 'prop.item_invalid', severity: 'error', path: sp, message: `\`${ik}\` item ${si} must be an object.`, hint: `Each item needs: ${Object.keys(ifs.itemShape || {}).join(', ')}.` }); return; }
                                for (const [sk, sfs] of Object.entries(ifs.itemShape || {})) {
                                    const sv = sub[sk];
                                    if (sv === undefined || sv === null) {
                                        if (sfs.required) pushE({ code: 'prop.item_required', severity: 'error', path: `${sp}.${sk}`, message: `\`${ik}\` item ${si} is missing required \`${sk}\`.`, hint: 'Fill the field.' });
                                        continue;
                                    }
                                    if (sfs.type === 'string' && typeof sv !== 'string') {
                                        pushE({ code: 'prop.item_invalid', severity: 'error', path: `${sp}.${sk}`, message: `\`${sk}\` must be a string.`, hint: 'Pass a plain string.' });
                                    } else if (sfs.type === 'enum' && !sfs.values.includes(sv)) {
                                        pushE({ code: 'prop.item_invalid', severity: 'error', path: `${sp}.${sk}`, message: `\`${sk}\` ${JSON.stringify(sv)} is not a legal value.`, hint: `Use one of: ${sfs.values.join(', ')}.` });
                                    }
                                }
                            });
                        }
                    }
                }
                const extra = Object.keys(item).filter((k) => !(k in fs.itemShape));
                if (extra.length) pushW({ code: 'prop.item_unknown_key', severity: 'warning', path: ip, message: `\`${key}\` item ${i} has unknown keys: ${extra.join(', ')} — the renderer ignores them.`, hint: `Legal item keys: ${Object.keys(fs.itemShape).join(', ')}.` });
            });
            return;
        }
        default:
            return;
    }
}

// ---------------------------------------------------------------------------
// v2 node logic — visibility/enablement flags, computed prop overrides,
// per-field validations, and role references.
// ---------------------------------------------------------------------------

const VALIDATION_TYPES = ['required', 'format', 'minLength', 'formula'];

// "Visible to nobody". An empty visibleToRoles already means "everyone", so
// hiding an item from every role needs a reference that no real role can equal
// — role keys are author-supplied and start with a lowercase letter. The editor
// writes it (agent-hub .../rbac/AccessMatrix.jsx) and roleAllows() matches it
// against no one; it is a known reference here so it never reports as an
// unknown role the author is invited to "add".
const NOBODY_ROLE_REF = '__nobody__';

function validateRoleRefs(refs, path, ctx) {
    const { pushE, pushW, roleIds } = ctx;
    if (!Array.isArray(refs)) {
        pushE({ code: 'roles.ref_invalid', severity: 'error', path, message: 'visibleToRoles must be an array of role keys.', hint: 'Use an array of role ids from definition.roles.' });
        return;
    }
    for (const r of refs) {
        if (typeof r !== 'string' || !r) {
            pushE({ code: 'roles.ref_invalid', severity: 'error', path, message: `Role reference ${JSON.stringify(r)} must be a non-empty string.`, hint: 'Use a role id from definition.roles.' });
            continue;
        }
        if (r === NOBODY_ROLE_REF) continue;
        if (!roleIds.has(r)) {
            const suggestion = pickClosestId(r, Array.from(roleIds));
            pushW({ code: 'roles.ref_unknown', severity: 'warning', path, message: `References unknown role "${r}".`, hint: suggestion ? `Did you mean "${suggestion}"?` : 'Add the role to definition.roles, or remove the reference.' });
        }
    }
}

function validateFieldValidations(node, path, ctx, spec) {
    const { pushE, pushW } = ctx;
    const arr = node.validations;
    if (!Array.isArray(arr)) {
        pushE({ code: 'validations.invalid', severity: 'error', path: `${path}.validations`, message: 'validations must be an array.', hint: 'Use a list of { type, ... } rules.' });
        return;
    }
    if (arr.length > LIMITS.MAX_VALIDATIONS_PER_FIELD) {
        pushE({ code: 'validations.too_many', severity: 'error', path: `${path}.validations`, message: `${arr.length} validations — the maximum is ${LIMITS.MAX_VALIDATIONS_PER_FIELD}.`, hint: 'Trim the list.' });
    }
    if (!spec || !spec.isInput) {
        pushW({ code: 'validations.not_input', severity: 'warning', path: `${path}.validations`, message: `${node.type} is not a form input — its validations are ignored.`, hint: 'Move validations onto an input component.' });
    }
    arr.forEach((rule, i) => {
        const rp = `${path}.validations[${i}]`;
        if (!isObject(rule)) {
            pushE({ code: 'validation.invalid', severity: 'error', path: rp, message: 'Each validation must be an object { type, ... }.', hint: 'Provide a rule object.' });
            return;
        }
        if (!VALIDATION_TYPES.includes(rule.type)) {
            pushE({ code: 'validation.type_invalid', severity: 'error', path: `${rp}.type`, message: `Unknown validation type ${JSON.stringify(rule.type)}.`, hint: `Use one of: ${VALIDATION_TYPES.join(', ')}.` });
            return;
        }
        if (rule.type === 'formula') validateFormula(rule.expr, `${rp}.expr`, ctx, FORMULA_SCOPE_ROOTS);
        if (rule.type === 'minLength' && (typeof rule.value !== 'number' || !Number.isInteger(rule.value) || rule.value < 0)) {
            pushE({ code: 'validation.value_invalid', severity: 'error', path: `${rp}.value`, message: 'A minLength rule needs a non-negative integer `value`.', hint: 'e.g. { type: "minLength", value: 3 }.' });
        }
        if (rule.type === 'format' && (typeof rule.format !== 'string' || !rule.format)) {
            pushE({ code: 'validation.format_invalid', severity: 'error', path: `${rp}.format`, message: 'A format rule needs a non-empty `format` string.', hint: 'e.g. { type: "format", format: "email" }.' });
        }
        if (rule.message !== undefined && typeof rule.message !== 'string') {
            pushE({ code: 'validation.message_invalid', severity: 'error', path: `${rp}.message`, message: 'A validation `message` must be a string.', hint: 'Provide the user-facing message.' });
        }
    });
}

function validateNodeLogic(node, path, ctx, spec) {
    const { pushE, pushW } = ctx;
    // visible: boolean | { kind:'formula', expr }
    if (node.visible !== undefined && typeof node.visible !== 'boolean') {
        if (isObject(node.visible) && node.visible.kind === 'formula') validateFormula(node.visible.expr, `${path}.visible.expr`, ctx, FORMULA_SCOPE_ROOTS);
        else pushE({ code: 'node.visible_invalid', severity: 'error', path: `${path}.visible`, message: 'visible must be a boolean or { kind:"formula", expr }.', hint: 'Use true/false or a formula binding.' });
    }
    for (const flag of ['visibleWhen', 'enabledWhen', 'readOnly']) {
        const v = node[flag];
        if (v === undefined || typeof v === 'boolean') continue;
        if (isObject(v) && v.kind === 'formula') validateFormula(v.expr, `${path}.${flag}.expr`, ctx, FORMULA_SCOPE_ROOTS);
        else pushE({ code: 'node.logic_invalid', severity: 'error', path: `${path}.${flag}`, message: `${flag} must be a boolean or { kind:"formula", expr }.`, hint: 'Use true/false or a formula binding.' });
    }
    if (node.computed !== undefined) {
        if (!isObject(node.computed)) {
            pushE({ code: 'node.computed_invalid', severity: 'error', path: `${path}.computed`, message: 'computed must be an object map of { propKey: {kind:"formula",expr} }.', hint: 'Map prop keys to formula bindings.' });
        } else {
            for (const [k, v] of Object.entries(node.computed)) {
                if (!isObject(v) || v.kind !== 'formula') {
                    pushE({ code: 'node.computed_invalid', severity: 'error', path: `${path}.computed.${k}`, message: `computed.${k} must be { kind:"formula", expr }.`, hint: 'Use a formula binding.' });
                    continue;
                }
                validateFormula(v.expr, `${path}.computed.${k}.expr`, ctx, FORMULA_SCOPE_ROOTS);
                if (spec && !(k in spec.props)) {
                    pushW({ code: 'node.computed_unknown_prop', severity: 'warning', path: `${path}.computed.${k}`, message: `computed targets "${k}" which is not a prop of ${node.type} — ignored.`, hint: `Legal props: ${Object.keys(spec.props).join(', ') || '(none)'}.` });
                }
            }
        }
    }
    if (node.validations !== undefined) validateFieldValidations(node, path, ctx, spec);
    if (node.visibleToRoles !== undefined) validateRoleRefs(node.visibleToRoles, `${path}.visibleToRoles`, ctx);
}

// ---------------------------------------------------------------------------
// Advanced sizing — the widthMode/widthValue and heightMode/heightValue pairs.
//
// Everything here exists to stop a knob from being stored that does nothing.
// The three ways that happens are (1) a value with no mode to give it a unit,
// (2) a mode with no value to apply, and (3) a percentage height with no
// parent height to be a percentage of.
// ---------------------------------------------------------------------------

/** The unit a *Value is measured in, from its *Mode sibling (default when absent/illegal). */
function effectiveSizeMode(style, knob) {
    const modeSpec = STYLE_KNOBS[knob.modeKnob];
    const v = style[knob.modeKnob];
    return modeSpec.values.includes(v) ? v : modeSpec.default;
}

/** Range check for one unitInt knob, against the range its current mode names. */
function validateUnitKnob(name, knob, style, path, ctx) {
    const v = style[name];
    if (v === null || v === undefined) return;         // "not set" — legal
    const mode = effectiveSizeMode(style, knob);
    const range = knob.units[mode];
    if (typeof v !== 'number' || !Number.isInteger(v)) {
        ctx.pushE({ code: 'style.invalid', severity: 'error', path, message: `Style knob \`${name}\` has invalid value ${JSON.stringify(v)}.`, hint: `Use a whole number${range ? ` ${range.min}..${range.max}` : ''}.` });
        return;
    }
    // No range = this mode carries no value; the pair check below reports it,
    // so keep this one to "the number itself is out of bounds".
    if (range && (v < range.min || v > range.max)) {
        ctx.pushE({ code: 'style.invalid', severity: 'error', path, message: `\`${name}\` is ${v}, outside the ${mode} range ${range.min}..${range.max}.`, hint: `In ${mode} the legal window is ${range.min}..${range.max}. Pick a value inside it, or switch \`${knob.modeKnob}\`.` });
    }
}

/**
 * The coherence rules for a style object's sizing pairs.
 *
 * `allowedKnobs` gates which pairs even apply — a section has no `span`, so it
 * has no width pair, and asking about widthMode there would be noise.
 */
function validateAdvancedSizing(style, path, ctx, {
    what, allowedKnobs, parentHeightDefinite, parentLabel, parentHeightRoute = null, isSection = false,
}) {
    const { pushE } = ctx;

    for (const valueKnob of ['widthValue', 'heightValue']) {
        if (!allowedKnobs.includes(valueKnob)) continue;
        const knob = STYLE_KNOBS[valueKnob];
        const modeKnob = knob.modeKnob;
        const mode = effectiveSizeMode(style, knob);
        const hasValue = style[valueKnob] !== null && style[valueKnob] !== undefined;
        const units = Object.keys(knob.units);
        const carriesValue = Boolean(knob.units[mode]);

        // (1) a measurement with no unit — the commonest way to think the knob
        // is set when it is not.
        if (hasValue && !carriesValue) {
            pushE({
                code: 'style.unit_without_mode', severity: 'error', path: `${path}.${valueKnob}`,
                message: `\`${valueKnob}\` is set but \`${modeKnob}\` is ${JSON.stringify(mode)}, which carries no ${valueKnob === 'widthValue' ? 'width' : 'height'} number — the value is ignored.`,
                hint: valueKnob === 'widthValue'
                    ? `Set \`widthMode\` to ${units.map((u) => JSON.stringify(u)).join(' or ')}, or drop \`widthValue\` and size with the \`span\` column count.`
                    : `Set \`heightMode\` to ${units.map((u) => JSON.stringify(u)).join(' or ')}, or drop \`heightValue\` and size with the \`height\` preset.`,
            });
        }
        // (2) a unit with nothing to measure — renders as if the knob were never touched.
        if (!hasValue && carriesValue) {
            pushE({
                code: 'style.mode_without_value', severity: 'error', path: `${path}.${modeKnob}`,
                message: `\`${modeKnob}\` is ${JSON.stringify(mode)} but \`${valueKnob}\` is not set — nothing is applied.`,
                hint: `Set \`${valueKnob}\` to a whole number ${knob.units[mode].min}..${knob.units[mode].max}, or set \`${modeKnob}\` back to ${JSON.stringify(STYLE_KNOBS[modeKnob].default)}.`,
            });
        }
    }

    // (3) a percentage height needs a parent that HANDS ONE DOWN, or CSS
    // resolves it to auto and the knob does nothing at all.
    //
    // "Hands one down" is deliberately stricter than "has one". The parent's
    // height lands on its grid CELL, and each container renders its own wrapper
    // between that cell and the children: a pane's is `h-full` always, a card's
    // and a container's only when they are filling. So a card at `height:'md'`
    // is a real 200px box whose children still have nothing to measure against
    // — which is the case this used to accept and the browser used to collapse.
    //
    // Rejected rather than shipped silent, and each message names the move that
    // fixes it, because which move that is depends on WHY the parent is no good.
    // `parentHeightDefinite` true is the legal case: the parent really does
    // hand a height down, so there is nothing to say.
    if (allowedKnobs.includes('heightMode') && style.heightMode === 'pct' && !parentHeightDefinite) {
        const fallback = `size this ${what} with heightMode "px" (a fixed band) or "vh" (a share of the screen) instead`;
        if (isSection) {
            pushE({
                code: 'style.height_pct_indefinite', severity: 'error', path: `${path}.heightMode`,
                message: 'A section stacks in the screen\'s flowing height, so there is no parent height for a percentage to measure — `heightMode` "pct" would resolve to auto and do nothing.',
                hint: 'Use "vh" for a share of the viewport, "px" for a fixed band, or the `height` preset "fill" to take the leftover space.',
            });
        } else if (!parentHeightRoute) {
            // A form/tabs/repeater/page_header/modal/tab: no `height` knob at
            // all, so no amount of editing THIS parent will ever help.
            pushE({
                code: 'style.height_pct_indefinite', severity: 'error', path: `${path}.heightMode`,
                message: `A ${parentLabel} has no height of its own, so there is nothing for \`heightMode\` "pct" to be a percentage OF — it would resolve to auto and do nothing.`,
                hint: `Wrap this ${what} in a card or container with \`height\` "fill" (inside a section that is full-height itself), or ${fallback}.`,
            });
        } else if (parentHeightRoute === 'fill') {
            // A card or container. It may well have a height — it just keeps it
            // to itself unless it is filling, so say that rather than "give it a
            // height", which is the advice that produced this bug.
            pushE({
                code: 'style.height_pct_indefinite', severity: 'error', path: `${path}.heightMode`,
                message: `A ${parentLabel} only passes its height down to its children when its own \`height\` is "fill"; this one leaves them at their natural height, so \`heightMode\` "pct" resolves to auto and does nothing.`,
                hint: `Set the ${parentLabel}'s \`height\` to "fill" — and make sure the section above it is full-height too (\`height\` "fill", or its own heightMode "px"/"vh") — or ${fallback}.`,
            });
        } else {
            // A section or a pane: it passes any height it has straight down,
            // so the fix is to give it one.
            pushE({
                code: 'style.height_pct_indefinite', severity: 'error', path: `${path}.heightMode`,
                message: `\`heightMode\` "pct" needs an enclosing ${parentLabel} with a height of its own to be a percentage OF; that ${parentLabel} is auto-height, so this resolves to auto and does nothing.`,
                hint: `Give the ${parentLabel} a \`height\` (preset ${FIXED_HEIGHT_PRESETS.map((p) => JSON.stringify(p)).join('/')}, its own heightMode "px"/"vh", or "fill" inside a full-height parent), or ${fallback}.`,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Node walk — structure, props, style, events, form rules, depth. Also
// collects form ids and input names for the action-mapping checks.
// ---------------------------------------------------------------------------

// What a node's PARENT contributes to its own validation. Only heights need it
// so far: a percentage height is legal exactly when the box above it hands one
// down. `heightRoute` carries HOW the parent could do that ('always' | 'fill' |
// null — componentSpecs containerHeightRoute), which is what lets the refusal
// name the right repair instead of a generic "give it a height".
const ROOT_PARENT = Object.freeze({ label: 'section', heightDefinite: false, heightRoute: 'always' });

function validateNode(node, path, depth, formId, ctx, parent = ROOT_PARENT) {
    const { pushE, pushW, actionIds } = ctx;

    if (!isObject(node)) {
        pushE({ code: 'node.not_object', severity: 'error', path, message: 'Each component must be an object.', hint: 'Remove the malformed entry.' });
        return;
    }
    if (depth > LIMITS.MAX_DEPTH) {
        pushE({ code: 'shape.too_deep', severity: 'error', path, message: `Component nests ${depth} levels below the screen — the maximum is ${LIMITS.MAX_DEPTH} (section counts as 1, each container +1).`, hint: 'Flatten the layout; move this component up out of a container.' });
        return; // don't descend further
    }

    const spec = COMPONENT_SPECS[node.type];
    if (!spec) {
        const suggestion = pickClosestId(node.type, COMPONENT_TYPES);
        pushE({ code: 'node.unknown_type', severity: 'error', path: `${path}.type`, message: `Unknown component type ${JSON.stringify(node.type)}.`, hint: suggestion ? `Did you mean "${suggestion}"? Legal types: ${COMPONENT_TYPES.join(', ')}.` : `Legal types: ${COMPONENT_TYPES.join(', ')}.` });
        return;
    }

    // props
    let props = node.props;
    if (props !== undefined && !isObject(props)) {
        pushE({ code: 'node.props_invalid', severity: 'error', path: `${path}.props`, message: 'props must be an object.', hint: 'Run the definition through canonicalize, or fix the props shape.' });
        props = {};
    }
    props = props || {};
    for (const [key, fs] of Object.entries(spec.props)) {
        validatePropValue(key, fs, props[key], `${path}.props.${key}`, ctx);
    }
    const unknownProps = Object.keys(props).filter((k) => !(k in spec.props));
    if (unknownProps.length) {
        pushE({ code: 'prop.unknown', severity: 'error', path: `${path}.props`, message: `Unknown props for ${node.type}: ${unknownProps.join(', ')}.`, hint: `Legal props: ${Object.keys(spec.props).join(', ') || '(none)'}.` });
    }

    // style
    if (node.style !== undefined) {
        if (!isObject(node.style)) {
            pushE({ code: 'style.invalid', severity: 'error', path: `${path}.style`, message: 'style must be an object.', hint: 'Use the style knobs from the catalog.' });
        } else {
            const allowedKnobs = expandStyleKnobs(spec.styleKnobs);
            for (const [k, v] of Object.entries(node.style)) {
                if (!allowedKnobs.includes(k)) {
                    pushE({ code: 'style.unknown_key', severity: 'error', path: `${path}.style.${k}`, message: `Style knob \`${k}\` does not apply to ${node.type}.`, hint: `Legal knobs: ${allowedKnobs.join(', ')}.` });
                    continue;
                }
                const knob = STYLE_KNOBS[k];
                if (knob.type === 'unitInt') { validateUnitKnob(k, knob, node.style, `${path}.style.${k}`, ctx); continue; }
                const bad = (knob.type === 'int' && (typeof v !== 'number' || !Number.isInteger(v) || v < knob.min || v > knob.max))
                    || (knob.type === 'enum' && !knob.values.includes(v))
                    || (knob.type === 'colorOrRole' && !(v === null || (typeof v === 'string' && (knob.roles.includes(v) || HEX_RE.test(v)))));
                if (bad) pushE({ code: 'style.invalid', severity: 'error', path: `${path}.style.${k}`, message: `Style knob \`${k}\` has invalid value ${JSON.stringify(v)}.`, hint: knob.type === 'int' ? `Use an integer ${knob.min}..${knob.max}.` : knob.type === 'enum' ? `Use one of: ${knob.values.map((x) => JSON.stringify(x)).join(', ')}.` : `Use null, a role (${knob.roles.join(', ')}), or #rrggbb.` });
            }
            validateAdvancedSizing(node.style, `${path}.style`, ctx, {
                what: node.type,
                allowedKnobs,
                parentHeightDefinite: parent.heightDefinite,
                parentLabel: parent.label,
                parentHeightRoute: parent.heightRoute,
            });
        }
    }

    // v2 node logic — visibility/enablement/computed/validations/role refs
    validateNodeLogic(node, path, ctx, spec);

    // input_relation binds to a data table (publish-gated like automationId).
    // Het is een LEZING (een keuzelijst uit die tabel), dus na checkTableRef
    // dezelfde tweede vraag als bij een record-binding: haalt die tabel haar
    // rijen uit een Studio-datatabel, en bestaat die dan nog? Zonder deze regel
    // publiceerde een app waarvan de gekoppelde tabel ALLEEN door een
    // input_relation werd aangeraakt zonder één woord, en bleef de keuzelijst
    // bij de gebruiker leeg.
    if (node.type === 'input_relation' && props.tableId !== undefined) {
        checkTableRef(props.tableId, `${path}.props.tableId`, ctx, `${node.type}`);
        checkTableSource(props.tableId, `${path}.props.tableId`, ctx, `${node.type}`);
    }
    // Collect modal ids so open_modal actions can resolve them.
    if (node.type === 'modal' && typeof node.id === 'string') ctx.modalIds.add(node.id);

    // events — only on types whose spec allows them, and must resolve
    for (const ev of EVENT_NAMES) {
        const ref = node[ev];
        if (ref === undefined || ref === null) continue;
        if (!Array.isArray(spec.events) || !spec.events.includes(ev)) {
            pushE({ code: 'event.not_supported', severity: 'error', path: `${path}.${ev}`, message: `${node.type} does not support ${ev}.`, hint: spec.events && spec.events.length ? `${node.type} supports: ${spec.events.join(', ')}.` : `${node.type} carries no events; wire the action to a button or form instead.` });
        }
        if (typeof ref !== 'string' || !actionIds.has(ref)) {
            const suggestion = pickClosestId(ref, Array.from(actionIds));
            pushE({ code: 'event.action_unresolved', severity: 'error', path: `${path}.${ev}`, message: `${ev} references unknown action ${JSON.stringify(ref)}.`, hint: suggestion ? `Did you mean "${suggestion}"?` : 'Add the action to definition.actions first.' });
        }
    }

    // Per-row actions (data_grid rowActions / repeater itemActions) are UI
    // wiring exactly like events — the runtime runs their actionId on click and
    // collectReferencedActions counts them as reachability. A typo here used to
    // validate clean and render a button that silently did nothing (and fed
    // garbage into the reached-set). Empty string stays legal: it is the
    // inspector's deliberate "not wired yet" state, guarded at runtime.
    for (const listKey of ['rowActions', 'itemActions', 'bulkActions', 'toolbarActions']) {
        const entries = props[listKey];
        if (!Array.isArray(entries)) continue;
        entries.forEach((entry, i) => {
            const ref = isObject(entry) ? entry.actionId : undefined;
            if (ref === undefined || ref === null || ref === '') return;
            if (typeof ref !== 'string' || !actionIds.has(ref)) {
                const suggestion = pickClosestId(ref, Array.from(actionIds));
                pushE({ code: 'event.action_unresolved', severity: 'error', path: `${path}.props.${listKey}[${i}].actionId`, message: `${listKey} references unknown action ${JSON.stringify(ref)}.`, hint: suggestion ? `Did you mean "${suggestion}"?` : 'Add the action to definition.actions first.' });
            }
        });
    }

    // form / input structure
    const isForm = node.type === 'form';
    if (isForm && formId) {
        pushE({ code: 'form.nested', severity: 'error', path, message: 'A form cannot be nested inside another form.', hint: 'Move this form out to its own section or card.' });
    }
    if (spec.isInput) {
        if (!formId) {
            pushW({ code: 'input.outside_form', severity: 'warning', path, message: `${node.type} sits outside a form — its value is never submitted.`, hint: 'Wrap it in a form component so an action can read it.' });
        }
        const name = props.name;
        if (typeof name === 'string' && name) {
            ctx.allInputNames.add(name);
            if (formId) {
                let names = ctx.inputNamesByForm.get(formId);
                if (!names) { names = new Set(); ctx.inputNamesByForm.set(formId, names); }
                if (names.has(name)) {
                    pushE({ code: 'form.duplicate_input_name', severity: 'error', path: `${path}.props.name`, message: `Duplicate input name "${name}" within one form.`, hint: 'Each input in a form needs a unique name — the submit payload is keyed by it.' });
                }
                names.add(name);
            }
        }
    }

    // A pane that clips. `scroll:'none'` means "everything fits"; a stack of a
    // dozen children in a fixed-height pane does not, and the pane's own
    // overflow:hidden silently eats the bottom of it. The support desk shipped
    // with eleven children under scroll:'none' and the reply composer was simply
    // not on screen — nothing in the definition said so.
    if (node.type === 'pane' && Array.isArray(node.children)) {
        const scroll = props.scroll ?? 'none';
        const fills = node.children.filter((c) => isObject(c) && c.style && c.style.height === 'fill').length;
        if (scroll === 'none' && node.children.length > PANE_CLIP_CHILDREN && fills === 0) {
            pushW({
                code: 'component.pane_clips', severity: 'warning', path,
                message: `This pane stacks ${node.children.length} components with scroll "none" and nothing set to fill — the ones at the bottom are cut off.`,
                hint: 'Set scroll to "auto", give one child height "fill", or split the pane.',
            });
        }
    }

    // A control that demonstrably does nothing. A button with no onClick and no
    // submit role renders, looks primary, and is inert — the single loudest
    // signal that a screen was generated rather than designed.
    //
    // role "submit" only excuses a button that is actually INSIDE a form: the
    // runtime gives it type="submit" and no onClick, so one placed in a page
    // header (next to the form, not in it) has no form to submit and is exactly
    // as dead as the case above — it just used to be exempt from being told so.
    //
    // This is the one app-validator record that reaches the shared "needs
    // attention" list (core/findings/finding.js), so it carries the two Finding
    // fields on top of the legacy ones: `kind` drives the tinted glyph, and
    // `targetRef` is where "Show me" goes. The validator only ever sees a
    // definition — the app id is whatever the caller threaded in as
    // ctx.target ({ id, title }), else null.
    if (node.type === 'button' && !node.onClick && !(props.role === 'submit' && formId)) {
        pushW({
            code: 'component.control_inert', severity: 'warning', path,
            kind: 'app',
            targetRef: {
                kind: 'app',
                id: ctx.target?.id ?? null,
                ...(ctx.target?.title ? { title: ctx.target.title } : {}),
                path,
                nodeId: typeof node.id === 'string' ? node.id : null,
            },
            message: props.role === 'submit'
                ? 'This submit button sits outside a form — there is nothing for it to submit.'
                : 'This button is wired to nothing — clicking it does nothing at all.',
            hint: props.role === 'submit'
                ? 'Move it inside the form component, or set onClick to an action.'
                : 'Set onClick to an action, or give it role "submit" inside a form.',
        });
    }

    // A form whose built-in submit button is shown but wired to nothing. The
    // dangling case cannot ship (event.action_unresolved is an error), so this
    // is the one that reaches a viewer: they fill the fields, click Submit and
    // nothing happens, with nothing on screen to explain it.
    if (isForm && !node.onSubmit && props.showSubmit !== false) {
        pushW({
            code: 'form.no_submit_action', severity: 'warning', path,
            message: 'This form shows a Submit button but has no onSubmit action — clicking it does nothing.',
            hint: 'Wire onSubmit to an action, or set showSubmit to false if the fields save themselves.',
        });
    }

    // children — containers only
    if (node.children !== undefined && node.children !== null) {
        if (!spec.container) {
            pushE({ code: 'node.children_not_allowed', severity: 'error', path: `${path}.children`, message: `${node.type} is not a container — it cannot hold children.`, hint: 'Move the children into a card or form, or directly into the section.' });
        } else if (!Array.isArray(node.children)) {
            pushE({ code: 'node.children_invalid', severity: 'error', path: `${path}.children`, message: 'children must be an array.', hint: 'Wrap the child components in an array.' });
        } else {
            const childFormId = isForm ? (typeof node.id === 'string' ? node.id : formId) : formId;
            if (isForm && typeof node.id === 'string') ctx.formIds.add(node.id);
            // A container passes a definite height down only if it (a) has one
            // and (b) actually threads it through the wrapper it renders around
            // its children. A `tabs` or a `form` fails (a) — no height knob at
            // all — and a `card` or `container` that is not filling fails (b),
            // which is the case that validated clean and then collapsed in the
            // browser. componentSpecs owns both halves of that answer.
            const childParent = {
                label: node.type,
                heightDefinite: containerPassesHeightDown(node.type, node.style, parent.heightDefinite),
                heightRoute: containerHeightRoute(node.type),
            };
            node.children.forEach((child, i) => validateNode(child, `${path}.children[${i}]`, depth + 1, childFormId, ctx, childParent));
        }
    } else if (isForm && typeof node.id === 'string') {
        ctx.formIds.add(node.id);
    }
}

/**
 * Every action id the UI can actually reach.
 *
 * Two routes, both of which the runtime honours: a component EVENT
 * (onClick/onRowClick/onSubmit/onChange/onCardMove) and a per-row action —
 * `props.rowActions[].actionId` on data_grid, `props.itemActions[].actionId`
 * on repeater (two prop names for the same idea; the runtime renders both).
 * An action absent from this set can never run, whatever the definition says.
 *
 * Not "referenced anywhere in the JSON": an actionResult BINDING reads a
 * result, it does not produce one, so an action only ever read from would still
 * be unreachable.
 */
function collectReferencedActions(screens) {
    const out = new Set();
    const visit = (node) => {
        if (!isObject(node)) return;
        for (const ev of EVENT_NAMES) {
            if (typeof node[ev] === 'string' && node[ev]) out.add(node[ev]);
        }
        const props = isObject(node.props) ? node.props : {};
        for (const key of ['itemActions', 'rowActions', 'bulkActions', 'toolbarActions']) {
            for (const entry of (Array.isArray(props[key]) ? props[key] : [])) {
                if (isObject(entry) && typeof entry.actionId === 'string' && entry.actionId) out.add(entry.actionId);
            }
        }
        if (typeof props.addRowActionId === 'string' && props.addRowActionId) out.add(props.addRowActionId);
        for (const col of (Array.isArray(props.columns) ? props.columns : [])) {
            if (isObject(col) && typeof col.actionId === 'string' && col.actionId) out.add(col.actionId);
        }
        for (const child of (Array.isArray(node.children) ? node.children : [])) visit(child);
    };
    for (const screen of (Array.isArray(screens) ? screens : [])) {
        for (const section of (isObject(screen) && Array.isArray(screen.sections) ? screen.sections : [])) {
            for (const child of (isObject(section) && Array.isArray(section.children) ? section.children : [])) visit(child);
        }
    }
    return out;
}

module.exports = {
    validateRoleRefs,
    validateAdvancedSizing,
    validateNode,
    collectReferencedActions,
};
