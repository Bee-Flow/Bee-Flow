/**
 * The value model behind the Nextcloud Tables row editor — the `values` input
 * of `nextcloud_tables_create_row` / `nextcloud_tables_update_row`, stored as
 * the tool's own `{ "<Column title>": <binding> }` map. Port of the pure half
 * of agent-hub `Builder/flow/settings/tablesRowValues.js`: the columns fetch
 * (GET /api/automation/catalog/nextcloud-tables/:id/columns) belongs to the
 * api layer, which reads its answer with `readColumnsAnswer`. Pinned by
 * settings.lockstep.test.ts.
 */

import type { JsonSchema } from '../bindings/types';

/** The two tools whose `values` input the editor owns. */
export const TABLES_ROW_TOOLS: readonly string[] = Object.freeze(['nextcloud_tables_create_row', 'nextcloud_tables_update_row']);

export function isTablesRowTool(tool: unknown): boolean {
    return TABLES_ROW_TOOLS.includes(tool as string);
}

/** The inputSchema without `values`, for the form that draws the OTHER inputs. */
export function withoutValuesInput(inputSchema: JsonSchema | null | undefined): JsonSchema | null | undefined {
    if (!inputSchema?.properties || !('values' in inputSchema.properties)) return inputSchema;
    const properties = { ...inputSchema.properties };
    delete properties.values;
    const required = Array.isArray(inputSchema.required) ? inputSchema.required.filter((k) => k !== 'values') : inputSchema.required;
    return { ...inputSchema, properties, required };
}

/** The table as a literal — a positive id or a trimmed title — or null when bound from a step. */
export function literalTableId(binding: unknown): number | string | null {
    let raw = binding;
    if (raw && typeof raw === 'object') {
        if ((raw as { kind?: unknown }).kind !== 'literal') return null;
        raw = (raw as { value?: unknown }).value;
    }
    if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : null;
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) return Number(text) > 0 ? Number(text) : null;
    return text;
}

/** Where the api layer reads a table's columns. */
export function columnsPath(tableId: string | number): string {
    return `/api/automation/catalog/nextcloud-tables/${encodeURIComponent(tableId)}/columns`;
}

export interface EditorColumn {
    id: unknown;
    title: string;
    type: unknown;
    subtype: unknown;
    mandatory: boolean;
    description: unknown;
}

/** One column in the editor's own shape, whatever the source spelled. */
export function normaliseColumn(c: unknown): EditorColumn {
    const col = (c || {}) as Record<string, unknown>;
    return {
        id: col.id ?? null,
        title: String(col.title ?? '').trim(),
        type: col.type || null,
        subtype: col.subtype || null,
        mandatory: !!col.mandatory,
        description: col.description || '',
    };
}

/** `{ columns: [...] }` or a bare array → titled columns; throws on anything else (never guesses). */
export function readColumnsAnswer(body: unknown): EditorColumn[] {
    const columns = body && typeof body === 'object' ? (body as { columns?: unknown }).columns : undefined;
    const list = Array.isArray(columns) ? columns : Array.isArray(body) ? body : null;
    if (!list) throw new Error('no columns in the answer');
    return list.map(normaliseColumn).filter((c) => c.title);
}

const SELECTION_KIND: Record<string, string> = { check: 'yesno', multi: 'list' };
const TYPE_KIND: Record<string, string> = { text: 'text', number: 'number', datetime: 'date', usergroup: 'text' };

/** Nextcloud column type → the editor's field kind (bindings/fieldKinds). */
export function columnKind(col: { type?: unknown; subtype?: unknown } | null | undefined): string {
    const type = String(col?.type);
    if (type === 'selection') return (Object.hasOwn(SELECTION_KIND, String(col?.subtype)) && SELECTION_KIND[String(col?.subtype)]) || 'choice';
    return (Object.hasOwn(TYPE_KIND, type) && TYPE_KIND[type]) || 'unknown';
}

/** i18n key + English word for the type badge, per Nextcloud column type. */
export const TYPE_LABEL: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
    text: ['automations.ndv.tables_row.type_text', 'text'],
    number: ['automations.ndv.tables_row.type_number', 'number'],
    datetime: ['automations.ndv.tables_row.type_datetime', 'date & time'],
    selection: ['automations.ndv.tables_row.type_selection', 'selection'],
    usergroup: ['automations.ndv.tables_row.type_usergroup', 'user / group'],
});
export const TYPE_LABEL_UNKNOWN: readonly [string, string] = Object.freeze(['automations.ndv.tables_row.type_unknown', 'type unknown']);

export { readValuesMap, placeKeys, candidateFields, mappableGroups, feedingGroup, parseTitleList } from './tablesRowMap';
