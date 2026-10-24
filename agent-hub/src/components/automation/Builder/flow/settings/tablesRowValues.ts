/**
 * The value model behind TablesRowValuesEditor — the `values` input of the
 * Nextcloud Tables row steps (`nextcloud_tables_create_row` /
 * `nextcloud_tables_update_row`), kept React-free so the editor file holds
 * components only and every rule here is testable on its own.
 *
 * The stored shape is the tool's own: `{ "<Column title>": <binding> }`, a
 * plain map whose members are ordinary bindings. The runtime resolves it
 * with bind.js resolveDeep, so nothing here invents a wrapper — the editor
 * reads that map, draws a slot per column, and writes that map back.
 *
 * Column-title matching (normalisation, ambiguity) lives in ./columnMatch.js,
 * the module the server mirrors; this file only applies it.
 */
import { resolveKeyToColumn } from './columnMatch';
import { API_BASE, authFetch } from '../../../../../utils/helpers';
import type { Binding } from './codeStep/codeParams';
import { logger } from '../../../../../utils/logger';

/** One column in the editor's own shape (see normaliseColumn). */
export interface TableColumn {
    id: string | number | null;
    title: string;
    type: string | null;
    subtype: string | null;
    mandatory: boolean;
    description: string;
    [key: string]: unknown;
}

/** A column as the server spells it; every member may be missing. */
export interface RawTableColumn {
    id?: string | number | null;
    title?: unknown;
    type?: string | null;
    subtype?: string | null;
    mandatory?: unknown;
    description?: string | null;
}

/** A tool's inputSchema as far as this editor reads it. */
export interface ToolInputSchema {
    properties?: Record<string, unknown>;
    required?: string[];
}

/** A stored `values` input: whatever JSON the draft holds. */
export type JsonValue = string | number | boolean | null | undefined | JsonValue[] | { [key: string]: JsonValue };

export interface ValuesMapReading {
    map: Record<string, unknown>;
    whole: Record<string, unknown> | null;
}

/** An upstream field Auto-map may draw from. */
export interface FeedField {
    key?: string;
    path?: string;
    perIteration?: boolean;
    children?: FeedField[];
}

/** An upstream variable group (mapping/upstream.js). */
export interface FeedGroup {
    kind?: string;
    basePath?: string;
    fields?: FeedField[];
}

/** The two tools whose `values` input the editor owns. */
export const TABLES_ROW_TOOLS = Object.freeze(['nextcloud_tables_create_row', 'nextcloud_tables_update_row']);

export function isTablesRowTool(tool: string) {
    return TABLES_ROW_TOOLS.includes(tool);
}

/**
 * The tool's inputSchema without `values` — for the ToolInputForm that draws
 * the OTHER inputs (tableId, rowId), so the map is not offered twice.
 * Anything else is handed back untouched (same reference).
 */
export function withoutValuesInput(inputSchema?: ToolInputSchema | null) {
    if (!inputSchema?.properties || !('values' in inputSchema.properties)) return inputSchema;
    const properties = { ...inputSchema.properties };
    delete properties.values;
    const required = Array.isArray(inputSchema.required) ? inputSchema.required.filter((k: string) => k !== 'values') : inputSchema.required;
    return { ...inputSchema, properties, required };
}

/**
 * The table as a literal — its id as a number, or its TITLE as a trimmed
 * string (the tool resolves a title itself, and so does the columns route).
 * Null when it is bound from a step (a ref/template/expr): then the table is
 * only known while the automation runs, and its columns cannot be listed at
 * design time.
 */
export function literalTableId(binding: unknown) {
    let raw: unknown = binding;
    if (raw && typeof raw === 'object') {
        if ((raw as Binding).kind !== 'literal') return null;
        raw = (raw as Binding).value;
    }
    if (raw == null) return null;
    if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : null;
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) { const n = Number(text); return n > 0 ? n : null; }
    return text;
}

/**
 * Where the editor reads a table's columns. The answer is expected in the
 * shape nextcloud_tables_list_columns already returns —
 * `{ tableId, count, columns: [{ id, title, type, subtype, mandatory, description }] }`.
 */
export function columnsEndpoint(tableId: string | number) {
    return `${API_BASE}/api/automation/catalog/nextcloud-tables/${encodeURIComponent(tableId)}/columns`;
}

/** One column in the editor's own shape, whatever the source spelled. */
export function normaliseColumn(c?: RawTableColumn | null): TableColumn {
    return {
        id: c?.id ?? null,
        title: String(c?.title ?? '').trim(),
        type: c?.type || null,
        subtype: c?.subtype || null,
        mandatory: !!c?.mandatory,
        description: c?.description || '',
    };
}

/**
 * Default column loader: the authenticated read every builder panel uses.
 * Accepts `{ columns: [...] }` or a bare array. Throws on any non-2xx — the
 * editor turns that into the typed-titles fallback; it never guesses columns.
 */
export async function loadTableColumns(tableId: string | number): Promise<TableColumn[]> {
    const res = await authFetch(columnsEndpoint(tableId));
    if (!res?.ok) {
        const err: Error & { status?: number } = new Error(`HTTP ${res?.status ?? '?'}`);
        err.status = res?.status;
        throw err;
    }
    const body = await res.json();
    const list = Array.isArray(body?.columns) ? body.columns : (Array.isArray(body) ? body : null);
    if (!list) throw new Error('no columns in the answer');
    return list.map(normaliseColumn).filter((c: TableColumn) => c.title);
}

/** Nextcloud column type → the editor's field kind (mapping/fieldKinds). */
export function columnKind(col?: Pick<RawTableColumn, 'type' | 'subtype'> | null) {
    switch (col?.type) {
        case 'text': return 'text';
        case 'number': return 'number';
        case 'datetime': return 'date';
        case 'selection':
            if (col.subtype === 'check') return 'yesno';
            return col.subtype === 'multi' ? 'list' : 'choice';
        case 'usergroup': return 'text';
        default: return 'unknown';
    }
}

/** i18n key + English word for the type badge, per Nextcloud column type. */
export const TYPE_LABEL = Object.freeze({
    text: ['automations.ndv.tables_row.type_text', 'text'],
    number: ['automations.ndv.tables_row.type_number', 'number'],
    datetime: ['automations.ndv.tables_row.type_datetime', 'date & time'],
    selection: ['automations.ndv.tables_row.type_selection', 'selection'],
    usergroup: ['automations.ndv.tables_row.type_usergroup', 'user / group'],
});
export const TYPE_LABEL_UNKNOWN = Object.freeze(['automations.ndv.tables_row.type_unknown', 'type unknown']);

const BINDING_KINDS = new Set(['literal', 'ref', 'template', 'expr']);

/**
 * What the stored `values` holds, in the two shapes the editor can draw:
 *   map   — the plain `{ title: binding }` object (the tool's own shape; a
 *           literal wrapper around it, or a JSON string of it, is unwrapped);
 *   whole — the ENTIRE map bound from a step (`{kind:'ref', path}`), which
 *           has no columns to draw and is shown as one slot instead.
 */
export function readValuesMap(value: JsonValue): ValuesMapReading {
    if (value == null || value === '') return { map: {}, whole: null };
    if (typeof value === 'string') return fromJsonString(value) || { map: {}, whole: { kind: 'literal', value } };
    if (typeof value !== 'object' || Array.isArray(value)) return { map: {}, whole: { kind: 'literal', value } };
    if (typeof value.kind === 'string' && BINDING_KINDS.has(value.kind)) {
        if (value.kind !== 'literal') return { map: {}, whole: value };
        const v = value.value;
        if (v == null || v === '') return { map: {}, whole: null };
        if (typeof v === 'object' && !Array.isArray(v)) return { map: v, whole: null };
        if (typeof v === 'string') return fromJsonString(v) || { map: {}, whole: value };
        return { map: {}, whole: value };
    }
    return { map: value, whole: null };
}

function fromJsonString(text: string): ValuesMapReading | null {
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { map: parsed, whole: null };
    } catch (err) { logger.debug('not JSON — the caller decides', err); }
    return null;
}

/**
 * Put each stored key on the column it reaches at run time. Exact titles are
 * placed first so an alias never steals a column from its proper key; a key
 * that reaches no column, or a second key onto an already-taken column, is a
 * stray — shown, never dropped.
 */
export function placeKeys(map: Record<string, unknown> | null | undefined, columns: TableColumn[]) {
    const keyForColumn: Record<string, string> = {};
    const stray: string[] = [];
    const keys = Object.keys(map || {});
    const exact = new Set(columns.map((c: TableColumn) => c.title.toLowerCase()));
    const ordered = [
        ...keys.filter(k => exact.has(k.toLowerCase())),
        ...keys.filter(k => !exact.has(k.toLowerCase())),
    ];
    for (const key of ordered) {
        const col = resolveKeyToColumn(key, columns);
        if (!col || keyForColumn[col.title] !== undefined) { stray.push(key); continue; }
        keyForColumn[col.title] = key;
    }
    return { keyForColumn, stray };
}

/**
 * The upstream fields Auto-map may draw from: a group's fields plus one
 * level of children — the same flattening autoMapInputs uses, with the same
 * two exclusions (per-iteration columns and `[*]` element paths resolve to
 * MANY values, never to one cell).
 */
export function candidateFields(group?: FeedGroup | null) {
    const out: { key: string | undefined; path: string | undefined }[] = [];
    for (const f of group?.fields || []) {
        if (f.perIteration) continue;
        out.push({ key: f.key, path: f.path });
        for (const c of f.children || []) {
            if (/\[\*\]/.test(c.path as string)) continue;
            out.push({ key: c.key, path: c.path });
        }
    }
    return out.filter((c: { key?: string; path?: string }) => c.key && c.path);
}

/** Groups Auto-map can be pointed at: real data sources, not the trigger's metadata. */
export function mappableGroups(groups?: FeedGroup[] | null) {
    return (groups || []).filter((g: FeedGroup) => g && g.kind !== 'trigger_meta' && (g.fields || []).length);
}

/**
 * The group the row is fed by: the step's own forEach item when it iterates,
 * otherwise the nearest upstream step (groups arrive nearest-last).
 */
export function feedingGroup(groups?: FeedGroup[] | null, step?: { forEach?: { overRef?: unknown; itemVar?: string } } | null) {
    const usable = mappableGroups(groups);
    const itemVar = step?.forEach?.overRef ? (step.forEach.itemVar || 'item') : null;
    if (itemVar) {
        const own = usable.find(g => g.basePath === `loop.${itemVar}`);
        if (own) return own;
    }
    return usable[usable.length - 1] || null;
}

/** Comma-, semicolon- or newline-separated titles: trimmed, de-duplicated, in order. */
export function parseTitleList(text?: unknown) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of String(text || '').split(/[\n,;]+/)) {
        const t = raw.trim();
        if (!t || seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        out.push(t);
    }
    return out;
}
