/**
 * The JSON body template of a POST rest connector.
 *
 * A body is an owner-authored JSON value whose string leaves may hold
 * {placeholder}s for declared connector params. A leaf that is exactly one
 * placeholder takes the param's own type (number stays number); a placeholder
 * inside longer text is interpolated as text. Keys are never templated and a
 * missing param reads null (exact) or empty (embedded). Pure: no network.
 */

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;
const EXACT_RE = /^\{([a-zA-Z0-9_]+)\}$/;
const SKIPPED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const MAX_REST_BODY_BYTES = 16 * 1024;
export const MAX_REST_BODY_DEPTH = 6;

type Json = unknown;

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function placeholdersIn(text: string): string[] {
    return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

function walkErrors(value: Json, depth: number, where: string, declared: Set<string>, errors: string[]): void {
    if (depth > MAX_REST_BODY_DEPTH) { errors.push(`${where}.body is nested deeper than ${MAX_REST_BODY_DEPTH} levels`); return; }
    if (typeof value === 'string') {
        for (const p of placeholdersIn(value)) {
            if (!declared.has(p)) errors.push(`${where}.body references undeclared param {${p}} - add it to params[]`);
        }
    } else if (Array.isArray(value)) {
        for (const item of value) walkErrors(item, depth + 1, where, declared, errors);
    } else if (isObject(value)) {
        for (const [k, v] of Object.entries(value)) {
            if (SKIPPED_KEYS.has(k)) errors.push(`${where}.body may not use the key "${k}"`);
            else walkErrors(v, depth + 1, where, declared, errors);
        }
    } else if (value !== null && typeof value !== 'number' && typeof value !== 'boolean') {
        errors.push(`${where}.body must be plain JSON`);
    }
}

/** Definition-time check of a connector's `body`; pushes messages onto `errors`. */
export function validateRestBody(body: unknown, declaredKeys: Set<string>, where: string, errors: string[]): void {
    if (!isObject(body) && !Array.isArray(body)) { errors.push(`${where}.body must be a JSON object or array`); return; }
    let size = 0;
    try { size = Buffer.byteLength(JSON.stringify(body), 'utf8'); } catch { errors.push(`${where}.body must be plain JSON`); return; }
    if (size > MAX_REST_BODY_BYTES) { errors.push(`${where}.body is larger than ${MAX_REST_BODY_BYTES} bytes`); return; }
    walkErrors(body, 1, where, declaredKeys, errors);
}

function renderString(text: string, params: Record<string, unknown>): unknown {
    const exact = EXACT_RE.exec(text);
    if (exact) return params[exact[1]] ?? null;
    return text.replace(PLACEHOLDER_RE, (_m, key: string) => {
        const v = params[key];
        return v === undefined || v === null ? '' : String(v);
    });
}

/** Run-time fill of the template with already sanitised viewer params. */
export function renderRestBody(template: Json, params: Record<string, unknown>): Json {
    if (typeof template === 'string') return renderString(template, params);
    if (Array.isArray(template)) return template.map((item) => renderRestBody(item, params));
    if (isObject(template)) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(template)) {
            if (!SKIPPED_KEYS.has(k)) out[k] = renderRestBody(v, params);
        }
        return out;
    }
    return template;
}

/** Placeholder keys used anywhere in a body template (for the param allow-list). */
export function bodyPlaceholders(template: Json): string[] {
    if (typeof template === 'string') return placeholdersIn(template);
    if (Array.isArray(template)) return template.flatMap(bodyPlaceholders);
    if (isObject(template)) return Object.values(template).flatMap(bodyPlaceholders);
    return [];
}
