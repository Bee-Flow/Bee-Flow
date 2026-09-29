/**
 * Per-step checks shared across step types rather than owned by one: the
 * optional maxItems input cap, the reserved/unbindable output-field-name
 * rules, and the bindable-step-id rule.
 */

const { RESERVED_PROTO_KEYS, BINDABLE_SEGMENT_RE } = require('./constants');

// Optional input cap — shared wording for the collection ops AND list-mode
// set. The runner enforces min(maxItems, platform ceiling), so a value above
// 10000 is legal but ineffective.
function checkMaxItems(step, at, pushE, pushW) {
    if (step.maxItems === undefined) return;
    if (typeof step.maxItems !== 'number' || !Number.isInteger(step.maxItems) || step.maxItems < 1) {
        pushE({ code: `${step.type}.maxItems_invalid`, severity: 'error', path: at + '.maxItems', message: `Step ${step.id}: maxItems must be a positive integer.`, hint: 'Set a positive integer, or omit it to use the platform default cap.' });
    } else if (step.maxItems > 10000) {
        pushW({ code: `${step.type}.maxItems_exceeds_cap`, severity: 'warning', path: at + '.maxItems', message: `Step ${step.id}: maxItems ${step.maxItems} exceeds the platform cap (10000) — the cap still wins at runtime.`, hint: 'Lower maxItems to 10000 or below, or raise AUTOMATION_COLLECTION_MAX_ITEMS server-side.' });
    }
}
function checkReservedFieldNames(step, type, at, pushE, pushW) {
    for (const key of Object.keys(step.fields || {})) {
        if (RESERVED_PROTO_KEYS.has(key)) {
            pushE({ code: `${type}.field_name_reserved`, severity: 'error', path: `${at}.fields.${key}`, message: `Step ${step.id}: field name "${key}" is reserved — it would silently vanish from the step output at run time.`, hint: 'Rename the field; __proto__/constructor/prototype cannot be object keys here.' });
            continue;
        }
        // These names become OUTPUT KEYS, bound downstream as
        // `steps.<id>.output.<name>`. A name the binding grammar cannot address
        // (a hyphen, a space, a leading digit, a dot) makes that path parse as
        // something else entirely — `output.total-vat` is a SUBTRACTION — so the
        // field is written and then unreachable. A WARNING, not an error:
        // definitions already stored can carry such names and must stay
        // saveable, and the bracket form below really does reach them.
        if (pushW && !BINDABLE_SEGMENT_RE.test(key)) {
            pushW({ code: `${type}.field_name_unbindable`, severity: 'warning', path: `${at}.fields.${key}`, message: `Step ${step.id}: field name "${key}" cannot be referenced as steps.${step.id}.output.${key} — that path means something else to the expression grammar.`, hint: 'Rename it to letters, digits and underscores (no hyphens, spaces or dots), or address it as steps.<id>.output["' + key + '"].' });
        }
    }
}

/**
 * A step id has to be a single addressable segment: every binding downstream
 * spells it `steps.<id>.output.<field>`, and the builder/AI write exactly that
 * form. A hyphenated id turns a condition into a subtraction that evaluates to
 * NaN — silently, because the grammar accepts it (BINDABLE_SEGMENT_RE).
 *
 * WARNING, never an error: the validator sees one definition at a time with no
 * "before" to diff against, so it cannot tell a NEW bad id from one a stored
 * routine has carried for months — and an error would make those unsaveable.
 */
function checkBindableStepId(step, at, pushW) {
    if (typeof step.id !== 'string' || BINDABLE_SEGMENT_RE.test(step.id)) return;
    pushW({
        code: 'step.id_unbindable', severity: 'warning', path: at + '.id',
        message: `Step ${step.id}: this id cannot be used in a binding — "steps.${step.id}.output.…" does not mean this step to the expression grammar (a hyphen reads as minus), so those references resolve to nothing.`,
        hint: 'Rename the step id to letters, digits and underscores only (start with a letter or _), e.g. ' + JSON.stringify(String(step.id).replace(/[^A-Za-z0-9_$]/g, '_').replace(/^([0-9])/, '_$1')) + '.',
    });
}

module.exports = { checkMaxItems, checkReservedFieldNames, checkBindableStepId };
