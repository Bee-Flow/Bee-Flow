/**
 * The reliability settings of an AI step: allowed values the model is shown
 * (enumFrom), checks run after the answer (checks), what to do when the answer
 * still fails (fallback), how varied the answers are (temperature) and "reuse
 * the answer" (askOnce). From agent-hub
 * `Builder/flow/settings/aiStepReliability/reliabilityModel.ts` (only the
 * reading and writing half); pinned by formState.lockstep.test.ts.
 *
 * Off has ONE spelling, absent: an empty list, the 'fail' fallback and the
 * default temperature are written as `undefined`, which drops out of the JSON
 * after the patch merge, so opening an untouched step never rewrites it.
 */

import { normalizeAskOnce } from './common';
import type { FormDraft, Step, StepPatch } from './types';

export const AI_STEP_DEFAULT_TEMPERATURE = 0.2;

type Rec = Record<string, unknown>;
const CHECK_KINDS: readonly string[] = ['allowedFrom', 'numbersFrom', 'script', 'items'];

const isObject = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A JSON-safe deep copy, so a draft edit never reaches the stored step. */
function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
}

function readFallback(value: unknown): Rec | null {
    if (!isObject(value)) return null;
    if (value.kind === 'fail') return { kind: 'fail' };
    if (value.kind !== 'value') return null;
    return { kind: 'value', fields: isObject(value.fields) ? clone(value.fields) : {} };
}

/** Stored step -> the draft pieces. Lenient: what cannot be read is left out, nothing throws. */
export function readReliability(step: Step | null | undefined): FormDraft {
    const s: Rec = isObject(step) ? step : {};
    const t = s.temperature;
    return {
        temperature: isNumber(t) ? t : null,
        enumFrom: (Array.isArray(s.enumFrom) ? s.enumFrom : []).filter(isObject).map((e: Rec) => clone(e)),
        checks: (Array.isArray(s.checks) ? s.checks : [])
            .filter((c: unknown) => isObject(c) && CHECK_KINDS.includes(c.kind as string))
            .map((c: Rec) => clone(c)),
        fallback: readFallback(s.fallback),
        askOnce: normalizeAskOnce(s.askOnce),
    };
}

const num = (v: unknown): number | undefined => {
    if (v === '' || v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
};

/** Only the keys that carry a choice: an unset optional or a value equal to the default is left out. */
function tidyEnumEntry(e: Rec): Rec {
    const out: Rec = { field: text(e.field), ref: text(e.ref).trim() };
    const value = text(e.value).trim();
    if (value) out.value = value;
    if (e.ignoreCase === false) out.ignoreCase = false;
    if (e.allowEmpty === true) out.allowEmpty = true;
    return out;
}

function tidyNumbersFrom(c: Rec): Rec {
    const out: Rec = { kind: 'numbersFrom', field: text(c.field), ref: text(c.ref).trim() };
    const tolerance = num(c.tolerance);
    if (tolerance !== undefined && tolerance > 0) out.tolerance = tolerance;
    const upTo = num(c.ignoreUpTo);
    if (upTo !== undefined && upTo > 0) out.ignoreUpTo = Math.round(upTo);
    if (c.percent === false) out.percent = false;
    if (c.ignoreDates === false) out.ignoreDates = false;
    return out;
}

function tidyScript(c: Rec): Rec {
    const out: Rec = { kind: 'script', field: text(c.field), script: text(c.script) };
    const ratio = num(c.minRatio);
    if (ratio !== undefined && ratio !== 1) out.minRatio = ratio;
    return out;
}

function tidyItems(c: Rec): Rec {
    const out: Rec = { kind: 'items', field: text(c.field) };
    const min = num(c.minItems);
    if (min !== undefined && min > 0) out.minItems = Math.round(min);
    const max = num(c.maxItems);
    if (max !== undefined && max >= 0) out.maxItems = Math.round(max);
    const same = text(c.sameCountAs).trim();
    if (same) out.sameCountAs = same;
    return out;
}

/** One check in its stored shape. Required keys stay even when empty, so the validator can point at the card. */
function tidyCheck(c: Rec): Rec {
    if (c.kind === 'allowedFrom') return { kind: 'allowedFrom', ...tidyEnumEntry(c) };
    if (c.kind === 'numbersFrom') return tidyNumbersFrom(c);
    if (c.kind === 'script') return tidyScript(c);
    return tidyItems(c);
}

function tidyFallback(fallback: Rec | null, step: Rec, hasChecks: boolean): Rec | undefined | null {
    if (fallback?.kind === 'value') {
        const fields: Rec = {};
        const src = isObject(fallback.fields) ? fallback.fields : {};
        for (const [name, b] of Object.entries(src)) {
            if (name && isObject(b) && b.kind) fields[name] = b;
        }
        // No value typed yet is the same as "stop with an error": nothing to write.
        if (Object.keys(fields).length) return { kind: 'value', fields };
    }
    if (!isObject(step.fallback)) return null; // nothing stored, nothing to clear
    // An explicit { kind: 'fail' } next to checks is the author's own: keep it as it was.
    if (hasChecks && step.fallback.kind === 'fail' && fallback?.kind !== 'value') return { kind: 'fail' };
    return undefined;
}

/** A list is written when it has entries, cleared (undefined) when it had some, and left alone otherwise. */
function listPatch(patch: Rec, key: string, entries: unknown[], step: Rec): void {
    if (entries.length) patch[key] = entries;
    else if (step[key] !== undefined) patch[key] = undefined;
}

function temperaturePatch(patch: Rec, t: unknown, step: Rec): void {
    if (isNumber(t)) {
        // The default is not written on a step that has no temperature of its own.
        if (!(t === AI_STEP_DEFAULT_TEMPERATURE && step.temperature === undefined)) patch.temperature = t;
    } else if (step.temperature !== undefined) {
        patch.temperature = undefined;
    }
}

/**
 * The keys to write for these settings. A key is present only when it has a
 * value to set or an existing one to clear, so an untouched legacy step adds
 * nothing to the patch.
 */
export function buildReliabilityPatch(draft: FormDraft, step: Step): StepPatch {
    const s: Rec = step;
    const patch: Rec = {};
    temperaturePatch(patch, draft.temperature, s);

    const enumFrom = (Array.isArray(draft.enumFrom) ? draft.enumFrom : []).filter(isObject).map(tidyEnumEntry);
    listPatch(patch, 'enumFrom', enumFrom, s);
    const checks = (Array.isArray(draft.checks) ? draft.checks : []).filter(isObject).map(tidyCheck);
    listPatch(patch, 'checks', checks, s);

    const fallback = tidyFallback(isObject(draft.fallback) ? draft.fallback : null, s, enumFrom.length + checks.length > 0);
    if (fallback) patch.fallback = fallback;
    else if (fallback === undefined) patch.fallback = undefined;
    return patch;
}

