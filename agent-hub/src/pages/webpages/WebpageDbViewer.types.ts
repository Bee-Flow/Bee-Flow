import type { LucideIcon } from 'lucide-react';

export interface DbColumn {
    name: string;
    type?: string;
    primaryKey?: boolean;
    notNull?: boolean;
    defaultValue?: string | null;
}

export interface DbTable {
    name: string;
    columns: DbColumn[];
    sql?: string;
}

export interface DbSchema {
    tables?: DbTable[];
}

/** One result row; `rowid` is selected explicitly by the browse query. */
export interface DbRow {
    rowid?: number;
    [column: string]: unknown;
}

/** A column being drafted in the new-table form. */
export interface ColumnDraft {
    name: string;
    type: string;
    pk: boolean;
    notnull: boolean;
}

/** The cell being edited in the browse tab. */
export interface EditState {
    rowidx: number;
    col: string;
    value: string;
    wasNull: boolean;
}

/** What the SQL tab last ran: an error, a row set or an exec summary. */
export interface SqlResult {
    error?: string;
    kind?: 'rows' | 'exec';
    rows?: DbRow[];
    columns?: string[];
    truncated?: boolean;
    changes?: number;
    lastInsertRowid?: number;
    multi?: boolean;
    message?: string;
}

export interface TabDef {
    id: string;
    label: string;
    Icon: LucideIcon;
}

export interface SchemaTabProps {
    webpageId?: string;
    schema: DbSchema | null;
    onRefresh: () => void;
    busy: boolean;
    onError: (message: string) => void;
    unreadable?: boolean;
}

export interface BrowseTabProps {
    webpageId?: string;
    schema: DbSchema | null;
    onError: (message: string) => void;
}

export interface SqlTabProps {
    webpageId?: string;
    onError: (message: string) => void;
    onSchemaChanged?: () => void;
}

export interface Props {
    webpageId?: string;
}
