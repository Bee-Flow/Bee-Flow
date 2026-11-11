import type { TableColumn } from '../inspector/aiFieldMatching';
import { EXPAND_DEFAULT_SUFFIX } from '../runtime/components/relationLabel';
import type { AppTable } from './useAppTables';

/**
 * Reading through a relation, as the editors write it on a record / records
 * binding (server: core/dataEngine/queryCompilerRelation.mts):
 *   expand   [{ field: <relation field>, pick?: [<field of the linked table>], as? }]
 *            the linked record of each row, under `as` or `<field>_record`
 *   fields   [<field>]: only these columns are loaded
 *   filter   { field: '<relation field>.<field of the linked table>', op, value }
 * Nothing here adds a key to a binding that does not use it.
 */

/** The limits the server sets (core vocabulary RELATION_READ_LIMITS; relationRead.test.ts holds them together). */
export const MAX_EXPAND = 5;
export const MAX_EXPAND_PICK = 20;

export interface ExpandEntry {
    field: string;
    pick?: string[];
    as?: string;
}

type RelationColumn = TableColumn & { relation?: { table?: string; displayField?: string } | null };

/** A relation field of a table, with the table it points at. */
export interface RelationLink {
    field: RelationColumn;
    target: AppTable;
}

const isEntry = (e: unknown): e is ExpandEntry => !!e && typeof e === 'object' && !Array.isArray(e) && typeof (e as ExpandEntry).field === 'string' && !!(e as ExpandEntry).field;

/** The well-formed entries of a binding's `expand`. */
export function expandEntries(expand: unknown): ExpandEntry[] {
    return Array.isArray(expand) ? expand.filter(isEntry) : [];
}

/** The key of a row an expansion lands in. */
export function expandAlias(entry: ExpandEntry): string {
    return typeof entry.as === 'string' && entry.as ? entry.as : `${entry.field}${EXPAND_DEFAULT_SUFFIX}`;
}

/**
 * The relation fields of a table that a read can go through: those that point
 * at another table of the app with its own rows (a linked Studio table keeps
 * its rows outside the app, and the table itself must not be one either).
 */
export function relationLinks(tables: AppTable[], tableRef: string | null | undefined): RelationLink[] {
    const table = tables.find((tb) => tb.id === tableRef || tb.key === tableRef);
    if (!table || table.linked === true) return [];
    const out: RelationLink[] = [];
    for (const field of (Array.isArray(table.fields) ? table.fields : []) as RelationColumn[]) {
        if (field.type !== 'relation') continue;
        const ref = field.relation?.table;
        const target = tables.find((tb) => tb.id === ref || tb.key === ref);
        if (target && target.linked !== true) out.push({ field, target });
    }
    return out;
}

/** The fields of a linked table a read may pick or filter on (a read-time computed field has no column). */
export function pickableFields(target: AppTable): TableColumn[] {
    return (Array.isArray(target.fields) ? target.fields : []).filter((f) => f.type !== 'computed');
}

/** The picked fields of one relation in a binding's `expand`. */
export function pickedOf(expand: unknown, fieldKey: string): string[] {
    const entry = expandEntries(expand).find((e) => e.field === fieldKey);
    return entry && Array.isArray(entry.pick) ? entry.pick.filter((k): k is string => typeof k === 'string') : [];
}

/**
 * `expand` after ticking or unticking one field of one relation. An entry
 * without a picked field left is dropped; undefined when no entry is left, so
 * the binding loses the key. Entries the editor does not manage (their `as`)
 * are kept as they are.
 */
export function togglePick(expand: unknown, fieldKey: string, column: string): ExpandEntry[] | undefined {
    const entries = expandEntries(expand);
    const at = entries.findIndex((e) => e.field === fieldKey);
    const current = at >= 0 ? pickedOf(entries, fieldKey) : [];
    const next = current.includes(column) ? current.filter((k) => k !== column) : [...current, column].slice(0, MAX_EXPAND_PICK);
    let out: ExpandEntry[];
    if (at < 0) out = next.length && entries.length < MAX_EXPAND ? [...entries, { field: fieldKey, pick: next }] : entries;
    else if (next.length === 0) out = entries.filter((_, i) => i !== at);
    else out = entries.map((e, i) => (i === at ? { ...e, pick: next } : e));
    return out.length ? out : undefined;
}

/** `fields` after ticking or unticking one column; undefined when none is left (every column is loaded). */
export function toggleField(fields: unknown, column: string): string[] | undefined {
    const current = Array.isArray(fields) ? fields.filter((k): k is string => typeof k === 'string') : [];
    const next = current.includes(column) ? current.filter((k) => k !== column) : [...current, column];
    return next.length ? next : undefined;
}

/**
 * The column keys a component can show from the expansions of its binding:
 * `<expansion>.<picked field>` per picked field, and the expansion itself
 * (shown by its display field) when the relation has one.
 */
export function expandedColumnKeys(tables: AppTable[], tableRef: string | null | undefined, expand: unknown): string[] {
    const links = relationLinks(tables, tableRef);
    const out: string[] = [];
    for (const entry of expandEntries(expand)) {
        const link = links.find((l) => l.field.key === entry.field);
        if (!link) continue;
        const alias = expandAlias(entry);
        const display = link.field.relation?.displayField;
        const picked = Array.isArray(entry.pick) ? entry.pick.filter((k): k is string => typeof k === 'string') : (display ? [display] : []);
        for (const key of picked) out.push(`${alias}.${key}`);
    }
    return out;
}

/** The fields of the linked tables as filter fields: key `<relation>.<field>`, named "Customer › City". */
export function relationFilterFields(tables: AppTable[], tableRef: string | null | undefined): TableColumn[] {
    return relationLinks(tables, tableRef).flatMap(({ field, target }) => pickableFields(target)
        .filter((f) => f.type !== 'multiselect' && f.type !== 'file')
        .map((f) => ({ ...f, key: `${field.key}.${f.key}`, name: `${field.name || field.key} › ${f.name || f.key}` })));
}
