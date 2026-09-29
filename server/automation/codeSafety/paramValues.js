/**
 * What a declared parameter means at run time, applied before the sandbox
 * sees the inputs (core/automationRunner/codeStepGuard.js and POST /code/test).
 *
 *   - a missing or empty value takes the declared default;
 *   - still missing and required: the run stops with a plain sentence that
 *     names the field, instead of the code throwing on `undefined` somewhere
 *     further down where nobody can tell why;
 *   - a STRING is converted to the declared type (a number typed into a text
 *     field, a JSON list pasted into a form), because upstream steps and forms
 *     hand over text;
 *   - a value outside a declared list of choices stops the run.
 *
 * Inputs the code reads without declaring them pass through untouched.
 * Pure: no I/O. Every refusal is `{ message, messageKey, messageParams }`.
 */

'use strict';

function isEmpty(v) {
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'on', 'ja', 'j', 'waar']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'off', 'nee', 'onwaar']);

/** A number from text: "12.5", "-3", "1e3", and the Dutch "12,50". Else NaN. */
function numberFrom(text) {
    const t = String(text).trim();
    if (/^-?\d+,\d{1,2}$/.test(t)) return Number(t.replace(',', '.'));
    if (t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return NaN;
    return Number(t);
}

function refusal(kind, param, extra = {}) {
    const label = param.label || param.name;
    const name = param.name;
    const texts = {
        missing: `The code step needs "${label}" (${name}), but nothing was filled in.`,
        type: `The code step needs "${label}" (${name}) to be ${extra.expected}, but got ${extra.got}.`,
        enum: `The code step needs "${label}" (${name}) to be one of ${extra.choices}, but got ${extra.got}.`,
    };
    return {
        message: texts[kind],
        messageKey: `code_step.error.param_${kind}`,
        messageParams: { label, name, ...extra },
    };
}

const EXPECTED = {
    number: 'a number',
    integer: 'a whole number',
    boolean: 'yes or no',
    object: 'an object (JSON between { })',
    array: 'a list',
};

function describe(v) {
    if (typeof v === 'string') return JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}...` : v);
    if (Array.isArray(v)) return 'a list';
    if (v === null) return 'nothing';
    if (typeof v === 'object') return 'an object';
    return String(v);
}

/** Convert one value to the declared type, or answer `{ error }`. */
function coerce(value, param) {
    const t = param.type;
    if (t === 'number' || t === 'integer') {
        let n = value;
        if (typeof value === 'string') n = numberFrom(value);
        else if (typeof value === 'boolean') n = NaN;
        if (typeof n !== 'number' || !Number.isFinite(n)) return { error: refusal('type', param, { expected: EXPECTED[t], got: describe(value) }) };
        if (t === 'integer' && !Number.isInteger(n)) return { error: refusal('type', param, { expected: EXPECTED.integer, got: describe(value) }) };
        return { value: n };
    }
    if (t === 'boolean') {
        if (typeof value === 'boolean') return { value };
        if (typeof value === 'number' && (value === 0 || value === 1)) return { value: value === 1 };
        if (typeof value === 'string') {
            const w = value.trim().toLowerCase();
            if (TRUE_WORDS.has(w)) return { value: true };
            if (FALSE_WORDS.has(w)) return { value: false };
        }
        return { error: refusal('type', param, { expected: EXPECTED.boolean, got: describe(value) }) };
    }
    if (t === 'object') {
        if (isPlainObject(value)) return { value };
        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                if (isPlainObject(parsed)) return { value: parsed };
            } catch (_) { /* refused below */ }
        }
        return { error: refusal('type', param, { expected: EXPECTED.object, got: describe(value) }) };
    }
    if (t === 'array') {
        if (Array.isArray(value)) return { value };
        if (typeof value === 'string') {
            const s = value.trim();
            if (s.startsWith('[')) {
                try {
                    const parsed = JSON.parse(s);
                    if (Array.isArray(parsed)) return { value: parsed };
                } catch (_) { /* refused below */ }
                return { error: refusal('type', param, { expected: EXPECTED.array, got: describe(value) }) };
            }
            // "a, b, c" typed into a text field is a list of texts.
            const itemType = param.items && param.items.type;
            if (!itemType || itemType === 'string') return { value: s.split(',').map((x) => x.trim()).filter(Boolean) };
            const out = [];
            for (const piece of s.split(',').map((x) => x.trim()).filter(Boolean)) {
                const c = coerce(piece, { ...param, type: itemType });
                if (c.error) return { error: refusal('type', param, { expected: EXPECTED.array, got: describe(value) }) };
                out.push(c.value);
            }
            return { value: out };
        }
        return { error: refusal('type', param, { expected: EXPECTED.array, got: describe(value) }) };
    }
    // string (with or without a format): numbers and yes/no become text; an
    // object is left alone rather than flattened into "[object Object]".
    if (typeof value === 'number' || typeof value === 'boolean') return { value: String(value) };
    return { value };
}

function checkEnum(value, param) {
    if (!Array.isArray(param.enum) || !param.enum.length) return { value };
    for (const choice of param.enum) {
        if (choice === value) return { value };
        if (typeof choice === 'string' && typeof value === 'string' && choice.toLowerCase() === value.trim().toLowerCase()) {
            return { value: choice };
        }
    }
    return { error: refusal('enum', param, { choices: param.enum.join(', '), got: describe(value) }) };
}

/**
 * Apply the declared parameters to resolved inputs.
 *
 * @param {object[]} params  CodeParam[] from analyzeCode
 * @param {object}   inputs  resolved values (never bindings)
 * @returns {{ inputs: object, error: null | { message, messageKey, messageParams } }}
 */
function applyParamValues(params, inputs) {
    const out = isPlainObject(inputs) ? { ...inputs } : {};
    for (const param of Array.isArray(params) ? params : []) {
        if (!param || typeof param.name !== 'string') continue;
        let value = out[param.name];
        if (isEmpty(value)) {
            if (param.default !== undefined) {
                out[param.name] = param.default;
                continue;
            }
            if (param.required) return { inputs: out, error: refusal('missing', param) };
            continue;
        }
        const c = coerce(value, param);
        if (c.error) return { inputs: out, error: c.error };
        value = c.value;
        const e = checkEnum(value, param);
        if (e.error) return { inputs: out, error: e.error };
        out[param.name] = e.value;
    }
    return { inputs: out, error: null };
}

module.exports = { applyParamValues, numberFrom };
