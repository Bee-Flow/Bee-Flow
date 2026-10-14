import type { PasteField } from './spreadsheetPaste';

/** One row of the table, as the record endpoints send it. */
export type Row = { id: string; updated_at?: string | null; [key: string]: unknown };

/** A row of the table a relation points at. */
export type RelationRow = Record<string, unknown> & { id?: unknown };

/** A column of the table the rows belong to. */
export interface RowsField extends PasteField {
    relation?: { table?: string | null } | null;
    unique?: boolean;
}

/** The table the rows belong to. */
export interface RowsTable {
    id?: string;
    key?: string;
    name?: string;
    fields?: RowsField[];
}

export interface RowsTabProps {
    appId: string | null | undefined;
    table: RowsTable | null | undefined;
    tables?: RowsTable[];
    fieldsUnsaved?: boolean;
}
