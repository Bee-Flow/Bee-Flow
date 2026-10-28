/**
 * The data-table designer's pure parts: the owner data model's shape, the two
 * kinds of table and how the screen names them, and new table ids and keys.
 */
import { slugifyKey } from './TableDesigner';
import type { Connector } from '../bi/connectors/connectorModel';
import type { TranslateFn } from '@/hooks/useTranslation';

/** One field of a model table, as the table designer edits it. */
export interface ModelField {
    id?: string;
    key?: string;
    name?: string;
    type?: string;
    required?: boolean;
    unique?: boolean;
    default?: string | number | null;
    options?: unknown[];
    relation?: { table?: string } | null;
    computed?: { expr?: string } | null;
    [key: string]: unknown;
}

/** One table of the owner data model. */
export interface ModelTable {
    id: string;
    key: string;
    name?: string;
    fields?: ModelField[];
    source?: unknown;
    [key: string]: unknown;
}

/** A connector on the model; `sync` names the table(s) it fills. */
export type ModelConnector = Connector;

/** The owner data model, as GET/PUT /:id/schema carry it. */
export interface DataModel {
    modelVersion: number;
    tables: ModelTable[];
    roles: unknown[];
    roleMapping: { default: string; byGroup: Record<string, unknown> };
    connectors?: ModelConnector[];
    directory?: { orgMembers?: boolean };
    [key: string]: unknown;
}

function randHex(n: number): string {
    let s = '';
    // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- a local schema id for a new table, not a secret or a token
    while (s.length < n) s += Math.floor(Math.random() * 16).toString(16);
    return s.slice(0, n);
}
export function newTableId(): string { return `tbl_${randHex(6)}`; }

export function emptyModel(): DataModel {
    return { modelVersion: 1, tables: [], roles: [], roleMapping: { default: 'app', byGroup: {} } };
}

export function uniqueTableKey(base: string | undefined, tables: Array<{ key?: string }> | null | undefined): string {
    const taken = new Set((tables || []).map((t) => t.key));
    let key = slugifyKey(base || 'table');
    let n = 2;
    while (taken.has(key)) { key = `${slugifyKey(base || 'table')}_${n}`; n += 1; }
    return key;
}

/**
 * THE TWO KINDS OF TABLE, kept apart on screen.
 *
 * The data model knows two (server/core/dataEngine/dataModel/vocabulary.js):
 *
 *   no `source`             the app owns its own storage — the kind there
 *                           always was;
 *   {kind:'datatable', …}   the rows live in a STUDIO DATATABLE, outside the
 *                           app, shared with automations and other apps.
 *
 * That difference MUST be visible. Two tables that look identical but behave
 * differently — renaming a column does nothing there, editing rows is not
 * possible there — make a screen whose rules the user cannot work out, and
 * so blames themselves for.
 *
 * The list lives here on its own because there is no shared vocabulary module
 * between server and client; the VERDICT stays with the server validation
 * (validate/refs.js checkTableSource). This is only what the screen shows.
 */
const TABLE_SOURCE_MODES = ['read', 'readwrite'];

export interface TableSource {
    kind: string | null;
    datatableId: string | null;
    mode: string | null;
}

/**
 * A table's source, or null when the app owns its rows itself.
 *
 * A `source` this screen does not understand does NOT return null. Null would
 * mean "the app's own", and that is exactly the claim that has not been
 * checked then — unknown narrows here to "linked, and unreadable", not to
 * "own storage".
 */
export function tableSourceOf(table: { source?: unknown } | null | undefined): TableSource | null {
    const src = table?.source;
    if (src === undefined || src === null) return null;
    if (typeof src !== 'object' || Array.isArray(src)) return { kind: null, datatableId: null, mode: null };
    const s = src as { kind?: unknown; datatableId?: unknown; mode?: unknown };
    return {
        kind: typeof s.kind === 'string' ? s.kind : null,
        datatableId: typeof s.datatableId === 'string' && s.datatableId ? s.datatableId : null,
        mode: typeof s.mode === 'string' ? s.mode : null,
    };
}

/** Only a linked table that is explicitly readwrite may write. */
export function sourceIsWritable(source: TableSource | null): boolean {
    return !!source && source.kind === 'datatable' && source.mode === 'readwrite';
}

/** One sentence on where this table's rows live — for both kinds. */
export function sourceLabel(t: TranslateFn, source: TableSource | null): string {
    if (!source) return t('app_studio.tables.source_own', 'Stored in this app');
    if (source.kind !== 'datatable' || !source.datatableId) {
        return t('app_studio.tables.source_unknown', 'Linked to something this version does not recognise');
    }
    return t('app_studio.tables.source_linked', 'Linked to a Studio table');
}

/** And with which right. A mode that is no mode narrows to unknown. */
export function modeLabel(t: TranslateFn, source: TableSource | null): string | null {
    if (!source || source.kind !== 'datatable') return null;
    if (!TABLE_SOURCE_MODES.includes(source.mode as string)) {
        // NOT "treated as read only": that fallback does not exist. An unknown
        // mode yields a 422 on EVERY read (appStudio/datatableSource.js), so
        // the link simply does not work. The sentence promised a grade the
        // screen cannot deliver, and that is exactly the kind of claim this
        // program keeps finding.
        return t('app_studio.tables.source_mode_unknown', 'Unknown access — this link does not work');
    }
    return source.mode === 'readwrite'
        ? t('app_studio.tables.source_mode_readwrite', 'Read and write')
        : t('app_studio.tables.source_mode_read', 'Read only');
}

/**
 * The connectors that fill a table. Deleting it would leave them pointing at
 * nothing, which the model validator rejects — so the screen names them.
 */
export function fillersOf(model: DataModel | null, tableId: string): ModelConnector[] {
    return (model?.connectors || []).filter((c) => c?.sync
        && (c.sync.tableId === tableId
            || (c.sync.children || []).some((child) => child?.tableId === tableId)));
}

/**
 * The model with a connector's proposed tables added and its sync pointed at
 * them, in ONE update (see useDataModel's createTableForConnector). The
 * proposed keys stay unique against what's already drafted AND against each
 * other.
 */
export function withProposedTables(base: DataModel, connectorId: string, list: ModelTable[], sync: ModelConnector['sync']): DataModel {
    const accumulated = [...(base.tables || [])];
    for (const tbl of list) {
        accumulated.push({ ...tbl, key: uniqueTableKey(tbl.key || tbl.name, accumulated) });
    }
    return {
        ...base,
        tables: accumulated,
        connectors: (base.connectors || []).map((c) => (c.id === connectorId ? { ...c, sync } : c)),
    };
}
