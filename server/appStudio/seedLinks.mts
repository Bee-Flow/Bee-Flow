/**
 * The links of a many relation (`relation.many: true`, since 3) in a written-down row: a seed of
 * a template, the rows of an app archive.
 *
 * A many relation has no column: its links are rows of a junction (actionExecutor/linkWrites.mts).
 * In a seed they are written as the list of the linked rows' aliases, `[{ $ref }, ...]`, the
 * same alias a single relation uses, so a copy never carries a record id of the database it came
 * from. A link to a row the copy does not carry is left out (and counted), never kept as an id.
 *
 * On install the links go in a pass of their own, AFTER every row exists: a link may point at a
 * row of a table seeded later, or at a later row of the same table, which a single relation in
 * the row itself could never reach.
 *
 * Lookup and rollup fields are read through other rows and never written, so a seed never holds
 * them (seedNeverHolds).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { isManyRelation, isDerivedLinkField } = nodeRequire('../core/dataEngine/dataModel/linkedFields') as {
    isManyRelation: (f: unknown) => boolean; isDerivedLinkField: (f: unknown) => boolean;
};

type Obj = Record<string, unknown>;
type Field = { key?: unknown; type?: unknown; relation?: unknown };
type Table = { fields?: unknown };
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export { isManyRelation };

/** A field type no seed holds besides file and computed: lookup and rollup are derived. */
export function seedNeverHolds(field: unknown): boolean {
    return isDerivedLinkField(field);
}

function refOf(item: unknown): string | null {
    return isObject(item) && typeof item.$ref === 'string' && item.$ref ? item.$ref : null;
}

/** A live many-relation value (a list of record ids) as aliases of rows the capture carries. */
export function capturedLinks(value: unknown, capturedIds: ReadonlyMap<string, string>): Array<{ $ref: string }> {
    const out: Array<{ $ref: string }> = [];
    for (const id of Array.isArray(value) ? value : []) {
        const alias = typeof id === 'string' ? capturedIds.get(id) : undefined;
        if (alias && !out.some((l) => l.$ref === alias)) out.push({ $ref: alias });
    }
    return out;
}

/** A many-relation value out of a file: only `{ $ref }` at an alias the file declares. */
export function fileLinks(value: unknown, aliases: ReadonlySet<string>): { links: Array<{ $ref: string }>; dropped: number } {
    const links: Array<{ $ref: string }> = [];
    let dropped = 0;
    if (value === null || value === undefined) return { links, dropped };
    for (const item of Array.isArray(value) ? value : [value]) {
        const ref = refOf(item);
        if (ref && aliases.has(ref)) { if (!links.some((l) => l.$ref === ref)) links.push({ $ref: ref }); } else dropped += 1;
    }
    return { links, dropped };
}

/**
 * A seed row's many-relation values taken out, for the pass after every row exists:
 * `values` without them, `links` the aliases per field key.
 */
export function splitSeedLinks(table: Table | null | undefined, values: Obj): { values: Obj; links: Record<string, string[]> } {
    const fields = (table && Array.isArray(table.fields) ? table.fields : []) as Field[];
    const manyKeys = new Set(fields.filter((f) => isManyRelation(f)).map((f) => f.key));
    if (!manyKeys.size) return { values, links: {} };
    const rest: Obj = {};
    const links: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(values)) {
        if (!manyKeys.has(key)) { rest[key] = value; continue; }
        const refs = (Array.isArray(value) ? value : []).map(refOf).filter((r): r is string => !!r);
        if (refs.length) links[key] = refs;
    }
    return { values: rest, links };
}

/** The links of one row with every alias resolved to the id it got; an alias that got none is left out. */
export function resolveLinks(links: Record<string, string[]>, refMap: ReadonlyMap<string, string>): Obj | null {
    const out: Obj = {};
    for (const [key, refs] of Object.entries(links)) {
        const ids = refs.map((r) => refMap.get(r)).filter((id): id is string => typeof id === 'string');
        if (ids.length) out[key] = ids;
    }
    return Object.keys(out).length ? out : null;
}
