/**
 * The writing half of the AI step's reliability settings, shared with the phone.
 * agent-hub is the source; scripts/gen-shared-mirror.mjs copies it to
 * mobile/src/features/flow-editor/bindings/mirror/aiStepReliability/ (npm run
 * gen:shared), so web and phone write exactly the same patch.
 *
 * Pure: no React. `draft` -> the keys to write; see reliabilityModel.ts for the
 * reading half and the editor helpers.
 */
import type { FormRecord } from '../formState/types';

export const AI_STEP_DEFAULT_TEMPERATURE = 0.2;

/** A list of allowed values for one field of the answer. */
export interface EnumFrom {
    field: string;
    ref: string;
    value?: string;
    ignoreCase?: boolean;
    allowEmpty?: boolean;
}

export type CheckKind = 'allowedFrom' | 'numbersFrom' | 'script' | 'items';

export interface AllowedFromCheck extends EnumFrom { kind: 'allowedFrom' }
export interface NumbersFromCheck {
    kind: 'numbersFrom'; field: string; ref: string;
    tolerance?: number; ignoreUpTo?: number; percent?: boolean; ignoreDates?: boolean;
}
export interface ScriptCheck { kind: 'script'; field: string; script: string; minRatio?: number }
export interface ItemsCheck { kind: 'items'; field: string; minItems?: number; maxItems?: number; sameCountAs?: string }
export type Check = AllowedFromCheck | NumbersFromCheck | ScriptCheck | ItemsCheck;

export type Binding =
    | { kind: 'literal'; value: unknown }
    | { kind: 'ref'; path: string }
    | { kind: 'template'; value: string }
    | { kind: 'expr'; value: string };
export type Fallback = { kind: 'fail' } | { kind: 'value'; fields: Record<string, Binding> };

const isObject = (v: unknown): v is FormRecord => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

// ── Writing ───────────────────────────────────────────────────────────────

const num = (v: unknown): number | undefined => {
    if (v === '' || v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
};

/** Only the keys that carry a choice: an unset optional or a value equal to the default is left out. */
function tidyEnumEntry(e: EnumFrom): EnumFrom {
    const out: EnumFrom = { field: text(e.field), ref: text(e.ref).trim() };
    const value = text(e.value).trim();
    if (value) out.value = value;
    if (e.ignoreCase === false) out.ignoreCase = false;
    if (e.allowEmpty === true) out.allowEmpty = true;
    return out;
}

function tidyNumbersFrom(c: NumbersFromCheck): NumbersFromCheck {
    const out: NumbersFromCheck = { kind: 'numbersFrom', field: text(c.field), ref: text(c.ref).trim() };
    const tolerance = num(c.tolerance);
    if (tolerance !== undefined && tolerance > 0) out.tolerance = tolerance;
    const upTo = num(c.ignoreUpTo);
    if (upTo !== undefined && upTo > 0) out.ignoreUpTo = Math.round(upTo);
    if (c.percent === false) out.percent = false;
    if (c.ignoreDates === false) out.ignoreDates = false;
    return out;
}

function tidyScript(c: ScriptCheck): ScriptCheck {
    const out: ScriptCheck = { kind: 'script', field: text(c.field), script: text(c.script) };
    const ratio = num(c.minRatio);
    if (ratio !== undefined && ratio !== 1) out.minRatio = ratio;
    return out;
}

function tidyItems(c: ItemsCheck): ItemsCheck {
    const out: ItemsCheck = { kind: 'items', field: text(c.field) };
    const min = num(c.minItems);
    if (min !== undefined && min > 0) out.minItems = Math.round(min);
    const max = num(c.maxItems);
    if (max !== undefined && max >= 0) out.maxItems = Math.round(max);
    const same = text(c.sameCountAs).trim();
    if (same) out.sameCountAs = same;
    return out;
}

/** One check in its stored shape. Required keys stay even when empty, so the validator can point at the card. */
export function tidyCheck(c: Check): Check {
    if (c.kind === 'allowedFrom') return { kind: 'allowedFrom', ...tidyEnumEntry(c) };
    if (c.kind === 'numbersFrom') return tidyNumbersFrom(c);
    if (c.kind === 'script') return tidyScript(c);
    return tidyItems(c);
}

function tidyFallback(fallback: Fallback | null, step: FormRecord, hasChecks: boolean): Fallback | undefined | null {
    if (fallback?.kind === 'value') {
        const fields: Record<string, Binding> = {};
        for (const [name, b] of Object.entries(fallback.fields || {})) {
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

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A list is written when it has entries, cleared (undefined) when it had some, and left alone otherwise. */
function listPatch(patch: FormRecord, key: string, entries: unknown[], step: FormRecord): void {
    if (entries.length) patch[key] = entries;
    else if (step[key] !== undefined) patch[key] = undefined;
}

function temperaturePatch(patch: FormRecord, t: unknown, step: FormRecord): void {
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
export function buildReliabilityPatch(draft: FormRecord, step: FormRecord): FormRecord {
    const patch: FormRecord = {};
    temperaturePatch(patch, draft.temperature, step);

    const enumFrom: EnumFrom[] = (Array.isArray(draft.enumFrom) ? draft.enumFrom : []).filter(isObject).map(e => tidyEnumEntry(e as EnumFrom));
    listPatch(patch, 'enumFrom', enumFrom, step);
    const checks: Check[] = (Array.isArray(draft.checks) ? draft.checks : []).filter(isObject).map(c => tidyCheck(c as Check));
    listPatch(patch, 'checks', checks, step);

    const fallback = tidyFallback(isObject(draft.fallback) ? draft.fallback as Fallback : null, step, enumFrom.length + checks.length > 0);
    if (fallback) patch.fallback = fallback;
    else if (fallback === undefined) patch.fallback = undefined;
    return patch;
}

