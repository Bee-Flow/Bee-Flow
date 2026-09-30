/**
 * The column vocabulary: what a column may be, what it is called on screen,
 * what a change to the list would DESTROY, and which columns belong to the
 * platform rather than the author.
 *
 * Port of the pure half of the web's datatableDisplay.js
 * (agent-hub/src/components/admin/Studio/Datatables), pinned to it by
 * display.lockstep.test.ts — the web module runs next to this one on the same
 * fixtures. The server's own rules (dataModel/datatableFields.normalizeFields)
 * judge again on save; this is what lets the phone say so before asking.
 */

import { humanizeFieldKey } from '@/shared/lib/humanizeKey';

import type { Column, ColumnDraft, ColumnType, Datatable } from './types';

/** The designer's nine types, in the web's order, with the i18n key each is worded by. */
export const COLUMN_TYPES: readonly { type: ColumnType; key: string; fallback: string; blurbKey: string; blurb: string }[] = [
    { type: 'text', key: 'mobile.datatables.type_text', fallback: 'Text', blurbKey: 'mobile.datatables.type_text_blurb', blurb: 'A name, an e-mail address, a reference' },
    { type: 'number', key: 'mobile.datatables.type_number', fallback: 'Number', blurbKey: 'mobile.datatables.type_number_blurb', blurb: 'Amounts and counts you can compare' },
    { type: 'bool', key: 'mobile.datatables.type_bool', fallback: 'Yes / no', blurbKey: 'mobile.datatables.type_bool_blurb', blurb: 'A checkbox' },
    { type: 'date', key: 'mobile.datatables.type_date', fallback: 'Date', blurbKey: 'mobile.datatables.type_date_blurb', blurb: 'A day, with no time of day' },
    { type: 'datetime', key: 'mobile.datatables.type_datetime', fallback: 'Date and time', blurbKey: 'mobile.datatables.type_datetime_blurb', blurb: 'A moment' },
    { type: 'select', key: 'mobile.datatables.type_select', fallback: 'One of a list', blurbKey: 'mobile.datatables.type_select_blurb', blurb: 'Pick a single option you define' },
    { type: 'multiselect', key: 'mobile.datatables.type_multiselect', fallback: 'Several of a list', blurbKey: 'mobile.datatables.type_multiselect_blurb', blurb: 'Pick any number of options you define' },
    { type: 'richtext', key: 'mobile.datatables.type_richtext', fallback: 'Long text', blurbKey: 'mobile.datatables.type_richtext_blurb', blurb: 'Notes, a description, a message body' },
    { type: 'file', key: 'mobile.datatables.type_file', fallback: 'File', blurbKey: 'mobile.datatables.type_file_blurb', blurb: 'An attachment reference' },
];

/** The builder's field kind a column type reads as (datatableDisplay COLUMN_TYPE_KIND). */
const COLUMN_TYPE_KIND: Readonly<Record<string, string>> = {
    text: 'text',
    richtext: 'text',
    number: 'number',
    bool: 'yesno',
    date: 'date',
    datetime: 'date',
    select: 'choice',
    multiselect: 'list',
    file: 'file',
    relation: 'relation',
};

export function columnTypeKind(type: unknown): string {
    return COLUMN_TYPE_KIND[String(type)] ?? 'unknown';
}

/** Mirrors dataModel/vocabulary KEY_RE and SYSTEM_COLUMNS. */
export const KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;
export const SYSTEM_COLUMNS: readonly string[] = ['id', 'created_at', 'updated_at', 'created_by', 'org_id'];
export const MAX_FIELDS_PER_TABLE = 100;
export const MAX_NAME_LEN = 120;

/** "Invoice date " → "invoice_date". Never produces an invalid key. */
export function keyFromName(name: unknown): string {
    const slug = String(name ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 63);
    if (!slug) return '';
    return /^[a-z]/.test(slug) ? slug : `c_${slug}`.slice(0, 63);
}

/** What to CALL a column on screen: its name, or its key made readable. */
export function columnLabel(column: Partial<Pick<Column, 'name' | 'key'>> | null | undefined): string {
    const name = typeof column?.name === 'string' ? column.name.trim() : '';
    if (name) return name;
    return humanizeFieldKey(column?.key) || String(column?.key ?? '');
}

/** Why a proposed column list cannot be saved, as a code the sheet words. Null when it can. */
export type ColumnProblem =
    | { code: 'too_many' }
    | { code: 'no_key'; column: string }
    | { code: 'bad_key'; column: string }
    | { code: 'system_key'; column: string }
    | { code: 'duplicate_key'; column: string }
    | { code: 'no_type'; column: string }
    | { code: 'name_too_long'; column: string }
    | { code: 'no_options'; column: string };

const KNOWN_TYPES = new Set<string>(COLUMN_TYPES.map((t) => t.type));

function problemOf(f: Partial<ColumnDraft>, seen: Set<string>): ColumnProblem | null {
    const key = f.key ?? '';
    const column = f.name || key;
    if (!key) return { code: 'no_key', column };
    if (!KEY_RE.test(key)) return { code: 'bad_key', column: key };
    if (SYSTEM_COLUMNS.includes(key)) return { code: 'system_key', column: key };
    if (seen.has(key)) return { code: 'duplicate_key', column: key };
    if (!f.type || !KNOWN_TYPES.has(f.type)) return { code: 'no_type', column };
    if ((f.name ?? '').length > MAX_NAME_LEN) return { code: 'name_too_long', column };
    if ((f.type === 'select' || f.type === 'multiselect') && !(f.options ?? []).length) {
        return { code: 'no_options', column };
    }
    return null;
}

/** The FIRST thing wrong with a list — the web's validateColumns says every thing, the phone one at a time. */
export function columnProblem(fields: readonly Partial<ColumnDraft>[]): ColumnProblem | null {
    if (fields.length > MAX_FIELDS_PER_TABLE) return { code: 'too_many' };
    const seen = new Set<string>();
    for (const f of fields) {
        const problem = problemOf(f, seen);
        if (problem) return problem;
        seen.add(f.key ?? '');
    }
    return null;
}

/** What saving `next` over `prev` would destroy: dropped columns and retyped ones. */
export function destructiveChanges(
    prev: readonly Pick<ColumnDraft, 'key' | 'type'>[],
    next: readonly Pick<ColumnDraft, 'key' | 'type'>[],
): { removed: string[]; retyped: { key: string; from: string; to: string }[]; any: boolean } {
    const before = new Map(prev.map((f) => [f.key, f]));
    const after = new Map(next.map((f) => [f.key, f]));
    const removed = [...before.keys()].filter((k) => !after.has(k));
    const retyped = [...after.entries()]
        .filter(([k, f]) => before.has(k) && before.get(k)?.type !== f.type)
        .map(([k, f]) => ({ key: k, from: String(before.get(k)?.type), to: f.type }));
    return { removed, retyped, any: removed.length > 0 || retyped.length > 0 };
}

/** Kinds whose WHOLE column list is somebody else's: a mirror's source, a form's questions. */
export const SOURCE_MANAGED_KINDS: readonly string[] = ['nextcloud_table', 'spreadsheet_file'];
const DEFINITION_MANAGED_KINDS: readonly string[] = ['form_answers'];

/** The columns a managed kind fixes (dataModel/managedTables), by key. */
export const MANAGED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
    nextcloud_table: [],
    spreadsheet_file: [],
    form_answers: ['run_id', 'completed_at'],
    http_cache: [
        'cache_key', 'request_host', 'request_path', 'request_method',
        'response_status', 'response_body', 'response_headers', 'fetched_at',
    ],
};

export function isSourceMirror(table: Pick<Datatable, 'managedKind'> | null | undefined): boolean {
    return !!table?.managedKind && SOURCE_MANAGED_KINDS.includes(table.managedKind);
}

export function isSchemaLocked(kind: string | null | undefined): boolean {
    return !!kind && (SOURCE_MANAGED_KINDS.includes(kind) || DEFINITION_MANAGED_KINDS.includes(kind));
}

/** Is this column the platform's to fill in, rather than the author's own? */
export function isManagedColumn(kind: string | null | undefined, key: string): boolean {
    if (isSchemaLocked(kind)) return true;
    return (MANAGED_COLUMNS[kind ?? ''] ?? []).includes(key);
}

/** The Studio kind a table wears: a web-service cache paints as an app. */
export function tableKindOf(table: Pick<Datatable, 'managedKind'> | null | undefined): 'app' | 'datatable' {
    return table?.managedKind === 'http_cache' ? 'app' : 'datatable';
}

/** A stored column back to what a PUT /schema sends: the id keeps it the same column. */
export function draftOf(column: Column): ColumnDraft {
    const type = KNOWN_TYPES.has(column.type) ? (column.type as ColumnType) : 'text';
    return {
        id: column.id || undefined,
        key: column.key,
        name: column.name,
        type,
        ...(type === 'select' || type === 'multiselect' ? { options: column.options } : {}),
        ...(column.required ? { required: true } : {}),
        ...(column.unique ? { unique: true } : {}),
    };
}
