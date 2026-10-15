import type { RowFilter } from './rowBrowser/rowBrowserModel';

/** The keyset-paged, filtered read of a table's rows (all optional). */
export interface ListRowsOptions {
    limit?: number;
    cursor?: string | null;
    filters?: RowFilter[] | null;
    match?: string | null;
    sort?: string | null;
    dir?: string | null;
    q?: string | null;
}

/** What `describeNc` takes: a table or a view, in an optional scope. */
export interface DescribeNcOptions {
    ncTableId?: string | number | null;
    ncViewId?: string | number | null;
    scope?: string | null;
}

/** The storage and file a spreadsheet call is about. */
export interface SpreadsheetBrowseOptions {
    provider: string;
    folderId?: string | null;
    q?: string | null;
    shared?: boolean;
    pageToken?: string | null;
    scope?: string | null;
}

export interface SpreadsheetDescribeOptions {
    provider: string;
    fileId: string;
    sheet?: string | null;
    headerRow?: number | null;
    scope?: string | null;
}

/** Either 409 on a delete or a column drop can be answered with `confirmBreaking`. */
export interface ConfirmBreakingOptions {
    confirmBreaking?: boolean;
}

/** A JSON body sent as given; the shapes live in the comments of each call. */
export type Body = Record<string, unknown>;
