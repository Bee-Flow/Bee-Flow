// @typecheck
'use strict';
/**
 * The checks of an ai_step answer (`enumFrom` and `checks`), evaluated after
 * the answer is parsed, guarded and RESTORED: values are judged the way
 * downstream steps will see them, against RAW run data. The reference lists
 * therefore never travel to the provider for the sake of a check.
 *
 * Pure: no I/O, nothing evaluated. Field paths are parsed (aiStepReliability
 * parseFieldPath), item paths are read with getRelativePath.
 *
 * An error is `{ code, path, message, modelValue }`:
 *   - `message` is plain English, names the rule, never a data value;
 *   - `modelValue` is what the model itself wrote at that path (pre-restore,
 *     max 200 chars). It is only for the repair prompt and is never logged or
 *     put on the step result.
 * A case-insensitive match is rewritten to the list's own spelling in the
 * answer (that is why `restored` is changed in place).
 */

const { walkList } = require('../automationModel/bind');
const { refIsSynthetic } = require('./shared');
const { listValuesOf } = require('./aiStepEnum');
const { collectSourceNumbers, hasUnsupportedNumber } = require('./aiStepNumbers');

const MODEL_VALUE_MAX = 200;

/** @type {Record<string, RegExp>} */
const SCRIPT_RES = {
    latin: /\p{Script=Latin}/u,
    cyrillic: /\p{Script=Cyrillic}/u,
    greek: /\p{Script=Greek}/u,
    arabic: /\p{Script=Arabic}/u,
    hebrew: /\p{Script=Hebrew}/u,
    han: /\p{Script=Han}/u,
    japanese: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]/u,
    hangul: /\p{Script=Hangul}/u,
    devanagari: /\p{Script=Devanagari}/u,
    thai: /\p{Script=Thai}/u,
};
const PLACEHOLDER_RE = /\[[a-z0-9_]+_\d+\]/gi;
const LETTER_RE = /\p{L}/u;

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * @param {string} k
 */
const own = (o, k) => isPlain(o) && Object.hasOwn(o, k);

/** AUTOMATION_AI_CHECK_MAX_ERRORS: errors collected per answer. 0 = unlimited. */
function maxErrors() {
    const raw = process.env.AUTOMATION_AI_CHECK_MAX_ERRORS;
    if (raw == null || String(raw).trim() === '') return 100;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 100;
}

/**
 * Every concrete place a field path points at: `items[].category` over a list
 * of three gives `items[0].category` … `items[2].category`.
 * @param {any} obj
 * @param {string} field
 * @returns {Array<{ path: string, keys: Array<string|number>, value: any }>}
 */
function valuesAtPath(obj, field) {
    const { parseFieldPath } = require('../automationModel/aiStepReliability');
    const parsed = parseFieldPath(field);
    if (!parsed) return [];
    const out = [];
    /**
     * @param {number} i
     * @param {string} path
     */
    const walk = (node, i, path, keys) => {
        if (i === parsed.segments.length) { out.push({ path, keys, value: node }); return; }
        const { name, each } = parsed.segments[i];
        const child = own(node, name) ? node[name] : undefined;
        const p = path ? `${path}.${name}` : name;
        if (!each) { walk(child, i + 1, p, [...keys, name]); return; }
        if (!Array.isArray(child)) { out.push({ path: p, keys: [...keys, name], value: undefined }); return; }
        child.forEach((el, idx) => walk(el, i + 1, `${p}[${idx}]`, [...keys, name, idx]));
    };
    walk(obj, 0, '', []);
    return out;
}

/**
 * @param {(string | number)[]} keys
 */
function valueAtKeys(obj, keys) {
    let node = obj;
    for (const k of keys) {
        if (Array.isArray(node) && typeof k === 'number') node = node[k];
        else if (own(node, String(k))) node = node[k];
        else return undefined;
    }
    return node;
}

/**
 * @param {(string | number)[]} keys
 */
function setAtKeys(obj, keys, value) {
    const parent = valueAtKeys(obj, keys.slice(0, -1));
    if (parent && typeof parent === 'object') parent[keys[keys.length - 1]] = value;
}

/**
 * What the model wrote at a place, as short text for the repair prompt.
 * @param {string[] | (string | number)[]} keys
 */
function modelValueAt(modelOutput, keys) {
    const v = valueAtKeys(modelOutput, keys);
    if (v === undefined || v === null) return '';
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return String(text).slice(0, MODEL_VALUE_MAX);
}

function stringsIn(value, out = []) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const x of value) stringsIn(x, out);
    else if (isPlain(value)) for (const x of Object.values(value)) stringsIn(x, out);
    return out;
}

/** Share of the letters in `value` (placeholders removed) that belong to `script`; null without letters. */
function scriptRatio(value, script) {
    const re = SCRIPT_RES[script];
    if (!re) return null;
    let letters = 0;
    let inScript = 0;
    for (const s of stringsIn(value)) {
        for (const ch of s.replace(PLACEHOLDER_RE, ' ')) {
            if (!LETTER_RE.test(ch)) continue;
            letters += 1;
            if (re.test(ch)) inScript += 1;
        }
    }
    return letters === 0 ? null : inScript / letters;
}

const JSON_TYPE_OK = {
    string: (v) => typeof v === 'string',
    number: (v) => typeof v === 'number' && Number.isFinite(v),
    integer: (v) => Number.isInteger(v),
    boolean: (v) => typeof v === 'boolean',
    array: (v) => Array.isArray(v),
    object: (v) => isPlain(v),
};

/**
 * Top-level declared types and required fields of the schema.
 * @param {(arg0: string, name: string, arg2: string) => void} push
 */
function schemaTypeErrors(restored, schema, push) {
    if (!isPlain(schema) || !isPlain(schema.properties)) return;
    if (!isPlain(restored)) { push('no_answer', '', 'the step did not return an object'); return; }
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [name, def] of Object.entries(schema.properties)) {
        const v = own(restored, name) ? restored[name] : undefined;
        if (v === undefined) {
            if (required.has(name)) push('schema_type', name, 'this field is required');
            continue;
        }
        const types = [].concat(isPlain(def) && def.type ? def.type : []);
        if (!types.length) continue;
        const ok = types.some((t) => (t === 'null' ? v === null : JSON_TYPE_OK[t] ? JSON_TYPE_OK[t](v) : true));
        if (!ok) push('schema_type', name, `this field must be of type ${types.join(' or ')}`);
    }
}

/**
 * The list spelling for a value, or null when the list does not hold it.
 * @param {string} text
 */
function matchAllowed(text, list) {
    if (list.exact.has(text)) return text;
    return list.ignoreCase ? (list.folded.get(text.toLowerCase()) ?? null) : null;
}

/**
 * @param {string[]} values
 * @param {boolean} ignoreCase
 */
function allowedIndex(values, ignoreCase) {
    const folded = new Map();
    if (ignoreCase) for (const v of values) if (!folded.has(v.toLowerCase())) folded.set(v.toLowerCase(), v);
    return { exact: new Set(values), folded, ignoreCase };
}

/**
 * Evaluate the answer. `restored` may be rewritten (list spelling).
 * @param {{ restored: any, modelOutput: any, rel: any, lists: any[], runState: any, mode: string, ctx?: any, schema?: any }} p
 * @returns {Array<{ code: string, path: string, message: string, modelValue: string }>}
 */
function evaluateAnswer({ restored, modelOutput, rel, lists, runState, mode, ctx, schema }) {
    /** @type {{ code: string; path: string; message: string; modelValue: string; }[]} */
    const errors = [];
    const cap = maxErrors();
    const full = () => cap > 0 && errors.length >= cap;
    /**
     * @param {string} code
     * @param {string} path
     * @param {string} message
     * @param {string[] | (string | number)[] | null} [keys]
     */
    const push = (code, path, message, keys) => {
        if (full()) return;
        errors.push({ code, path, message, modelValue: keys ? modelValueAt(modelOutput, keys) : '' });
    };
    const synthetic = (ref) => mode === 'dry_run' && refIsSynthetic(ref, runState, ctx || {});

    if (restored === null || restored === undefined || restored === '') {
        push('no_answer', '', 'the step did not return an answer');
        return errors;
    }
    if (schema) schemaTypeErrors(restored, schema, (c, p, m) => push(c, p, m, p ? [p] : null));

    /**
     * Each value at `field` must be one of `list`.
     * @param {string} field
     * @param {boolean} allowEmpty
     */
    const checkAllowed = (field, list, allowEmpty) => {
        for (const at of valuesAtPath(restored, field)) {
            const v = at.value;
            const blank = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
            if (blank) { if (!allowEmpty) push('missing', at.path, 'a value is required', at.keys); continue; }
            const text = typeof v === 'string' ? v.trim() : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : null;
            const hit = text === null ? null : matchAllowed(text, list);
            if (hit === null) { push('not_allowed', at.path, 'the value is not one of the allowed values', at.keys); continue; }
            if (typeof v === 'string' && hit !== v) setAtKeys(restored, at.keys, hit);
        }
    };
    /**
     * @param {string} field
     */
    const emptyList = (field) => push('missing', field, 'the list of allowed values is empty');

    for (const l of lists || []) {
        if (!l.ok) emptyList(l.field);
        else checkAllowed(l.field, allowedIndex(l.values, l.ignoreCase), l.allowEmpty);
    }

    for (const check of rel.checks || []) {
        if (full()) break;
        if (check.kind === 'allowedFrom') {
            if (synthetic(check.ref)) continue;
            const res = listValuesOf(check, runState);
            if (!res.ok) emptyList(check.field);
            else checkAllowed(check.field, allowedIndex(res.values, check.ignoreCase !== false), check.allowEmpty === true);
        } else if (check.kind === 'numbersFrom') {
            if (synthetic(check.ref)) continue;
            const sorted = collectSourceNumbers(walkList(check.ref, { ...runState, secrets: {} }));
            for (const at of valuesAtPath(restored, check.field)) {
                if (at.value !== undefined && hasUnsupportedNumber(at.value, sorted, check)) {
                    push('number_not_in_source', at.path, 'it contains a number that does not appear in the source data', at.keys);
                }
            }
        } else if (check.kind === 'script') {
            const min = typeof check.minRatio === 'number' ? check.minRatio : 1;
            for (const at of valuesAtPath(restored, check.field)) {
                const ratio = scriptRatio(at.value, check.script);
                if (ratio !== null && ratio < min) push('wrong_script', at.path, `the text is not written in the ${check.script} script`, at.keys);
            }
        } else if (check.kind === 'items') {
            const sameAs = check.sameCountAs && !synthetic(check.sameCountAs)
                ? walkList(check.sameCountAs, { ...runState, secrets: {} }) : undefined;
            for (const at of valuesAtPath(restored, check.field)) {
                const v = at.value;
                if (!Array.isArray(v)) { push('not_a_list', at.path, 'it must be a list', at.keys); continue; }
                if (typeof check.minItems === 'number' && v.length < check.minItems) push('too_few_items', at.path, `the list needs at least ${check.minItems} items`, at.keys);
                if (typeof check.maxItems === 'number' && v.length > check.maxItems) push('too_many_items', at.path, `the list may have at most ${check.maxItems} items`, at.keys);
                if (Array.isArray(sameAs) && sameAs.length !== v.length) push('count_mismatch', at.path, 'it must have as many items as the source list', at.keys);
            }
        }
    }
    return errors;
}

/**
 * "<path>: <rule>" for the first five errors: a failure message that holds no data values.
 * @param {{ code: string; path: string; message: string; modelValue: string; }[]} errors
 */
function errorSummary(errors) {
    return errors.slice(0, 5).map((e) => `${e.path || 'answer'}: ${e.message}`).join('; ');
}

module.exports = { evaluateAnswer, valuesAtPath, errorSummary, scriptRatio, MODEL_VALUE_MAX };
