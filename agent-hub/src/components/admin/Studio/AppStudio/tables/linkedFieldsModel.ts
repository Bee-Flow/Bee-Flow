import type { ModelField, ModelTable } from './tablesManagerModel';

/**
 * App Studio table editor — the pure half of lookup and rollup fields, the many relation, a
 * relation's onDelete rule and a table's indexes (server: core/dataEngine/dataModel/linkedFields.js;
 * the server's validator has the last word on every one of them).
 */

export const ROLLUP_FNS = ['count', 'sum', 'min', 'max', 'avg'] as const;
export const ON_DELETE_RULES = ['restrict', 'setNull', 'cascade'] as const;
export const MAX_INDEXES = 10;
export const MAX_INDEX_FIELDS = 4;

const SYSTEM_INDEX_COLUMNS = ['created_at', 'updated_at', 'created_by'];

export interface LookupSpec { relation?: string; field?: string }
export interface RollupSpec { table?: string; relation?: string; fn?: string; field?: string; filter?: unknown[] }
export interface IndexSpec { fields: string[] }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function isLinkType(type: unknown): boolean {
    return type === 'lookup' || type === 'rollup';
}

export function isManyRelation(field: ModelField | undefined): boolean {
    return !!field && field.type === 'relation' && isRecord(field.relation) && (field.relation as Record<string, unknown>).many === true;
}

/** A field with a column of its own: what a lookup shows, a rollup sums and an index names. */
function hasColumn(field: ModelField | undefined): boolean {
    if (!field || isLinkType(field.type) || isManyRelation(field)) return false;
    return field.type !== 'computed' || field.computed?.stored === true;
}

export function lookupOf(field: ModelField): LookupSpec {
    return isRecord(field.lookup) ? field.lookup as LookupSpec : {};
}

export function rollupOf(field: ModelField): RollupSpec {
    return isRecord(field.rollup) ? field.rollup as RollupSpec : {};
}

/** The single relation fields of a table: what a lookup can read through. */
export function lookupRelations(table: ModelTable | null | undefined): ModelField[] {
    return (table?.fields || []).filter((f) => f.type === 'relation' && !isManyRelation(f) && !!f.key);
}

/** The fields of the table a relation points at that a lookup may show. */
export function lookupTargetFields(tables: ModelTable[] | null | undefined, table: ModelTable | null | undefined, relationKey: string | undefined): ModelField[] {
    const rel = lookupRelations(table).find((f) => f.key === relationKey);
    const target = (tables || []).find((t) => t.id === rel?.relation?.table || t.key === rel?.relation?.table);
    return (target?.fields || []).filter((f) => hasColumn(f) && !!f.key);
}

/** Every (child table, relation field) that points at `tableId` through a single relation: a rollup's source. */
export function rollupSources(tables: ModelTable[] | null | undefined, tableId: string | undefined): Array<{ table: ModelTable; relation: ModelField }> {
    const out: Array<{ table: ModelTable; relation: ModelField }> = [];
    for (const table of tables || []) {
        for (const relation of lookupRelations(table)) {
            if (relation.relation?.table === tableId) out.push({ table, relation });
        }
    }
    return out;
}

/** The number fields of a rollup's child table. */
export function rollupNumberFields(tables: ModelTable[] | null | undefined, childTableId: string | undefined): ModelField[] {
    const child = (tables || []).find((t) => t.id === childTableId || t.key === childTableId);
    return (child?.fields || []).filter((f) => hasColumn(f) && (f.type === 'number' || (f.type === 'computed' && (f.computed?.type === 'number' || f.computed?.type === 'integer'))));
}

/** The field after its type became a lookup or rollup: an empty spec, no default, never required or unique. */
export function withLinkType(field: ModelField, type: string): ModelField {
    if (!isLinkType(type) && field.lookup === undefined && field.rollup === undefined) return field;
    const { lookup: _l, rollup: _r, ...kept } = field;
    if (!isLinkType(type)) return kept;
    const { default: _d, ...rest } = kept;
    if (type === 'lookup') return { ...rest, type, required: false, unique: false, lookup: lookupOf(field) };
    return { ...rest, type, required: false, unique: false, rollup: { fn: 'count', ...rollupOf(field) } };
}

/** A relation with `many` switched: a many relation takes no unique, required or onDelete. */
export function withMany(field: ModelField, many: boolean): ModelField {
    const relation = { ...(field.relation || {}) } as Record<string, unknown>;
    delete relation.onDelete;
    if (many) relation.many = true;
    else delete relation.many;
    return many ? { ...field, required: false, unique: false, relation } : { ...field, relation };
}

/** A relation with its onDelete rule set ('' removes it: today's behaviour). */
export function withOnDelete(field: ModelField, rule: string): ModelField {
    const relation = { ...(field.relation || {}) } as Record<string, unknown>;
    if (rule) relation.onDelete = rule;
    else delete relation.onDelete;
    return { ...field, relation };
}

export function indexesOf(table: ModelTable): IndexSpec[] {
    const list = Array.isArray(table.indexes) ? table.indexes : [];
    return list.filter(isRecord).map((e) => ({ fields: Array.isArray(e.fields) ? (e.fields as unknown[]).filter((k): k is string => typeof k === 'string') : [] }));
}

/** The columns an index may name, in the table's order: stored fields, then the system timestamps and creator. */
export function indexableColumns(table: ModelTable): Array<{ key: string; label: string }> {
    const fields = (table.fields || []).filter((f) => hasColumn(f) && !!f.key).map((f) => ({ key: f.key as string, label: f.name || (f.key as string) }));
    return [...fields, ...SYSTEM_INDEX_COLUMNS.map((key) => ({ key, label: key }))];
}

/** The table with its index list replaced; an empty list removes the key, so the table stays as it was stored. */
export function withIndexes(table: ModelTable, indexes: IndexSpec[]): ModelTable {
    const { indexes: _drop, ...rest } = table;
    return indexes.length ? { ...rest, indexes } : rest;
}
