import type { DatatableRecord } from './datatableTypes';

/**
 * Shapes the spreadsheet link wizard keeps: the files ticked in step 1, what
 * the server said about each file and each sheet, and the sheets selected to
 * become datatables. The server owns them; these describe what the wizard
 * reads.
 */

/** A file in a storage the person can browse, as ticked in step 1. */
export interface LinkedFileItem {
    id: string;
    name?: string | null;
    provider: string;
    sharedWriteOptIn?: boolean;
    [key: string]: unknown;
}

/** One column of a sheet as the server describes it at a header row. */
export interface SheetColumn {
    col: number;
    key: string;
    header: string;
    blankHeader?: boolean;
    type: string;
    formula?: boolean;
}

/** One sheet of a file: its name (null for a csv's only sheet) and what it links as. */
export interface DescribeSheet {
    name?: string | null;
    headerRow?: number;
    linkedAs?: unknown[] | null;
    columns?: SheetColumn[] | null;
}

/** What the server answers when a file or a sheet is described. */
export interface DescribeResult {
    sheets?: DescribeSheet[] | null;
    sheet?: DescribeSheet | null;
    write?: { mode?: string; reason?: string } | null;
    keyCandidates?: unknown[] | null;
    [key: string]: unknown;
}

/** A describe call in flight, failed, or answered. */
export interface DescribeEntry {
    loading: boolean;
    error: unknown;
    data: DescribeResult | null;
}

/** A sheet selected to become a datatable, with its name, key and columns. */
export interface SheetSelection {
    fileKey: string;
    sheetKey: string;
    describeKey?: string | null;
    provider: string;
    fileId: string;
    fileName: string;
    format?: string | null;
    sheet: string | null;
    headerRow: number;
    key: string;
    name: string;
    columns: SheetColumn[];
    keyColumn: number | null;
    sharedWriteOptIn?: boolean;
    [key: string]: unknown;
}

/** One end of a relation: the sheet it belongs to and the column chosen there. */
export interface RelationEnd {
    refKey: string;
    name?: string;
}

/** A relation between a column of one selected sheet and a column of another. */
export interface WizardRelation {
    from: RelationEnd;
    to: RelationEnd;
    localColumn: { col: number };
    targetColumn: { col: number };
}

/** A spreadsheet storage the person can link from, and whether it is connected. */
export interface SpreadsheetProvider {
    provider: string;
    connected: boolean;
    reason?: string | null;
}

/** Whether Nextcloud Tables can be linked from for this account, and why not if it cannot. */
export interface LinkableState {
    connected: boolean;
    reason?: string | null;
    tables?: unknown[] | null;
}

/** What a link wizard answers: the tables it made, and the warnings to read. */
export interface LinkedResult {
    datatables?: DatatableRecord[] | null;
    warnings?: string[] | null;
    kind?: 'nextcloud_table' | 'spreadsheet_file';
}

/** A Nextcloud view: a filtered look at a table, linkable on its own. */
export interface NcViewRow {
    ncViewId: number;
    title: string;
    linkedAs?: unknown[] | null;
}

/** A Nextcloud table as the link wizard lists it, with its views. */
export interface NcTableRow {
    ncTableId: number;
    title: string;
    emoji?: string | null;
    rowsCount?: number | null;
    columnsCount?: number | null;
    linkedAs?: unknown[] | null;
    views?: NcViewRow[] | null;
}

/** A row the picker can tick: a table, or a view of one. */
export interface NcToggleRow {
    ncTableId: number;
    ncViewId?: number | null;
    title: string;
    emoji?: string | null;
    rowsCount?: number | null;
    columnsCount?: number | null;
    linkedAs?: unknown[] | null;
}

/** A column of a Nextcloud table as it will arrive. */
export interface NcColumn {
    ncColumnId: number;
    title: string;
    type: string;
    subtype?: string | null;
    mappedType?: string | null;
    mandatory?: boolean | null;
    relationTarget?: { ncTableId: number } | null;
}

/** A table or view selected to become a datatable. */
export interface NcSelection {
    refKey: string;
    ncTableId: number;
    ncViewId: number | null;
    title: string;
    emoji: string | null;
    name: string;
    key: string;
    keyTouched: boolean;
    description: string;
}

/** The columns of a selected table, read once when its names step opens. */
export interface NcDescribe {
    loading: boolean;
    columns: NcColumn[];
    error?: string | null;
}

/** A relation between a column of one selected table and a column of another. */
export interface NcRelationDraft {
    from: NcSelection;
    to: NcSelection;
    localColumn: { id: string; title: string; type?: string | null; ncColumnId: number };
    targetColumn: { id: string; title: string; type?: string | null; ncColumnId: number };
}

/** A refusal from the Nextcloud link route: its code, and the table it is about. */
export interface NcLinkError {
    code?: string;
    message?: string;
    body?: { key?: string; ncTableId?: number } | null;
}
