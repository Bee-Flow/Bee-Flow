/**
 * The `{{ … }}` placeholders of an http_request step: in `path`, and in the text leaves of a
 * static `body`. A placeholder is a PATH READ from one of four roots (form, vars, item, params),
 * never a formula: what it yields is data, and data is never read as a template again.
 *
 * Pure: no I/O. The validator uses `placeholderProblems`, the executor the two fill functions.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Token = { type: string; key?: string | number };
type Part = { type: 'text'; value: string } | { type: 'ref'; raw: string; inner: string };

const expr = nodeRequire('../../../shared/expr/index.mjs') as {
    scanTemplate: (text: string) => Part[];
    parsePath: (path: string) => Token[] | null;
    walkTokens: (tokens: Token[], root: unknown) => unknown;
};

export type Obj = Record<string, unknown>;
export type TemplateRoots = { form: unknown; vars: unknown; item: unknown; params: unknown };

export const TEMPLATE_ROOTS: readonly string[] = Object.freeze(['form', 'vars', 'item', 'params']);
/** How deep a static body is walked for placeholders. */
export const MAX_BODY_DEPTH = 8;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The roots a placeholder reads, from the step context. */
export function templateRoots(ctx: Obj): TemplateRoots {
    return {
        form: isObject(ctx.formValues) ? ctx.formValues : {},
        vars: isObject(ctx.vars) ? ctx.vars : {},
        item: ctx.item,
        params: isObject(ctx.params) ? ctx.params : {},
    };
}

/** The tokens of a placeholder that reads one of the four roots, or null. */
function rootedTokens(inner: string): Token[] | null {
    const tokens = expr.parsePath(inner);
    if (!tokens || !tokens.length) return null;
    const head = tokens[0];
    if (head.type !== 'prop' || typeof head.key !== 'string' || !TEMPLATE_ROOTS.includes(head.key)) return null;
    return tokens;
}

/** What a placeholder reads; undefined when it is not a path from a root or nothing is there. */
function readPlaceholder(inner: string, roots: TemplateRoots): unknown {
    const tokens = rootedTokens(inner);
    if (!tokens) return undefined;
    const value = expr.walkTokens(tokens.slice(1), (roots as Obj)[String(tokens[0].key)]);
    return value === null ? undefined : value;
}

const isScalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

/** The placeholders of `text` that are not a path read from form, vars, item or params. */
export function placeholderProblems(text: string): string[] {
    const out: string[] = [];
    for (const part of expr.scanTemplate(text)) {
        if (part.type === 'ref' && !rootedTokens(part.inner)) out.push(part.raw);
    }
    return out;
}

/** `template` with every placeholder replaced by `filler`: what the author typed literally, in place. */
export function literalText(template: string, filler = 'x'): string {
    return expr.scanTemplate(template).map((p) => (p.type === 'text' ? p.value : filler)).join('');
}

export type FilledPath = { ok: true; path: string } | { ok: false; error: string };

/**
 * `template` with every placeholder replaced by its URL-encoded value. A placeholder that reads
 * nothing, or something that is not a text, number or true/false, fails: a path with a hole in it
 * would address another resource than the author meant.
 */
export function fillPath(template: string, roots: TemplateRoots): FilledPath {
    let out = '';
    for (const part of expr.scanTemplate(template)) {
        if (part.type === 'text') { out += part.value; continue; }
        const value = readPlaceholder(part.inner, roots);
        if (!isScalar(value) || value === '') return { ok: false, error: `The path placeholder ${part.raw.slice(0, 80)} has no value.` };
        out += encodeURIComponent(String(value));
    }
    return { ok: true, path: out };
}

/** One text leaf: a leaf that is exactly one placeholder takes the value itself, otherwise text. */
function fillText(text: string, roots: TemplateRoots): unknown {
    const parts = expr.scanTemplate(text);
    if (parts.length === 1 && parts[0].type === 'ref') {
        const value = readPlaceholder(parts[0].inner, roots);
        return value === undefined ? null : value;
    }
    return parts.map((p) => {
        if (p.type === 'text') return p.value;
        const value = readPlaceholder(p.inner, roots);
        if (value === undefined) return '';
        return isScalar(value) ? String(value) : JSON.stringify(value);
    }).join('');
}

/**
 * A static body with the placeholders of its text leaves filled in. Keys are never templated,
 * and below MAX_BODY_DEPTH a value is kept as written.
 */
export function fillStatic(value: unknown, roots: TemplateRoots, depth = 0): unknown {
    if (typeof value === 'string') return fillText(value, roots);
    if (depth >= MAX_BODY_DEPTH) return value;
    if (Array.isArray(value)) return value.map((item) => fillStatic(item, roots, depth + 1));
    if (isObject(value)) {
        const out: Obj = {};
        for (const [key, child] of Object.entries(value)) {
            if (key === '__proto__') continue;
            out[key] = fillStatic(child, roots, depth + 1);
        }
        return out;
    }
    return value;
}
