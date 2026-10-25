/**
 * The reliability settings of an AI step as the form edits them: a list of
 * allowed values the model is shown (enumFrom), checks run after the answer
 * (checks), what to do when the answer still fails (fallback), how varied the
 * answers are (temperature). Mirrors the server contract in
 * server/core/automationModel/aiStepReliability.js.
 *
 * Pure: no React. Three jobs.
 *   readReliability   stored step -> draft pieces (extractFormState)
 *   buildReliabilityPatch   draft -> the keys to write (buildPatch)
 *   the small readers the editor needs: which output fields a check may name,
 *   whether the items of a "run once per item" step may run side by side.
 *
 * Off has ONE spelling, absent: an empty list, the 'fail' fallback and the
 * default temperature are written as `undefined`, which drops out of the JSON
 * after the patch merge, so opening an untouched step never rewrites it.
 */
import { normalizeAskOnce } from '../formState/stepOptions';
import type { FormRecord, JsonValue } from '../formState/types';
import {
    AI_STEP_DEFAULT_TEMPERATURE, buildReliabilityPatch, tidyCheck,
    type AllowedFromCheck, type Binding, type Check, type CheckKind, type EnumFrom, type Fallback, type ItemsCheck, type NumbersFromCheck, type ScriptCheck,
} from './reliabilityPatch';

export { AI_STEP_DEFAULT_TEMPERATURE, buildReliabilityPatch, tidyCheck };
export type { AllowedFromCheck, Binding, Check, CheckKind, EnumFrom, Fallback, ItemsCheck, NumbersFromCheck, ScriptCheck };

export const SCRIPTS = ['latin', 'cyrillic', 'greek', 'arabic', 'hebrew', 'han', 'japanese', 'hangul', 'devanagari', 'thai'] as const;
type ScriptName = typeof SCRIPTS[number];

export const AI_STEP_TEMPERATURE_MIN = 0;
export const AI_STEP_TEMPERATURE_MAX = 2;
export const MAX_ENUM_FROM = 10;
export const MAX_CHECKS = 20;
export const FOREACH_CONCURRENCY_MAX = 1000;

/** The slice of the form draft these settings live in. */
export interface ReliabilityDraft {
    temperature: number | null;
    enumFrom: EnumFrom[];
    checks: Check[];
    fallback: Fallback | null;
    askOnce: ReturnType<typeof normalizeAskOnce>;
}

const isObject = (v: unknown): v is FormRecord => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const CHECK_KINDS: readonly string[] = ['allowedFrom', 'numbersFrom', 'script', 'items'];

// ── Reading ───────────────────────────────────────────────────────────────

/** Stored step -> the draft pieces. Lenient: what cannot be read is left out, nothing throws. */
export function readReliability(step: FormRecord | null | undefined): ReliabilityDraft {
    const s: FormRecord = isObject(step) ? step : {};
    const t = s.temperature;
    return {
        temperature: typeof t === 'number' && Number.isFinite(t) ? t : null,
        enumFrom: (Array.isArray(s.enumFrom) ? s.enumFrom : []).filter(isObject).map(e => structuredClone(e) as EnumFrom),
        checks: (Array.isArray(s.checks) ? s.checks : [])
            .filter((c: unknown) => isObject(c) && CHECK_KINDS.includes(c.kind as string))
            .map((c: FormRecord) => structuredClone(c) as Check),
        fallback: readFallback(s.fallback),
        askOnce: normalizeAskOnce(s.askOnce),
    };
}

function readFallback(value: JsonValue): Fallback | null {
    if (!isObject(value)) return null;
    if (value.kind === 'fail') return { kind: 'fail' };
    if (value.kind !== 'value') return null;
    return { kind: 'value', fields: isObject(value.fields) ? structuredClone(value.fields) as Record<string, Binding> : {} };
}

// ── Writing ───────────────────────────────────────────────────────────────

/** Literal text -> the typed value for a field of that type; anything else stays text. */
export function bindingFromText(raw: string, fieldType: string | undefined): Binding | null {
    if (!raw.trim()) return null;
    if (raw.includes('{{')) return { kind: 'template', value: raw };
    if (fieldType === 'number') {
        const n = Number(raw);
        if (raw.trim() !== '' && Number.isFinite(n)) return { kind: 'literal', value: n };
    }
    if (fieldType === 'boolean' && (raw.trim() === 'true' || raw.trim() === 'false')) {
        return { kind: 'literal', value: raw.trim() === 'true' };
    }
    if (fieldType === 'array' || fieldType === 'object') {
        try { return { kind: 'literal', value: JSON.parse(raw) }; } catch { return null; }
    }
    return { kind: 'literal', value: raw };
}

/** A fallback binding as the text box shows it. */
export function textFromBinding(b: Binding | undefined): string {
    if (!b) return '';
    if (b.kind === 'template' || b.kind === 'expr') return b.value;
    if (b.kind === 'ref') return `{{${b.path}}}`;
    if (typeof b.value === 'string') return b.value;
    if (b.value === null || b.value === undefined) return '';
    return typeof b.value === 'object' ? JSON.stringify(b.value) : String(b.value);
}

// ── What the editor needs to know ─────────────────────────────────────────

/** Is anything beyond a plain answer asked of this step? Drives the "has content" dot. */
export function reliabilityIsSet(draft: FormRecord | null | undefined): boolean {
    if (!draft) return false;
    return (Array.isArray(draft.enumFrom) && draft.enumFrom.length > 0)
        || (Array.isArray(draft.checks) && draft.checks.length > 0)
        || draft.fallback?.kind === 'value';
}

export type FieldKind = 'text' | 'number' | 'list' | 'other';

/** A field of the answer a check may name. `label` is the path; the editor words it for the reader. */
export interface FieldPathOption {
    path: string;
    label: string;
    kind: FieldKind;
    /** The top-level output field the path belongs to. */
    field: string;
    /** The part inside each item or object, when the path goes deeper. */
    column?: string;
    /** The path reads every item of a list. */
    each: boolean;
}

const SEGMENT_OK = (name: unknown): name is string => typeof name === 'string' && name.length >= 1 && name.length <= 100 && !/[.[\]]/.test(name);

function kindOfType(type: unknown): FieldKind {
    if (type === 'string' || type === 'datetime') return 'text';
    if (type === 'number' || type === 'integer') return 'number';
    if (type === 'array') return 'list';
    return 'other';
}

/** The kind of a JSON-schema fragment (datetime strings are text). */
function kindOfSpec(spec: unknown): FieldKind {
    if (typeof spec === 'string') return kindOfType(spec);
    return isObject(spec) ? kindOfType(spec.type) : 'other';
}

const option = (path: string, kind: FieldKind, field: string, extra: Partial<FieldPathOption> = {}): FieldPathOption =>
    ({ path, label: path, kind, field, each: false, ...extra });

/** The paths under a list: its columns, the parts of its items, or the items themselves. */
function listPaths(key: string, f: FormRecord): FieldPathOption[] {
    const itemProps = isObject(f.itemsSpec) && isObject(f.itemsSpec.properties) ? f.itemsSpec.properties : null;
    const columns: FormRecord[] = (Array.isArray(f.columns) ? f.columns : []).filter(c => SEGMENT_OK(typeof c?.key === 'string' ? c.key.trim() : ''));
    const each = (col: string, kind: FieldKind) => option(`${key}[].${col}`, kind, key, { column: col, each: true });
    if (columns.length) return columns.map(c => each(String(c.key).trim(), kindOfType(c.type)));
    if (itemProps) return Object.entries(itemProps).filter(([col]) => SEGMENT_OK(col)).map(([col, spec]) => each(col, kindOfSpec(spec)));
    const itemKind = isObject(f.itemsSpec) ? kindOfSpec(f.itemsSpec) : 'text';
    return [option(`${key}[]`, itemKind, key, { each: true })];
}

/** The scalar parts of an object field. */
function objectPaths(key: string, spec: FormRecord): FieldPathOption[] {
    return Object.entries(spec)
        .filter(([sub]) => SEGMENT_OK(sub))
        .map(([sub, s]) => option(`${key}.${sub}`, kindOfSpec(s), key, { column: sub }));
}

/**
 * The paths a check may name, from the form's output field model
 * (formState/outputSchema.ts): every top-level field, "tags[]" for each item of
 * a list, "rows[].name" for a column of a table, "address.city" for a part of
 * an object. A free-form list is offered as a list of text, which is what it
 * nearly always holds.
 */
export function outputFieldPaths(outputFields: FormRecord[] | null | undefined): FieldPathOption[] {
    const out: FieldPathOption[] = [];
    const seen = new Set<string>();
    for (const f of outputFields || []) {
        const key = typeof f?.key === 'string' ? f.key.trim() : '';
        if (!SEGMENT_OK(key)) continue;
        const parts = [option(key, kindOfType(f.type), key)];
        if (f.type === 'array') parts.push(...listPaths(key, f));
        else if (f.type === 'object' && isObject(f.objectSpec)) parts.push(...objectPaths(key, f.objectSpec));
        for (const o of parts) if (!seen.has(o.path)) { seen.add(o.path); out.push(o); }
    }
    return out;
}

/**
 * Whether the items of a "run once per item" AI step may run side by side.
 * Mirrors the runner (core/automationRunner/forEachConcurrency.js): never when
 * the model could be offered a tool, because a tool may change something and
 * the items would no longer happen in order. Skills and an agent's right to
 * start automations count as tools. A draft without any of these keys (an
 * extraction step) can always run in parallel.
 */
export function canRunItemsInParallel(draft: FormRecord | null | undefined): boolean {
    if (!draft) return true;
    if (draft.allowTools === true) return false;
    if (Array.isArray(draft.tools) && draft.tools.length > 0) return false;
    if (Array.isArray(draft.skillIds) && draft.skillIds.length > 0) return false;
    const agentId = typeof draft.agentId === 'string' ? draft.agentId.trim() : '';
    if (agentId && isObject(draft.agentPermissions)) {
        if (draft.agentPermissions.useTools === true || draft.agentPermissions.startAutomations === true) return false;
    }
    return true;
}

/** Can this step be offered a tool? The answer is then not reused. Same rule as canRunItemsInParallel. */
export const mayUseTools = (draft: FormRecord | null | undefined): boolean => !canRunItemsInParallel(draft);

// ── Problems per card ─────────────────────────────────────────────────────

interface IssueRecord { path?: unknown; message?: unknown; hint?: unknown }

/** Where a validation finding sits: 'enumFrom:0', 'checks:2' or 'fallback'. */
export function issueSlot(path: unknown): string | null {
    if (typeof path !== 'string') return null;
    const m = /(?:^|\.)(enumFrom|checks)\[(\d+)\]/.exec(path);
    if (m) return `${m[1]}:${m[2]}`;
    return /(?:^|\.)fallback(?:\.|$)/.test(path) ? 'fallback' : null;
}

/** The first error text per card, so the card can ring red with the reason. */
export function reliabilityProblems(stepIssues: { errors?: IssueRecord[] } | null | undefined): Map<string, string> {
    const out = new Map<string, string>();
    for (const rec of stepIssues?.errors || []) {
        const slot = issueSlot(rec?.path);
        if (!slot || out.has(slot) || typeof rec.message !== 'string') continue;
        out.set(slot, rec.message.replace(/^Step [^:]+: /, ''));
    }
    return out;
}
