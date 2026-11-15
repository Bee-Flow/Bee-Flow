/**
 * A Windmill / webhook_listeners event filter (Mongo-like JSON over the event
 * envelope, research 01 §3.3) to a Bee Flow trigger filter (PLAN B3 mapFilter.mts,
 * research 06 §C.4).
 *
 *   {"event.node.path": "/^\\/[^\\/]+\\/files\\/Uploads\\/.*$/"}  -> { inFolder: "/Uploads" }
 *   {"event.form.id": 7} / {"event.form.hash": "h"}            -> { formId: 7 } / { formHash: "h" }
 *   {"event.tableId": 3}                                       -> { tableId: 3 }
 *   {"event.tagId": 5}                                         -> { tagId: 5 }
 *   {"<key>": {"$in": [a, b]}}                                 -> { any: [{<k>: a}, {<k>: b}] }
 *   anything else that maps to a payload field                 -> the DSL `expr` (`trigger.<field> > 3`,
 *                                                                 `regexMatch(trigger.path, "…")`)
 *   userIdFilter "u"                                           -> expr `trigger.actor == "u"`
 *
 * A regular expression from the filter is TRANSLATED (its text is taken
 * apart with string operations), never run here. Windmill matches the
 * internal path `/<uid>/files/<path>`; Bee Flow's `path` starts at the user's
 * files, so the `/<uid>/files` prefix is taken off the pattern, and a pattern
 * that does not start with it cannot be translated. Look-around and
 * back-references are refused by the Bee Flow regex subset; such a filter,
 * and every operator without a counterpart ($not, $nor, $nin, $all, $mod), is
 * an AI item.
 */

import { nextcloudPayloadPath, relativeNcPath } from './payload.mts';
import type { Seg } from './mapExpr.mts';
import { segText } from './mapExpr.mts';
import { entries, isObject } from './util.mts';

import { parseExpr } from '../../../shared/expr/index.mjs';

export type FilterResult =
    | { kind: 'filter'; filter: Record<string, unknown>; notes: string[] }
    | { kind: 'ai'; reason: string; original: string };

class Untranslatable extends Error {}

/** Structured filter keys per payload field, for the events whose matcher reads them. */
const STRUCTURED: Record<string, string> = { formId: 'formId', formHash: 'formHash', tableId: 'tableId', tagId: 'tagId' };

export function mapEventFilter(event: string, filter: unknown, userIdFilter?: string): FilterResult {
    const original = JSON.stringify(filter ?? {});
    const out: Record<string, unknown> = {};
    const exprs: string[] = [];
    const notes: string[] = [];
    try {
        if (filter !== undefined && filter !== null && !isObject(filter)) throw new Untranslatable('The filter is not an object.');
        for (const [key, cond] of entries(filter)) applyCondition(event, key, cond, { out, exprs, notes });
        if (userIdFilter) exprs.push(`trigger.actor == ${JSON.stringify(userIdFilter)}`);
        if (exprs.length) {
            const expr = exprs.length === 1 ? exprs[0] : exprs.map((e) => `(${e})`).join(' && ');
            checkExpr(expr);
            out.expr = expr;
        }
        return { kind: 'filter', filter: out, notes };
    } catch (e) {
        return { kind: 'ai', reason: e instanceof Error ? e.message : String(e), original };
    }
}

interface Acc { out: Record<string, unknown>; exprs: string[]; notes: string[] }

function checkExpr(expr: string): void {
    try { parseExpr(expr); }
    catch (e) { throw new Untranslatable(`The filter does not translate into a valid rule (${e instanceof Error ? e.message : String(e)}).`); }
}

function applyCondition(event: string, key: string, cond: unknown, acc: Acc): void {
    if (key === '$and') {
        for (const part of Array.isArray(cond) ? cond : []) for (const [k, v] of entries(part)) applyCondition(event, k, v, acc);
        return;
    }
    if (key === '$or') { acc.exprs.push(orExpr(event, cond)); return; }
    if (key.startsWith('$')) throw new Untranslatable(`The filter operator ${key} has no counterpart.`);
    const field = fieldOf(event, key);
    if (isObject(cond)) { applyOperators(key, field, cond, acc); return; }
    applyEquals(key, field, cond, acc);
}

function fieldOf(event: string, key: string): string {
    const segs: Seg[] = key.split('.').map((v) => ({ kind: 'name', v }));
    const hit = nextcloudPayloadPath(event, segs);
    if (!hit || !('field' in hit)) throw new Untranslatable(`The filter key "${key}" has no Bee Flow field.`);
    return `${hit.field}${segText(hit.rest)}`;
}

function applyEquals(key: string, field: string, value: unknown, acc: Acc): void {
    if (typeof value === 'string' && isRegexText(value)) { applyRegex(field, value, acc); return; }
    if (field === 'path' && typeof value === 'string') {
        const rel = relativeNcPath(value);
        if (rel === null) throw new Untranslatable(`The path "${value}" is not a Nextcloud user path.`);
        acc.exprs.push(`trigger.path == ${JSON.stringify(rel)}`);
        return;
    }
    if (STRUCTURED[field] && (typeof value === 'string' || typeof value === 'number')) {
        acc.out[STRUCTURED[field]] = value;
        return;
    }
    acc.exprs.push(`trigger.${field} == ${literal(value, key)}`);
}

const COMPARE: Record<string, string> = { $eq: '==', $ne: '!=', $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' };

function applyOperators(key: string, field: string, cond: Record<string, unknown>, acc: Acc): void {
    for (const [op, v] of entries(cond)) {
        if (op === '$in') { acc.exprs.push(inExpr(field, v, key)); continue; }
        if (op === '$exists') { acc.exprs.push(v === false ? `isEmpty(trigger.${field})` : `!isEmpty(trigger.${field})`); continue; }
        if (op === '$eq') { applyEquals(key, field, v, acc); continue; }
        const cmp = COMPARE[op];
        if (!cmp) throw new Untranslatable(`The filter operator ${op} on "${key}" has no counterpart.`);
        acc.exprs.push(`trigger.${field} ${cmp} ${literal(v, key)}`);
    }
}

function inExpr(field: string, values: unknown, key: string): string {
    if (!Array.isArray(values) || values.length === 0) throw new Untranslatable(`$in on "${key}" needs a list.`);
    return values.map((v) => `trigger.${field} == ${literal(v, key)}`).join(' || ');
}

function orExpr(event: string, cond: unknown): string {
    if (!Array.isArray(cond) || cond.length === 0) throw new Untranslatable('$or needs a list of conditions.');
    const parts = cond.map((part) => {
        const acc: Acc = { out: {}, exprs: [], notes: [] };
        for (const [k, v] of entries(part)) applyCondition(event, k, v, acc);
        for (const [k, v] of Object.entries(acc.out)) acc.exprs.push(`trigger.${k} == ${literal(v, k)}`);
        if (acc.exprs.length === 0) throw new Untranslatable('An empty $or branch matches everything.');
        return acc.exprs.map((e) => `(${e})`).join(' && ');
    });
    return parts.map((p) => `(${p})`).join(' || ');
}

function literal(value: unknown, key: string): string {
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean' || value === null) return String(value);
    throw new Untranslatable(`The value of "${key}" is not a plain value.`);
}

// ── Regular expressions as text ─────────────────────────────────────────

/** `/…/flags` as webhook_listeners writes a regex. */
function isRegexText(value: string): boolean {
    if (value.length < 2 || value[0] !== '/') return false;
    const close = value.lastIndexOf('/');
    if (close <= 0) return false;
    for (const ch of value.slice(close + 1)) if (!'imsxu'.includes(ch)) return false;
    return true;
}

function splitRegex(value: string): { pattern: string; flags: string } {
    const close = value.lastIndexOf('/');
    return { pattern: value.slice(1, close), flags: value.slice(close + 1).split('').filter((f) => 'ims'.includes(f)).join('') };
}

function applyRegex(field: string, value: string, acc: Acc): void {
    const { pattern, flags } = splitRegex(value);
    if (field !== 'path') {
        acc.exprs.push(regexCall(`trigger.${field}`, pattern, flags));
        return;
    }
    const rest = stripUserFilesPrefix(pattern);
    if (rest === null) throw new Untranslatable('The path pattern does not start with the user\'s files folder, so it cannot be read against a Bee Flow path.');
    const folder = folderOf(rest);
    if (folder !== null && flags === '') {
        acc.out.inFolder = folder;
        return;
    }
    acc.exprs.push(regexCall('trigger.path', `^${rest}`, flags));
    acc.notes.push('The path pattern now reads the path inside the user\'s files (without "/<user>/files").');
}

function regexCall(target: string, pattern: string, flags: string): string {
    return flags ? `regexMatch(${target}, ${JSON.stringify(pattern)}, ${JSON.stringify(flags)})` : `regexMatch(${target}, ${JSON.stringify(pattern)})`;
}

const SLASH = ['\\/', '/'];
const ANY_USER = ['[^\\/]+', '[^/]+', '.*', '.+', '[^\\/]*', '[^/]*'];

function eat(s: string, at: number, options: string[]): number {
    for (const o of options) if (s.startsWith(o, at)) return at + o.length;
    return -1;
}

/** `^/<user>/files` taken off a pattern: the rest (starting with `/` or `\/`, or ''), or null. */
export function stripUserFilesPrefix(pattern: string): string | null {
    if (!pattern.startsWith('^')) return null;
    let at = eat(pattern, 1, SLASH);
    if (at === -1) return null;
    const anyUser = eat(pattern, at, ANY_USER);
    if (anyUser !== -1) at = anyUser;
    else {
        let end = at;
        while (end < pattern.length && isUidChar(pattern[end])) end += 1;
        if (end === at) return null;
        at = end;
    }
    at = eat(pattern, at, SLASH);
    if (at === -1 || !pattern.startsWith('files', at)) return null;
    const rest = pattern.slice(at + 'files'.length);
    if (rest === '' || rest === '$' || rest.startsWith('/') || rest.startsWith('\\/')) return rest;
    return null;
}

function isUidChar(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '-' || ch === '@';
}

/** `\/Uploads\/.*$`, `/Uploads/`, `\/A\/B\/.*` (literal folder names only) as "/Uploads", "/A/B". */
export function folderOf(rest: string): string | null {
    let body = rest;
    for (const tail of ['.*$', '.*', '.+$', '.+', '']) {
        if (tail === '' || body.endsWith(tail)) { body = tail ? body.slice(0, -tail.length) : body; break; }
    }
    // A bare `.` is "any character" in the pattern; only an escaped `\.` is a dot in a name.
    const marked = body.split('\\.').join('\u0000');
    if (marked.includes('.')) return null;
    const unescaped = marked.split('\\/').join('/');
    if (!unescaped.startsWith('/') || !unescaped.endsWith('/') || unescaped.length < 3) return null;
    const folder = unescaped.slice(0, -1);
    for (const ch of folder) {
        const ok = isUidChar(ch) || ch === '/' || ch === ' ' || ch === '\u0000';
        if (!ok) return null;
    }
    return folder.includes('//') ? null : folder.split('\u0000').join('.');
}
