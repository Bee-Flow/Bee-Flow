/**
 * App Studio canonicalizer — the keyed value maps an action or a step carries:
 * input mappings, navigate params, and the post-run effects block.
 */

'use strict';

const { LIMITS, ACTION_SPECS, TOAST_TONES } = require('../componentSpecs');
const { isObject, deepCopy, truncate } = require('./shared');

function cleanInputMapping(raw, path, push) {
    if (!isObject(raw)) {
        push('mapping.invalid', path, 'inputMapping must be an object map of { param: mapping } — dropped.');
        return undefined;
    }
    const out = {};
    for (const [param, v] of Object.entries(raw)) {
        const p = `${path}.${param}`;
        if (isObject(v)) {
            if (v.kind === 'static') { out[param] = { kind: 'static', value: deepCopy(v.value) ?? null }; continue; }
            if (v.kind === 'field') {
                const entry = { kind: 'field', name: v.name };
                if (v.formId !== undefined && v.formId !== null) entry.formId = v.formId;
                out[param] = entry;
                continue;
            }
            if (!('kind' in v) && typeof v.name === 'string') {
                push('mapping.wrapped', p, 'Mapping object had a name but no kind — set kind:"field".');
                const entry = { kind: 'field', name: v.name };
                if (v.formId !== undefined && v.formId !== null) entry.formId = v.formId;
                out[param] = entry;
                continue;
            }
            if (!('kind' in v) && 'value' in v) {
                push('mapping.wrapped', p, 'Wrapped { value: … } as { kind: "static", value: … }.');
                out[param] = { kind: 'static', value: deepCopy(v.value) ?? null };
                continue;
            }
            if (typeof v.kind === 'string') { out[param] = deepCopy(v); continue; } // validator flags the kind
            push('mapping.wrapped', p, 'Wrapped bare object as { kind: "static", value: … }.');
            out[param] = { kind: 'static', value: deepCopy(v) };
            continue;
        }
        push('mapping.wrapped', p, `Wrapped bare value ${JSON.stringify(v)} as { kind: "static", value: … }.`);
        const copied = deepCopy(v);
        out[param] = { kind: 'static', value: copied === undefined ? null : copied };
    }
    return out;
}

function cleanEffects(raw, path, push) {
    if (!isObject(raw)) {
        push('action.effects_invalid', path, 'Effects must be an object { toast?, navigateTo? } — dropped.');
        return undefined;
    }
    const out = {};
    const extra = Object.keys(raw).filter((k) => k !== 'toast' && k !== 'navigateTo');
    if (raw.toast !== undefined) {
        if (isObject(raw.toast)) {
            const toast = {};
            if (typeof raw.toast.message === 'string') toast.message = truncate(raw.toast.message, ACTION_SPECS.toast.fields.message.maxLen, `${path}.toast.message`, push);
            else if (raw.toast.message !== undefined) push('action.field_invalid', `${path}.toast.message`, 'Toast message must be a string — dropped.');
            if (TOAST_TONES.includes(raw.toast.tone)) toast.tone = raw.toast.tone;
            else {
                toast.tone = 'info';
                if (raw.toast.tone !== undefined) push('action.tone_invalid', `${path}.toast.tone`, `Unknown toast tone ${JSON.stringify(raw.toast.tone)} — set to "info". Legal: ${TOAST_TONES.join(', ')}.`);
            }
            out.toast = toast;
        } else {
            push('action.effects_pruned', `${path}.toast`, 'Effects toast must be an object { message, tone? } — dropped.');
        }
    }
    if (raw.navigateTo !== undefined) {
        if (raw.navigateTo === null || typeof raw.navigateTo === 'string') out.navigateTo = raw.navigateTo;
        else push('action.effects_pruned', `${path}.navigateTo`, 'Effects navigateTo must be a screen id or null — dropped.');
    }
    if (extra.length) push('action.effects_pruned', path, `Effects pruned to { toast?, navigateTo? } — dropped: ${extra.join(', ')}.`);
    return out;
}

// Navigate params — { [key]: {kind:'static',value}|{kind:'formula',expr} }.
// Known kinds are rebuilt to their exact shape (formula exprs truncated);
// anything else is kept verbatim for validate.js to flag.
function cleanNavParams(raw, path, push) {
    if (!isObject(raw)) {
        push('action.field_invalid', path, 'params must be an object map of { key: {kind:"static"|"formula"} } — dropped.');
        return undefined;
    }
    const out = {};
    for (const [key, v] of Object.entries(raw)) {
        const p = `${path}.${key}`;
        if (isObject(v) && v.kind === 'static') {
            out[key] = { kind: 'static', value: deepCopy(v.value) };
        } else if (isObject(v) && v.kind === 'formula') {
            out[key] = {
                kind: 'formula',
                expr: typeof v.expr === 'string' ? truncate(v.expr, LIMITS.MAX_FORMULA_LEN, `${p}.expr`, push) : deepCopy(v.expr),
            };
        } else {
            out[key] = deepCopy(v); // malformed entry — validate.js flags it
        }
    }
    return out;
}

module.exports = { cleanInputMapping, cleanEffects, cleanNavParams };
