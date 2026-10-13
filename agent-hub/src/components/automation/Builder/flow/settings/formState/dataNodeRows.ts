/**
 * The user's own rows on two data nodes: parse_json's named fields and the
 * "Edit data" operations of a `set` step in list mode. Both survive a save
 * half-filled; only rows nothing in the editor can produce are dropped.
 */
import type { FormRecord } from './types';

/**
 * Sanitize the parse_json fields ARRAY. Same philosophy as sanitizeFieldMap:
 * these are the user's OWN named rows, so a named-but-incomplete row (path
 * still empty) MUST survive the 600ms autosave round-trip — dropping it would
 * make the row vanish mid-edit. Only blank-name / non-object rows are
 * dropped. `undefined` members are stripped so the persisted step never
 * carries them (JSON round-trips would drop them asymmetrically anyway).
 */
export function sanitizeParseJsonFields(fields: unknown): FormRecord[] {
    const out: FormRecord[] = [];
    for (const f of (Array.isArray(fields) ? fields : [])) {
        if (!f || typeof f !== 'object') continue;
        const name = typeof f.name === 'string' ? f.name.trim() : '';
        if (!name) continue;
        const row: FormRecord = { name, path: typeof f.path === 'string' ? f.path : '' };
        if (typeof f.description === 'string' && f.description.trim()) row.description = f.description;
        if (f.fallback !== undefined) row.fallback = f.fallback;
        out.push(row);
    }
    return out;
}

/**
 * Sanitize the "Edit data" operations ARRAY. Same survival philosophy as
 * sanitizeParseJsonFields: these are the user's OWN rows, so a typed-but-
 * incomplete operation (target still empty, keys not picked yet) MUST survive
 * the autosave round-trip — the validator marks it as a completeness problem,
 * it must not vanish mid-edit. Only non-objects and unknown `op` values are
 * dropped (nothing in the editor can create those), and each op is normalised
 * to the exact key set the runtime reads.
 */
export function sanitizeOperations(raw: unknown): FormRecord[] {
    const out: FormRecord[] = [];
    const t = (s: unknown): string => (typeof s === 'string' ? s.trim() : '');
    const keysOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(t).filter(Boolean) : []);
    for (const o of (Array.isArray(raw) ? raw : [])) {
        if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
        if (o.op === 'rowId') {
            // '' / null = "not set" — Number('') is 0, which would silently
            // persist a start of 0 the user never typed.
            const start = (o.start === '' || o.start == null) ? null : Number(o.start);
            out.push({ op: 'rowId', target: t(o.target), ...(Number.isInteger(start) && start !== 1 ? { start } : {}) });
        } else if (o.op === 'groupId') {
            out.push({ op: 'groupId', target: t(o.target), keys: keysOf(o.keys) });
        } else if (o.op === 'rename') {
            out.push({ op: 'rename', from: t(o.from), to: t(o.to) });
        } else if (o.op === 'keep' || o.op === 'remove') {
            out.push({ op: o.op, keys: keysOf(o.keys) });
        } else if (o.op === 'sort') {
            out.push({ op: 'sort', key: t(o.key), ...(o.direction === 'desc' ? { direction: 'desc' } : {}) });
        }
    }
    return out;
}
