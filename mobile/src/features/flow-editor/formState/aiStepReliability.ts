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
import { AI_STEP_DEFAULT_TEMPERATURE, buildReliabilityPatch as buildPatch } from '../bindings/mirror/aiStepReliability/reliabilityPatch';

export { AI_STEP_DEFAULT_TEMPERATURE };

type Rec = Record<string, unknown>;
const CHECK_KINDS: readonly string[] = ['allowedFrom', 'numbersFrom', 'script', 'items'];

const isObject = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
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

/**
 * The keys to write for these settings: the shared patch builder, so the phone
 * writes exactly what the web editor writes.
 */
export function buildReliabilityPatch(draft: FormDraft, step: Step): StepPatch {
    return buildPatch(draft, step);
}
