/**
 * The shapes the Datatables section shares: a table as the API describes it,
 * the source a mirror reads, a column, and the error a call throws.
 *
 * Every property is optional and the objects stay open (`[key: string]:
 * unknown`), because the server adds fields faster than this section reads
 * them and several screens hold only a part of a table.
 */
import type { TranslateFn } from '../../../../hooks/useTranslation';

export type { TranslateFn };

/** A JSON body or patch: the keys each call takes are documented on it. */
export type Json = Record<string, unknown>;

/** A mirror's last sync, as the source tab reads it. */
export interface SyncInfo {
    status?: string;
    lastSuccessAt?: string | null;
    sourceModifiedAt?: string | null;
    [key: string]: unknown;
}

/** A column the form describes for a form-answers table, by field id. */
export interface SourceColumn {
    fieldId: string;
    name?: string;
    retired?: boolean;
    [key: string]: unknown;
}

/** What a mirror (or a form-answers table) reads from, as `table.source`. */
export interface MirrorSource {
    provider?: string;
    ncTableId?: string | number | null;
    ncViewId?: string | number | null;
    ncUrl?: string;
    webUrl?: string | null;
    writable?: boolean;
    writeMode?: string;
    writeReason?: string | null;
    columns?: SourceColumn[];
    fileName?: string;
    fileId?: string;
    path?: string;
    format?: string;
    sheet?: string | null;
    headerRow?: number;
    owned?: boolean;
    keyColumn?: { header?: string; fieldId?: string } | null;
    [key: string]: unknown;
}

/** A datatable, as far as the display helpers read it. */
export interface TableLike {
    id?: string;
    name?: string;
    managedKind?: string | null;
    source?: MirrorSource | null;
    isPublished?: boolean;
    sharedGroups?: string[];
    writeMode?: string;
    sync?: SyncInfo | null;
    [key: string]: unknown;
}

export type MaybeTable = TableLike | null | undefined;

/** One declared column, as far as the display helpers read it. */
export interface ColumnLike {
    id?: string;
    key?: string;
    name?: string;
    type?: string;
    options?: unknown[];
    required?: boolean;
    unique?: boolean;
    [key: string]: unknown;
}

/** The part of a thrown error the section reads. */
export interface ErrorLike {
    message?: string;
    code?: string | null;
    status?: number;
    body?: unknown;
}

/** The body of a server refusal, as the mirror messages read it. */
export interface ErrorBody {
    detail?: string;
    reason?: string;
    header?: string;
    provider?: string;
    ref?: { provider?: string };
    [key: string]: unknown;
}

/** A column whose key is known: the shape a column list is compared by. */
export interface KeyedColumn extends ColumnLike {
    key: string;
}

/** One column the platform fixes on a managed table. */
export interface ManagedColumn {
    key: string;
    type: string;
    required?: boolean;
    unique?: boolean;
}

/** One filter row as the builder edits it. */
export interface FilterRow {
    field?: string;
    op?: string;
    value?: unknown;
}

/** One filter in the descriptor the server reads. */
export interface FilterEntry {
    field: string;
    op: string;
    value: unknown;
}

/** When one row expires, relative to now. */
export interface RowExpiry {
    at: Date;
    days: number;
    overdue: boolean;
}
