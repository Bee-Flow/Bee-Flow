/**
 * The user's OWN rows on two data steps — Edit data's operations and Parse
 * JSON's fields. A typed-but-incomplete row MUST survive the autosave (the
 * validator flags it; it must not vanish mid-edit); only non-objects and
 * unknown ops drop. From agent-hub `Builder/flow/settings/formState.js`;
 * pinned by formState.lockstep.test.ts.
 */

type Row = Record<string, unknown>;

const t = (s: unknown): string => (typeof s === 'string' ? s.trim() : '');
const keysOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(t).filter(Boolean) : []);

/** '' / null = "not set" — Number('') is 0, which would persist a start nobody typed. */
function rowIdOp(o: Row): Row {
    const start = o.start === '' || o.start == null ? null : Number(o.start);
    return { op: 'rowId', target: t(o.target), ...(Number.isInteger(start) && start !== 1 ? { start } : {}) };
}

const OPS: Record<string, (o: Row) => Row> = {
    rowId: rowIdOp,
    groupId: (o) => ({ op: 'groupId', target: t(o.target), keys: keysOf(o.keys) }),
    rename: (o) => ({ op: 'rename', from: t(o.from), to: t(o.to) }),
    keep: (o) => ({ op: 'keep', keys: keysOf(o.keys) }),
    remove: (o) => ({ op: 'remove', keys: keysOf(o.keys) }),
    sort: (o) => ({ op: 'sort', key: t(o.key), ...(o.direction === 'desc' ? { direction: 'desc' } : {}) }),
};

/** Each op normalised to the exact key set the runtime reads. */
export function sanitizeOperations(raw: unknown): Row[] {
    const out: Row[] = [];
    for (const o of Array.isArray(raw) ? raw : []) {
        if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
        const op = String((o as Row).op);
        if (Object.hasOwn(OPS, op)) out.push((OPS[op] as (o: Row) => Row)(o as Row));
    }
    return out;
}

/** Parse JSON's named rows: blank names drop, an empty path survives, `undefined` members don't. */
export function sanitizeParseJsonFields(fields: unknown): Row[] {
    const out: Row[] = [];
    for (const f of Array.isArray(fields) ? fields : []) {
        if (!f || typeof f !== 'object') continue;
        const name = typeof f.name === 'string' ? f.name.trim() : '';
        if (!name) continue;
        const row: Row = { name, path: typeof f.path === 'string' ? f.path : '' };
        if (typeof f.description === 'string' && f.description.trim()) row.description = f.description;
        if (f.fallback !== undefined) row.fallback = f.fallback;
        out.push(row);
    }
    return out;
}
