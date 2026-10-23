import type { ImportField, ImportTable } from './spreadsheetPaste';
import type { TableColumn } from '../inspector/aiFieldMatching';
import type { RowRecord } from './recordsApi';

/**
 * App Studio — the rows of ONE saved table: read them, type them, paste them.
 *
 * Reads and writes go through recordsApi, i.e. the same record endpoints the
 * running app uses, so what shows here is what a viewer's grid would show
 * (minus their access filter — this is the owner's own view). The table must
 * already exist server-side: a table that has never been saved has no storage
 * behind it, which is why TablesManager only opens this tab for a saved one.
 *
 * A cell edits in place and saves on its own (PATCH of that one column); a new
 * row is typed as a DRAFT row and only sent when it is confirmed, so a table
 * with required columns doesn't reject a half-typed row before the user has
 * reached the second one.
 */

/** A column of the table as this tab reads it: always typed, and a relation names its target. */
export type RowsField = ImportField & TableColumn & { relation?: { table?: string } | null };

export interface RowsTable extends ImportTable {
    fields?: RowsField[];
}

/** What a failed record write carries: the code, and for a conflict the row that won. */
export interface RecordWriteError {
    code?: string | null;
    body: { record: RowRecord };
}

export interface RowsTabProps {
    appId: string;
    table: RowsTable | null;
    tables?: RowsTable[];
    fieldsUnsaved?: boolean;
}
