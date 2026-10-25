// @typecheck
'use strict';

/**
 * The reliability settings of an ai_step, as a specification: what the fields
 * are called, what they may hold, how the runner reads them and how a person
 * (or the builder) is told what is wrong with them. Pure: no I/O, and it
 * requires nothing outside core/automationModel and shared/expr, so the
 * validator, the builder tools and the runner all read ONE definition.
 *
 *   temperature   0..2, default 0.2
 *   enumFrom      [{ field, ref, value?, ignoreCase?, allowEmpty? }]  max 10
 *                 the allowed values are shown to the model AND checked after
 *   checks        [{ kind: allowedFrom | numbersFrom | script | items, field, ... }]  max 20
 *                 verified after the answer; never sent to the model
 *   fallback      { kind: 'fail' } | { kind: 'value', fields: { <output field>: binding } }
 *
 * Three readers, three strictnesses:
 *   normalizeAiStepReliability  lenient, for the runner: drops what it cannot
 *                               read, fills the defaults, never throws;
 *   sanitizeAiStepReliabilityArgs  strict, for the builder: refuses with a
 *                               sentence the model can act on;
 *   reliabilityProblems         for the validator: every problem, in plain
 *                               language, pointing at the field.
 * All three are built on the same per-entry rules (aiStepReliabilityProblems.js),
 * so they cannot drift; the vocabulary is aiStepReliabilitySpec.js.
 *
 * A field path (FieldPath) addresses a field of the step's answer:
 * "category", "tags[]" (every item of a list), "items[].category". A run path
 * (RunPath) is plain run data rooted at trigger./steps./vars./loop. - parsed,
 * never evaluated, never {{ }}. An item path (ItemPath) is a plain path inside
 * each list item ("id", "name.en").
 */


const {
    AI_STEP_DEFAULT_TEMPERATURE, AI_STEP_TEMPERATURE_MIN, AI_STEP_TEMPERATURE_MAX,
    MAX_ENUM_FROM, MAX_CHECKS, MAX_FALLBACK_FIELDS, FOREACH_CONCURRENCY_MAX,
    CHECK_KINDS, SCRIPTS, RUN_PATH_ROOTS, ENUM_KEYS, CHECK_KEYS,
    isObject, present, isBinding, isFieldName, parseFieldPath, aiStepCanCallTools,
    runPathFault, itemPathFault,
} = require('./aiStepReliabilitySpec');
const { reliabilityProblems, enumEntryProblems, checkEntryProblems } = require('./aiStepReliabilityProblems');

const trimmed = (v) => (typeof v === 'string' ? v.trim() : v);

/**
 * One entry in its stored shape. `fill: true` adds every default (the
 * runner's view); false writes only what was given (the builder's view).
 * @param {any} entry @param {readonly string[]} keys
 * @param {Record<string, any>} defaults @param {boolean} fill
 */
function canonicalEntry(entry, keys, defaults, fill) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const k of keys) {
        let v = entry[k];
        if (k === 'ref' || k === 'sameCountAs' || k === 'value') v = trimmed(v);
        if ((k === 'value' || k === 'sameCountAs') && v === '') v = undefined;
        if (present(v)) out[k] = v;
        else if (fill && k in defaults) out[k] = defaults[k];
    }
    return out;
}

const ENUM_DEFAULTS = { ignoreCase: true, allowEmpty: false };
const CHECK_DEFAULTS = {
    allowedFrom: ENUM_DEFAULTS,
    numbersFrom: { tolerance: 0, ignoreUpTo: 0, percent: true, ignoreDates: true },
    script: { minRatio: 1 },
    items: {},
};

/**
 * @param {Problem[]} problems
 */
const hasError = (problems) => problems.some((p) => p.severity === 'error');

/** @returns {Record<string, any> | null} */
function canonicalEnum(entry, fill) {
    if (hasError(enumEntryProblems(entry, 'e'))) return null;
    return canonicalEntry(entry, ENUM_KEYS, ENUM_DEFAULTS, fill);
}

/** @returns {Record<string, any> | null} */
function canonicalCheck(entry, fill) {
    if (hasError(checkEntryProblems(entry, 'c'))) return null;
    return canonicalEntry(entry, CHECK_KEYS[entry.kind], CHECK_DEFAULTS[entry.kind], fill);
}

/** @returns {Record<string, any> | null} null when the fallback is not a usable object. */
function canonicalFallback(fb, lenient) {
    if (!isObject(fb)) return null;
    if (fb.kind === 'fail') return { kind: 'fail' };
    if (fb.kind !== 'value' || !isObject(fb.fields)) return null;
    const names = Object.keys(fb.fields);
    const fields = {};
    let count = 0;
    for (const name of names) {
        if (!isFieldName(name) || !isBinding(fb.fields[name])) {
            if (lenient) continue;
            return null;
        }
        if (count >= MAX_FALLBACK_FIELDS) break;
        fields[name] = structuredClone(fb.fields[name]);
        count++;
    }
    return count ? { kind: 'value', fields } : null;
}

// ── The three readers ─────────────────────────────────────────────────────

/**
 * The runner's view of a step's reliability settings: lenient, never throws.
 * Entries that cannot be read are dropped, defaults are filled, lists are
 * capped. `active` says whether anything beyond the plain answer is asked of
 * the step (a list of allowed values, a check, or a fallback).
 * @param {any} step
 * @returns {{ temperature: number, enumFrom: any[], checks: any[], fallback: any, active: boolean }}
 */
function normalizeAiStepReliability(step) {
    const s = isObject(step) ? step : {};
    const t = s.temperature;
    const temperature = typeof t === 'number' && Number.isFinite(t)
        ? Math.min(AI_STEP_TEMPERATURE_MAX, Math.max(AI_STEP_TEMPERATURE_MIN, t))
        : AI_STEP_DEFAULT_TEMPERATURE;
    const enumFrom = (Array.isArray(s.enumFrom) ? s.enumFrom : []).map((e) => canonicalEnum(e, true)).filter(Boolean).slice(0, MAX_ENUM_FROM);
    const checks = (Array.isArray(s.checks) ? s.checks : []).map((c) => canonicalCheck(c, true)).filter(Boolean).slice(0, MAX_CHECKS);
    const given = canonicalFallback(s.fallback, true);
    return {
        temperature,
        enumFrom,
        checks,
        fallback: given || { kind: 'fail' },
        active: enumFrom.length > 0 || checks.length > 0 || given !== null,
    };
}

/**
 * The builder's view: strict. Returns the settings to write (only the keys
 * that were given) or one sentence naming the bad entry and what is allowed.
 * @param {any} args
 * @returns {{ value: { temperature?: number, enumFrom?: any[], checks?: any[], fallback?: any } } | { error: string, _fixHint: string }}
 */
function sanitizeAiStepReliabilityArgs(args) {
    const a = isObject(args) ? args : {};
    const probe = {
        temperature: a.temperature,
        enumFrom: a.enumFrom,
        checks: a.checks,
        fallback: a.fallback,
    };
    const refused = reliabilityProblems(probe).find((p) => p.severity === 'error' || p.code.endsWith('_key_ignored'));
    if (refused) return { error: refused.message, _fixHint: refused.hint };
    /** @type {{ temperature?: number, enumFrom?: any[], checks?: any[], fallback?: any }} */
    const value = {};
    if (present(a.temperature)) value.temperature = Math.round(a.temperature * 100) / 100;
    if (Array.isArray(a.enumFrom) && a.enumFrom.length) value.enumFrom = a.enumFrom.map((e) => canonicalEnum(e, false));
    if (Array.isArray(a.checks) && a.checks.length) value.checks = a.checks.map((c) => canonicalCheck(c, false));
    if (present(a.fallback)) value.fallback = canonicalFallback(a.fallback, false);
    return { value };
}

module.exports = {
    AI_STEP_DEFAULT_TEMPERATURE,
    AI_STEP_TEMPERATURE_MIN,
    AI_STEP_TEMPERATURE_MAX,
    MAX_ENUM_FROM,
    MAX_CHECKS,
    MAX_FALLBACK_FIELDS,
    CHECK_KINDS,
    SCRIPTS,
    RUN_PATH_ROOTS,
    FOREACH_CONCURRENCY_MAX,
    parseFieldPath,
    normalizeAiStepReliability,
    sanitizeAiStepReliabilityArgs,
    reliabilityProblems,
    aiStepCanCallTools,
    runPathFault,
    itemPathFault,
};

/** @typedef {import('./aiStepReliabilityProblems').Problem} Problem */
