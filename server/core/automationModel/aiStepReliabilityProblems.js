// @typecheck
'use strict';

/**
 * Everything that can be wrong with the reliability settings of an ai_step
 * (temperature, enumFrom, checks, fallback), as plain-language problems that
 * point at the field. One rule per piece: the validator shows them, the builder
 * refuses on them, and the runner's lenient reader drops what has one.
 * Pure: see aiStepReliabilitySpec.js.
 */

const {
    AI_STEP_DEFAULT_TEMPERATURE, AI_STEP_TEMPERATURE_MIN, AI_STEP_TEMPERATURE_MAX,
    MAX_ENUM_FROM, MAX_CHECKS, MAX_FALLBACK_FIELDS, CHECK_KINDS, SCRIPTS, RUN_PATH_ROOTS,
    MAX_SEGMENT_CHARS, MAX_RUN_PATH_CHARS, MAX_ITEM_PATH_CHARS, MAX_ITEMS_BOUND, MAX_IGNORE_UP_TO,
    ENUM_KEYS, CHECK_KEYS, FALLBACK_KEYS,
    isObject, present, isBinding, isFieldName, parseFieldPath, runPathFault, itemPathFault,
} = require('./aiStepReliabilitySpec');

/**
 * @typedef {{ code: string, path: string, severity: 'error'|'warning', message: string, hint: string }} Problem
 */

const RUN_PATH_HINT = 'A run path is plain run data such as steps.s2.output.totals, trigger.output.items or loop.batch: no {{ }}, and never secrets.';
const FIELD_PATH_HINT = 'A field is a name from the step\'s Structured output ("category"), "tags[]" for every item of a list, or "items[].category" for a field inside list items; up to 4 parts joined by ".".';

/**
 * @param {string} code @param {string} path @param {string} message @param {string} hint
 * @param {'error'|'warning'} [severity]
 * @returns {Problem}
 */
const issue = (code, path, message, hint, severity = 'error') => ({ code, path, severity, message, hint });

const shown = (v) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    const t = String(s === undefined ? v : s);
    return t.length > 40 ? `${t.slice(0, 39)}…` : t;
};

/** A required or optional run path at `path`. @returns {Problem|null} */
function runPathProblem(code, path, value, { required }) {
    if (!present(value) || value === '') {
        return required ? issue(code, path, `${path} is required: the list or data to check against.`, RUN_PATH_HINT) : null;
    }
    const fault = runPathFault(value);
    if (!fault) return null;
    if (fault === 'root' || fault === 'secrets') {
        return issue('ai_step.ref_root_invalid', path,
            fault === 'secrets'
                ? `${path} may not read secrets: an answer check is not a place for them.`
                : `${path} starts with "${shown(String(value).trim().split(/[.[]/)[0])}", but a run path must start with ${RUN_PATH_ROOTS.join(', ')}.`,
            RUN_PATH_HINT);
    }
    const why = { type: 'must be text', empty: 'is empty', long: `is longer than ${MAX_RUN_PATH_CHARS} characters`, braces: 'must not contain {{ }}', syntax: 'is not a path the run can read' }[fault];
    return issue(code, path, `${path} ${why}.`, RUN_PATH_HINT);
}

/** @returns {Problem|null} */
function itemPathProblem(code, path, value) {
    if (!present(value) || value === '') return null;
    const fault = itemPathFault(value);
    if (!fault) return null;
    const why = { type: 'must be text', empty: 'is empty', long: `is longer than ${MAX_ITEM_PATH_CHARS} characters`, braces: 'must not contain {{ }}', syntax: 'is not a path inside an item' }[fault];
    return issue(code, path, `${path} ${why}.`, 'Name the part of each list item that holds the value ("id", "name.en"); leave it out when the list holds plain text or numbers.');
}

/** @returns {Problem|null} */
function fieldPathProblem(code, path, value) {
    if (parseFieldPath(value)) return null;
    if (!present(value) || value === '') return issue(code, path, `${path} is required: the field of the answer this applies to.`, FIELD_PATH_HINT);
    return issue(code, path, `${path} "${shown(value)}" is not a field path.`, FIELD_PATH_HINT);
}

/** Optional boolean keys. @returns {Problem[]} */
function booleanProblems(code, base, entry, keys) {
    const out = [];
    for (const k of keys) {
        if (present(entry[k]) && typeof entry[k] !== 'boolean') {
            out.push(issue(code, `${base}.${k}`, `${base}.${k} must be true or false.`, 'Leave it out to use the default.'));
        }
    }
    return out;
}

/** Optional number within bounds. @returns {Problem|null} */
function numberProblem(code, path, value, { min, max, integer = false, what }) {
    if (!present(value)) return null;
    const ok = typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
    const range = max === Infinity ? `${min} or more` : `from ${min} to ${max}`;
    return ok ? null : issue(code, path, `${path} must be ${integer ? 'a whole number' : 'a number'} ${range}.`, `${what} Leave it out to use the default.`);
}

/** Keys a person typed that nothing reads: a warning, never silence. @returns {Problem[]} */
function unknownKeyProblems(code, base, entry, allowed) {
    const stray = Object.keys(entry).filter((k) => !allowed.includes(k));
    return stray.length ? [issue(code, base, `${base} has ${stray.map((k) => `"${shown(k)}"`).join(', ')}, which nothing reads.`, `The settings here are ${allowed.join(', ')}. Remove the rest so the entry does not look more configured than it is.`, 'warning')] : [];
}

/** @returns {Problem[]} */
function enumEntryProblems(entry, base) {
    if (!isObject(entry)) {
        return [issue('ai_step.enum_from_invalid', base, `${base} must be an object { field, ref, value?, ignoreCase?, allowEmpty? }.`, 'Pick the field of the answer and the list that holds its allowed values.')];
    }
    const out = [];
    const f = fieldPathProblem('ai_step.enum_from_invalid', `${base}.field`, entry.field);
    if (f) out.push(f);
    const r = runPathProblem('ai_step.enum_from_invalid', `${base}.ref`, entry.ref, { required: true });
    if (r) out.push(r);
    const v = itemPathProblem('ai_step.enum_from_invalid', `${base}.value`, entry.value);
    if (v) out.push(v);
    out.push(...booleanProblems('ai_step.enum_from_invalid', base, entry, ['ignoreCase', 'allowEmpty']));
    out.push(...unknownKeyProblems('ai_step.enum_from_key_ignored', base, entry, ENUM_KEYS));
    return out;
}

/** @returns {Problem[]} */
function checkEntryProblems(entry, base) {
    const code = 'ai_step.check_invalid';
    if (!isObject(entry)) {
        return [issue(code, base, `${base} must be an object with a "kind" of ${CHECK_KINDS.join(', ')}.`, 'Each check names the kind, the field of the answer it looks at, and what to compare with.')];
    }
    if (!CHECK_KINDS.includes(entry.kind)) {
        return [issue(code, `${base}.kind`, `${base}.kind must be one of ${CHECK_KINDS.join(', ')}${present(entry.kind) ? `, not "${shown(entry.kind)}"` : ''}.`, 'allowedFrom: text is one of a list; numbersFrom: numbers in a text appear in the source; script: writing system; items: how many list items.')];
    }
    const kind = /** @type {keyof typeof CHECK_KEYS} */ (entry.kind);
    const out = [];
    const f = fieldPathProblem(code, `${base}.field`, entry.field);
    if (f) out.push(f);
    if (kind === 'allowedFrom' || kind === 'numbersFrom') {
        const r = runPathProblem(code, `${base}.ref`, entry.ref, { required: true });
        if (r) out.push(r);
    }
    if (kind === 'allowedFrom') {
        const v = itemPathProblem(code, `${base}.value`, entry.value);
        if (v) out.push(v);
        out.push(...booleanProblems(code, base, entry, ['ignoreCase', 'allowEmpty']));
    } else if (kind === 'numbersFrom') {
        const t = numberProblem(code, `${base}.tolerance`, entry.tolerance, { min: 0, max: Infinity, what: 'The tolerance is how far a number may differ from the source (absolute).' });
        if (t) out.push(t);
        const u = numberProblem(code, `${base}.ignoreUpTo`, entry.ignoreUpTo, { min: 0, max: MAX_IGNORE_UP_TO, integer: true, what: 'Whole numbers up to this value (list numbers, years of one digit) are not checked.' });
        if (u) out.push(u);
        out.push(...booleanProblems(code, base, entry, ['percent', 'ignoreDates']));
    } else if (kind === 'script') {
        if (!SCRIPTS.includes(entry.script)) {
            out.push(issue(code, `${base}.script`, `${base}.script must be one of ${SCRIPTS.join(', ')}${present(entry.script) ? `, not "${shown(entry.script)}"` : ''}.`, 'It is the writing system the text must be in.'));
        }
        const m = numberProblem(code, `${base}.minRatio`, entry.minRatio, { min: 0, max: 1, what: 'The share of letters that must be in that writing system.' });
        if (m) out.push(m);
    } else {
        for (const k of ['minItems', 'maxItems']) {
            const n = numberProblem(code, `${base}.${k}`, entry[k], { min: 0, max: MAX_ITEMS_BOUND, integer: true, what: 'It is a count of list items.' });
            if (n) out.push(n);
        }
        const s = runPathProblem(code, `${base}.sameCountAs`, entry.sameCountAs, { required: false });
        if (s) out.push(s);
        if (!present(entry.minItems) && !present(entry.maxItems) && !present(entry.sameCountAs)) {
            out.push(issue(code, base, `${base} (items) needs at least one of minItems, maxItems or sameCountAs.`, 'Say how many items the list must have.'));
        } else if (typeof entry.minItems === 'number' && typeof entry.maxItems === 'number' && entry.minItems > entry.maxItems) {
            out.push(issue(code, `${base}.minItems`, `${base}.minItems (${entry.minItems}) is larger than maxItems (${entry.maxItems}), so no list can pass.`, 'Make minItems the smaller number.'));
        }
    }
    out.push(...unknownKeyProblems('ai_step.check_key_ignored', base, entry, CHECK_KEYS[kind]));
    return out;
}

/** @returns {Problem[]} */
function fallbackProblems(fb) {
    const code = 'ai_step.fallback_invalid';
    if (!present(fb)) return [];
    if (!isObject(fb)) return [issue(code, 'fallback', 'fallback must be { kind: "fail" } or { kind: "value", fields: { <output field>: binding } }.', 'Fail the step, or fill the answer with fixed values when the checks do not pass.')];
    if (fb.kind !== 'fail' && fb.kind !== 'value') {
        return [issue(code, 'fallback.kind', `fallback.kind must be "fail" or "value"${present(fb.kind) ? `, not "${shown(fb.kind)}"` : ''}.`, '"fail" stops the step with an error you can route; "value" fills the answer with the values you give.')];
    }
    const out = [];
    if (fb.kind === 'fail') {
        if (present(fb.fields)) out.push(issue('ai_step.fallback_key_ignored', 'fallback.fields', 'fallback.fields is not used when fallback.kind is "fail".', 'Use kind "value" to fill the answer, or remove the fields.', 'warning'));
        out.push(...unknownKeyProblems('ai_step.fallback_key_ignored', 'fallback', fb, FALLBACK_KEYS));
        return out;
    }
    if (!isObject(fb.fields) || Object.keys(fb.fields).length === 0) {
        out.push(issue(code, 'fallback.fields', 'fallback.fields must name at least one output field with a value, for example { category: { kind: "literal", value: "Other" } }.', 'Give each field of the answer the fixed value to use when the checks do not pass.'));
        return out;
    }
    const names = Object.keys(fb.fields);
    if (names.length > MAX_FALLBACK_FIELDS) {
        out.push(issue(code, 'fallback.fields', `fallback.fields has ${names.length} fields; at most ${MAX_FALLBACK_FIELDS} are allowed.`, 'Keep the fields the later steps read.'));
    }
    for (const name of names.slice(0, MAX_FALLBACK_FIELDS)) {
        if (!isFieldName(name)) {
            out.push(issue(code, `fallback.fields.${shown(name)}`, `fallback.fields has the field name "${shown(name)}", which is not a top-level output field name (1..${MAX_SEGMENT_CHARS} characters, no ".", "[" or "]").`, 'Use the name of a top-level field of the answer.'));
        } else if (!isBinding(fb.fields[name])) {
            out.push(issue(code, `fallback.fields.${name}`, `fallback.fields.${name} must be a binding: { kind: "literal", value } or { kind: "ref", path } or { kind: "template", value } or { kind: "expr", value }.`, 'A fixed value is { kind: "literal", value: "Other" }.'));
        }
    }
    out.push(...unknownKeyProblems('ai_step.fallback_key_ignored', 'fallback', fb, FALLBACK_KEYS));
    return out;
}

/** @returns {Problem[]} */
function temperatureProblems(t) {
    if (!present(t)) return [];
    if (typeof t === 'number' && Number.isFinite(t) && t >= AI_STEP_TEMPERATURE_MIN && t <= AI_STEP_TEMPERATURE_MAX) return [];
    return [issue('ai_step.temperature_range', 'temperature', `temperature must be a number from ${AI_STEP_TEMPERATURE_MIN} to ${AI_STEP_TEMPERATURE_MAX}.`, `${AI_STEP_DEFAULT_TEMPERATURE} is the default; lower answers vary less between runs.`)];
}

/**
 * Every shape problem of the reliability settings of one step, in plain
 * language. `path` is relative to the step ('checks[2].ref').
 * @param {any} step
 * @returns {Problem[]}
 */
function reliabilityProblems(step) {
    if (!isObject(step)) return [];
    const out = [...temperatureProblems(step.temperature)];
    if (present(step.enumFrom)) {
        if (!Array.isArray(step.enumFrom)) {
            out.push(issue('ai_step.enum_from_invalid', 'enumFrom', `enumFrom must be a list of at most ${MAX_ENUM_FROM} entries.`, 'Each entry: { field, ref, value? }.'));
        } else {
            if (step.enumFrom.length > MAX_ENUM_FROM) {
                out.push(issue('ai_step.enum_from_invalid', 'enumFrom', `enumFrom has ${step.enumFrom.length} entries; at most ${MAX_ENUM_FROM} are allowed.`, 'Keep the fields the later steps depend on.'));
            }
            const seen = new Set();
            step.enumFrom.slice(0, MAX_ENUM_FROM).forEach((e, i) => {
                const found = enumEntryProblems(e, `enumFrom[${i}]`);
                out.push(...found);
                const field = isObject(e) ? e.field : null;
                if (!found.some((p) => p.severity === 'error') && typeof field === 'string') {
                    if (seen.has(field)) out.push(issue('ai_step.enum_from_duplicate_field', `enumFrom[${i}].field`, `enumFrom[${i}].field "${shown(field)}" already has a list of allowed values.`, 'One list per field: merge the lists into one, or use another field.', 'warning'));
                    seen.add(field);
                }
            });
        }
    }
    if (present(step.checks)) {
        if (!Array.isArray(step.checks)) {
            out.push(issue('ai_step.check_invalid', 'checks', `checks must be a list of at most ${MAX_CHECKS} checks.`, 'Each check: { kind, field, ... }.'));
        } else {
            if (step.checks.length > MAX_CHECKS) {
                out.push(issue('ai_step.check_invalid', 'checks', `checks has ${step.checks.length} entries; at most ${MAX_CHECKS} are allowed.`, 'Keep the checks that matter most.'));
            }
            step.checks.slice(0, MAX_CHECKS).forEach((c, i) => out.push(...checkEntryProblems(c, `checks[${i}]`)));
        }
    }
    out.push(...fallbackProblems(step.fallback));
    return out;
}

module.exports = { reliabilityProblems, enumEntryProblems, checkEntryProblems };

/**
 * One authored enumFrom / checks entry, before validation: the fields the
 * rules read. Author JSON, so anything may be missing or of the wrong type.
 * @typedef {{ kind?: string, field?: string, ref?: unknown, value?: unknown, sameCountAs?: unknown, script?: string, minItems?: unknown, maxItems?: unknown, tolerance?: unknown, ignoreUpTo?: unknown, minRatio?: unknown, [key: string]: unknown }} ReliabilityEntry
 */

/**
 * An authored fallback, before validation.
 * @typedef {{ kind?: string, fields?: Record<string, unknown>, [key: string]: unknown }} ReliabilityFallback
 */
