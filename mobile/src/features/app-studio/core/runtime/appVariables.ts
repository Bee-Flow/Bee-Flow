/**
 * The client mirror of the variable vocabulary in server/appStudio/
 * componentSpecs.js. Port of agent-hub AppStudio/runtime/appVariables.js,
 * pinned by appVariables.lockstep.test.ts (differential against the web, and
 * the constants against the server module).
 *
 * A mirror, not a fetch: the runtime seeds `vars` at mount, before any
 * catalog request could land.
 */

import { sameValue } from '../sameValue';
import type { AppVariable } from '../types';

export const VARIABLE_TYPES = ['text', 'number', 'yesno', 'date', 'record', 'list', 'any'] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export const VARIABLE_TYPE_DEFAULTS: Readonly<Record<VariableType, unknown>> = {
    text: '',
    number: 0,
    yesno: false,
    date: null,
    record: {},
    list: [],
    any: null,
};

export const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;
export const RESERVED_VARIABLE_NAMES = ['filters', 'true', 'false', 'null'];
export const MAX_VARIABLES = 30;
export const MAX_VARIABLE_DEFAULT_BYTES = 2048;
export const MAX_VARIABLE_NAME_LEN = 60;
export const MAX_VARIABLE_LABEL_LEN = 80;
export const MAX_VARIABLE_DESCRIPTION_LEN = 500;
const MAX_STRING = 5000;
const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTF-8 length of a string, without relying on TextEncoder being present. */
function utf8Length(text: string): number {
    let bytes = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0) as number;
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
}

function jsonBytes(value: unknown): number {
    try {
        const text = JSON.stringify(value);
        return text === undefined ? 4 : utf8Length(text);
    } catch {
        return Infinity;
    }
}

export interface Coerced {
    value: unknown;
    coerced: boolean;
}

const ok = (value: unknown): Coerced => ({ value, coerced: false });
const fixed = (value: unknown): Coerced => ({ value, coerced: true });

function coerceText(value: unknown): Coerced | null {
    if (typeof value === 'string') return value.length > MAX_STRING ? fixed(value.slice(0, MAX_STRING)) : ok(value);
    if (typeof value === 'number' && Number.isFinite(value)) return fixed(String(value));
    if (typeof value === 'boolean') return fixed(String(value));
    return null;
}

function coerceNumber(value: unknown): Coerced | null {
    if (typeof value === 'number' && Number.isFinite(value)) return ok(value);
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        if (Number.isFinite(n)) return fixed(n);
    }
    if (typeof value === 'boolean') return fixed(value ? 1 : 0);
    return null;
}

function coerceYesNo(value: unknown): Coerced | null {
    if (typeof value === 'boolean') return ok(value);
    if (value === 'true' || value === 1) return fixed(true);
    if (value === 'false' || value === 0) return fixed(false);
    return null;
}

function coerceDate(value: unknown): Coerced | null {
    if (value === null) return ok(null);
    if (typeof value !== 'string') return null;
    if (ISO_DATE_ONLY_RE.test(value)) return ok(value);
    if (ISO_DATE_ONLY_RE.test(value.slice(0, 10))) return fixed(value.slice(0, 10));
    return null;
}

const withinBudget = (value: unknown): Coerced | null => (jsonBytes(value) > MAX_VARIABLE_DEFAULT_BYTES ? null : ok(value));

function coerceStructured(type: string, value: unknown): Coerced | null {
    if (type === 'record') return value && typeof value === 'object' && !Array.isArray(value) ? withinBudget(value) : null;
    if (type === 'list') return Array.isArray(value) ? withinBudget(value) : null;
    if (value === undefined) return fixed(null);
    return withinBudget(value);
}

/** Bring a declared default in line with its type. Mirrors the server's coerceVariableDefault. */
export function coerceVariableDefault(type: string, value: unknown): Coerced {
    const fallback = Object.prototype.hasOwnProperty.call(VARIABLE_TYPE_DEFAULTS, type)
        ? VARIABLE_TYPE_DEFAULTS[type as VariableType]
        : null;
    let res: Coerced | null;
    switch (type) {
        case 'text': res = coerceText(value); break;
        case 'number': res = coerceNumber(value); break;
        case 'yesno': res = coerceYesNo(value); break;
        case 'date': res = coerceDate(value); break;
        default: res = coerceStructured(type, value);
    }
    return res ?? fixed(fallback);
}

/** The `vars` a run starts from: { [name]: coerced default }. */
export function seedVariableDefaults(variables: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const v of Array.isArray(variables) ? (variables as Partial<AppVariable>[]) : []) {
        if (!v || typeof v !== 'object') continue;
        if (typeof v.name !== 'string' || !VARIABLE_NAME_RE.test(v.name)) continue;
        if (RESERVED_VARIABLE_NAMES.includes(v.name)) continue;
        const type = (VARIABLE_TYPES as readonly string[]).includes(v.type as string) ? (v.type as string) : 'any';
        out[v.name] = coerceVariableDefault(type, v.default).value;
    }
    return out;
}

/** Declared names, in declaration order. */
export function listVariableNames(variables: unknown): string[] {
    return (Array.isArray(variables) ? variables : [])
        .map((v) => (v && typeof v.name === 'string' ? (v.name as string) : null))
        .filter((n): n is string => !!n);
}

/**
 * Fold a change in the DECLARATIONS into the live `vars`, merging, never
 * resetting: an added name is seeded; a changed default is adopted only while
 * the live value still equals the old default; a removed name is dropped only
 * while it still holds its old default. Returns `prev` by reference when
 * nothing changed.
 */
export function reconcileVariableDefaults<P>(prev: P, prevDecls: unknown, nextDecls: unknown): P | Record<string, unknown> {
    const before = seedVariableDefaults(prevDecls);
    const after = seedVariableDefaults(nextDecls);
    const current = (prev && typeof prev === 'object' ? prev : {}) as Record<string, unknown>;
    let changed = false;
    const out: Record<string, unknown> = { ...current };
    for (const [name, value] of Object.entries(after)) {
        if (!(name in current)) {
            out[name] = value;
            changed = true;
            continue;
        }
        const wasUntouched = name in before && sameValue(current[name], before[name]);
        if (wasUntouched && !sameValue(current[name], value)) {
            out[name] = value;
            changed = true;
        }
    }
    for (const name of Object.keys(before)) {
        if (name in after || !(name in current) || !sameValue(current[name], before[name])) continue;
        delete out[name];
        changed = true;
    }
    return changed ? out : prev;
}
