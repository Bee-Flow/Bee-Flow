/**
 * Small readers for untrusted, parsed input (a Windmill export is uploaded
 * by a person and may be hand-edited). Every object walk goes through
 * `entries`, which leaves out the prototype-plumbing keys, so a crafted
 * `"__proto__"` key can never become a property write later on.
 */

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

export type Obj = Record<string, unknown>;

export function isObject(v: unknown): v is Obj {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function asObject(v: unknown): Obj {
    return isObject(v) ? v : {};
}

export function asArray(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string | undefined {
    return typeof v === 'string' && v !== '' ? v : undefined;
}

export function num(v: unknown): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function isReservedKey(k: string): boolean {
    return RESERVED.has(k);
}

/** Own entries of a plain object, without the reserved keys. */
export function entries(v: unknown): Array<[string, unknown]> {
    if (!isObject(v)) return [];
    return Object.entries(v).filter(([k]) => !RESERVED.has(k));
}

/** A deep copy of JSON-shaped data without the reserved keys anywhere. */
export function cleanJson(v: unknown, depth = 0): unknown {
    if (depth > 64) return null;
    if (Array.isArray(v)) return v.map((x) => cleanJson(x, depth + 1));
    if (isObject(v)) {
        const out: Obj = {};
        for (const [k, x] of entries(v)) out[k] = cleanJson(x, depth + 1);
        return out;
    }
    if (typeof v === 'number' && !Number.isFinite(v)) return null;
    if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return null;
    return v === undefined ? null : v;
}

/** A Bee Flow step id from a Windmill module id: an identifier, unique in `taken`. */
export function stepIdFor(wmId: string, taken: Set<string>): string {
    let base = '';
    for (const ch of wmId) base += isIdentChar(ch) ? ch : '_';
    if (!base || isDigit(base[0])) base = `s_${base}`;
    if (RESERVED.has(base)) base = `s_${base}`;
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}_${n}`;
    taken.add(id);
    return id;
}

function isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
}

function isIdentChar(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || isDigit(ch) || ch === '_' || ch === '$';
}

export interface IdentifierRule { dollar?: boolean; maxLength?: number; letterFirst?: boolean }

/** `[A-Za-z_$][A-Za-z0-9_$]*` (no `$` when `dollar` is false), checked with string operations. */
export function isIdentifier(s: string, rule: IdentifierRule = {}): boolean {
    if (!s || (rule.maxLength !== undefined && s.length > rule.maxLength)) return false;
    if (!firstCharOk(s[0], rule)) return false;
    const dollar = rule.dollar !== false;
    for (const ch of s) if (!isIdentChar(ch) || (!dollar && ch === '$')) return false;
    return true;
}

function firstCharOk(first: string, rule: IdentifierRule): boolean {
    const letter = (first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z');
    if (rule.letterFirst) return letter;
    return letter || first === '_' || (rule.dollar !== false && first === '$');
}

/** A lower-case snake slug (layer keys, switch case names). */
export function slug(text: string, fallback: string): string {
    let out = '';
    let gap = false;
    for (const ch of text.toLowerCase()) {
        const ok = (ch >= 'a' && ch <= 'z') || isDigit(ch);
        if (ok) {
            if (gap && out) out += '_';
            out += ch;
            gap = false;
        } else gap = true;
        if (out.length >= 40) break;
    }
    if (!out || isDigit(out[0])) return fallback;
    return out;
}
