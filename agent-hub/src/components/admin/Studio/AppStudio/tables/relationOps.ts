import { newFieldId, slugifyKey } from './TableDesigner';
import type { ModelTable } from './tablesManagerModel';
import type { Connector } from '../bi/connectors/connectorModel';
import type { TranslateFn, TranslateParams } from '@/hooks/useTranslation';

/** t() when the caller has one, the English default otherwise (tests, non-React callers). */
const tr = (t: TranslateFn, key: string, en: string, params?: TranslateParams) => (t
    ? t(key, en, params)
    : en.replace(/\{(\w+)\}/g, (m, name) => (params && name in params ? String(params[name]) : m)));

/**
 * App Studio — reading and editing the links between tables.
 *
 * A relationship is not its own object in the data model: it is a field of type
 * `relation` on the table that HOLDS it, pointing at another table by id. The
 * server turns that into a real FOREIGN KEY. So every function here is a pure
 * transform of `model.tables` — no relation registry to keep in step, and the
 * diagram, the field designer and a connector's generated join all describe the
 * same one thing.
 *
 * Direction matters and is easy to read backwards, so it is fixed here: the
 * table that holds the column is the MANY side ("each attachment belongs to one
 * message"), and the edge points from it to the table it references.
 */

// Server-managed on every table (dataModel.SYSTEM_COLUMNS); a declared field may
// never claim one, so a generated key has to step around them too.
const SYSTEM_COLUMNS = ['id', 'created_at', 'updated_at', 'created_by', 'org_id'];

/** One relation, as the diagram draws it. */
export interface RelationEdge {
    id: string;
    fromTableId: string;
    toTableId: string | null;
    dangling: boolean;
    fieldId: string | undefined;
    fieldKey: string | undefined;
    fieldName: string | undefined;
}

/** Every relation in the model, as edges. `id` is stable per field. */
export function relationsOf(tables: ModelTable[]) {
    const byId = new Map((tables || []).map((t) => [t.id, t]));
    const out: RelationEdge[] = [];
    for (const table of tables || []) {
        for (const field of table.fields || []) {
            if (field?.type !== 'relation') continue;
            const toTableId = field.relation?.table || null;
            out.push({
                id: `${table.id}:${field.id}`,
                fromTableId: table.id,
                toTableId,
                // A relation whose target was deleted still has to be visible —
                // that is precisely when someone needs to find and fix it.
                dangling: !toTableId || !byId.has(toTableId),
                fieldId: field.id,
                fieldKey: field.key,
                fieldName: field.name || field.key,
            });
        }
    }
    return out;
}

/** A free column key for a link to `target`, e.g. `messages_ref`. */
export function relationKeyFor(table: ModelTable, target: ModelTable) {
    const base = slugifyKey(`${target?.key || target?.name || 'parent'}_ref`);
    const used = new Set((table?.fields || []).map((f) => f.key));
    const free = (k: string) => !used.has(k) && !SYSTEM_COLUMNS.includes(k);
    if (free(base)) return base;
    let n = 2;
    while (!free(`${base}_${n}`)) n += 1;
    return `${base}_${n}`;
}

/**
 * Link `fromTableId` → `toTableId` by adding a relation column to the FROM table.
 * Returns { tables, error } — `error` is a sentence for the author, and `tables`
 * is then the unchanged input.
 */
export function addRelation(tables: ModelTable[], { fromTableId, toTableId }: { fromTableId: string; toTableId: string }, t: TranslateFn) {
    const from = (tables || []).find((t) => t.id === fromTableId);
    const to = (tables || []).find((t) => t.id === toTableId);
    if (!from || !to) return { tables, error: tr(t, 'studio_apps_tables.relations.table_gone', 'That table is gone — reopen the designer.') };

    const already = (from.fields || []).some(
        (f) => f.type === 'relation' && f.relation?.table === toTableId,
    );
    if (already) {
        return { tables, error: tr(t, 'studio_apps_tables.relations.already_linked', '“{from}” already links to “{to}”.', { from: from.name || from.key, to: to.name || to.key }) };
    }

    const field = {
        id: newFieldId(),
        key: relationKeyFor(from, to),
        name: `${to.name || to.key} record`,
        type: 'relation',
        required: false,
        unique: false,
        relation: { table: toTableId },
    };
    return { tables: tables.map((t) => (t.id === fromTableId ? { ...t, fields: [...(t.fields || []), field] } : t)) };
}

/** Point an existing relation column at a different table. */
export function retargetRelation(tables: ModelTable[], { tableId, fieldId, toTableId }: { tableId: string; fieldId: string | undefined; toTableId: string }) {
    return (tables || []).map((t) => (t.id !== tableId ? t : {
        ...t,
        fields: (t.fields || []).map((f) => (f.id !== fieldId ? f : { ...f, relation: { table: toTableId } })),
    }));
}

/** Rename the relation column's display name (the KEY is a migration — not here). */
export function renameRelation(tables: ModelTable[], { tableId, fieldId, name }: { tableId: string; fieldId: string | undefined; name: string }) {
    return (tables || []).map((t) => (t.id !== tableId ? t : {
        ...t,
        fields: (t.fields || []).map((f) => (f.id !== fieldId ? f : { ...f, name })),
    }));
}

export function removeRelation(tables: ModelTable[], { tableId, fieldId }: { tableId: string; fieldId: string | undefined }) {
    return (tables || []).map((t) => (t.id !== tableId ? t : {
        ...t,
        fields: (t.fields || []).filter((f) => f.id !== fieldId),
    }));
}

/**
 * Connectors that FILL this link. A connector's sync writes the parent's record
 * id into `relationField` on every refresh, and the model rejects a sync whose
 * relation column is gone — so deleting one here would fail the whole save with a
 * 422 later. Named up front instead.
 */
export function fillersOfRelation(connectors: Connector[] | null | undefined, tableId: string, fieldKey: string | undefined) {
    return (connectors || []).filter((c) => (c?.sync?.children || []).some(
        (child: { tableId?: string; relationField?: unknown } | null) => child?.tableId === tableId && child?.relationField === fieldKey,
    ));
}

const NODE_W = 240;
const NODE_H = 150;
const GAP_X = 60;
const GAP_Y = 90;

/**
 * Where to draw each table. Depth is the LONGEST path along the relation edges
 * towards a parent, so a chain "messages → read → attachments" reads top to
 * bottom instead of doubling back. Cycles are legal in the model (a table may
 * reference itself), so the walk is depth-capped rather than assuming a tree.
 */
export function layoutTables(tables: ModelTable[]) {
    const list = tables || [];
    const byId = new Map<string | undefined, ModelTable>(list.map((t) => [t.id, t]));
    const parentsOf = new Map<string | undefined, (string | undefined)[]>(list.map((t) => [t.id, (t.fields || [])
        .filter((f) => f?.type === 'relation' && byId.has(f.relation?.table) && f.relation?.table !== t.id)
        .map((f) => f.relation?.table)]));

    const depth = new Map<string | undefined, number>();
    const depthOf = (id: string | undefined, seen: Set<string | undefined>): number => {
        if (depth.has(id)) return depth.get(id) ?? 0;
        if (seen.has(id)) return 0;                 // a cycle: stop rather than recurse
        seen.add(id);
        const parents = parentsOf.get(id) || [];
        const d = parents.length ? Math.max(...parents.map((p) => depthOf(p, seen) + 1)) : 0;
        seen.delete(id);
        depth.set(id, d);
        return d;
    };
    for (const t of list) depthOf(t.id, new Set());

    const rows = new Map<number, string[]>();
    for (const t of list) {
        const d = depth.get(t.id) || 0;
        if (!rows.has(d)) rows.set(d, []);
        rows.get(d)?.push(t.id);
    }

    const positions: Record<string, { x: number; y: number }> = {};
    for (const [d, ids] of rows.entries()) {
        const width = ids.length * NODE_W + (ids.length - 1) * GAP_X;
        ids.forEach((id: string, i: number) => {
            positions[id] = { x: i * (NODE_W + GAP_X) - width / 2, y: d * (NODE_H + GAP_Y) };
        });
    }
    return positions;
}

export const LAYOUT = { NODE_W, NODE_H };
