// @typecheck
/**
 * formDraftRevise.js — what "revise with AI" must NOT lose.
 *
 * The drafting model is taught a small vocabulary (label, type, required,
 * placeholder, help, choices, app). A form that already exists carries more:
 * a `showIf` condition, value rules (min / max / length / pattern / how many
 * ticks), file limits, text blocks, and choices whose stored value differs
 * from the text shown. A reply that rebuilt every question from the model's
 * words alone would silently drop all of it.
 *
 * So in revise mode the parsed questions are merged over the current ones:
 * a question that keeps its name keeps what the model was not taught, and the
 * text blocks (which the model never sees) go back where they were. Pure.
 */

'use strict';

const { normalizeFields } = require('./formTriggerContract');
const { normalizeRules } = require('./formFieldRules');
const { CHOICE_FIELD_TYPES } = require('./formFieldTypes');

/**
 * @typedef {import('./formTriggerContract').FormField} FormField
 * @typedef {import('./formTriggerContract').FormDeclaration} FormDeclaration
 */

/** @param {FormField | null | undefined} f */
const isInfo = (f) => f && f.type === 'info';

/**
 * The text blocks of the form as it is now, as plain declarations.
 * @param {FormDeclaration | null | undefined} current
 * @returns {FormField[]}
 */
function currentInfoBlocks(current) {
    const raw = Array.isArray(current?.fields) ? current.fields : [];
    return raw.filter((f) => f && typeof f === 'object' && f.type === 'info' && typeof f.name === 'string');
}

/**
 * Choices the model returned as plain text, mapped back onto the stored
 * option when it matches one by label or value: the stored VALUE (and hint)
 * stays, because switches and conditions match on it.
 * @param {string[]} options
 * @param {Array<{ label?: string, value?: string, hint?: string }> | undefined} oldOptions
 * @returns {Array<string | Record<string, any>>}
 */
function keepOptionValues(options, oldOptions) {
    if (!Array.isArray(oldOptions) || !oldOptions.length) return options;
    return options.map((text) => {
        const old = oldOptions.find((o) => o.label === text) || oldOptions.find((o) => o.value === text);
        if (!old) return text;
        return old.value === text && !old.hint && old.label === text ? text : { ...old };
    });
}

/**
 * @param {FormField[]} fields  the questions parsed from the model's reply
 * @param {FormDeclaration | null} current   the form as it is now
 * @param {{ carry?: boolean }} [opts] carry = also keep showIf, rules and file limits
 * @returns {FormField[]} the merged list, text blocks included

 */
function mergeRevision(fields, current, { carry = true } = {}) {
    const old = normalizeFields(current);
    const byName = new Map(old.map((f) => [f.name, f]));
    const merged = fields.map((f) => {
        const was = byName.get(f.name);
        if (!was || isInfo(was)) return f;
        const out = { ...f };
        if (CHOICE_FIELD_TYPES.includes(f.type) && Array.isArray(f.options)) out.options = keepOptionValues(f.options, was.options);
        if (!carry) return out;
        if (was.showIf) out.showIf = was.showIf;
        // Only the rules the NEW type accepts (and, for a date, a value that is
        // a date) come along: a number bound never lands on a date.
        Object.assign(out, normalizeRules(was, f.type));
        if (was.type !== f.type) return out;
        if (f.type === 'file') {
            if (was.accept) out.accept = was.accept;
            if (was.maxSizeMb) out.maxSizeMb = was.maxSizeMb;
        }
        if (f.type === 'app_pick') {
            if (was.maxItems && f.multiple) out.maxItems = was.maxItems;
            if (was.withText === false) out.withText = false;
        }
        return out;
    });

    // Text blocks go back right after the question (or block) that preceded
    // them; when that one is gone, after the nearest earlier one that is not.
    const blocks = new Map(currentInfoBlocks(current).map((b) => [b.name, b]));
    const order = old.map((f) => f.name);
    order.forEach((name, i) => {
        const block = blocks.get(name);
        if (!block) return;
        let at = 0;
        for (let j = i - 1; j >= 0; j -= 1) {
            const k = merged.findIndex((f) => f.name === order[j]);
            if (k >= 0) { at = k + 1; break; }
        }
        merged.splice(at, 0, { ...block });
    });
    return merged;
}

module.exports = { mergeRevision, currentInfoBlocks, keepOptionValues };
