/**
 * RowBrowser's shared vocabulary: the shapes it reads, a typed view of the
 * datatables API calls it makes, the page size, the button styles and the
 * two sentences that count rows.
 */
import type { CSSProperties } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { datatablesApi } from '../datatablesApi';

/** One declared column of a datatable, as the schema returns it. */
export interface DtColumn {
    id?: string;
    key: string;
    type: string;
    name?: string;
    label?: string;
    derived?: boolean;
    required?: boolean;
    [key: string]: unknown;
}

/** One row: the declared columns by key, plus the managed id and timestamps. */
export interface DtRow {
    id: string;
    created_at?: string | null;
    updated_at?: string | null;
    [key: string]: unknown;
}

/** The table row the browser is opened on. */
export interface DtTable {
    id: string;
    key?: string;
    rowCount?: number | null;
    grade?: string;
    retentionDays?: number | null;
    retentionField?: string | null;
    updatedAt?: string | null;
    managedKind?: string | null;
    [key: string]: unknown;
}

/** A mirror's state (useSourceMirror): the source it reads, and its last sync. */
export interface DtMirror {
    source?: {
        relations?: Array<{ fieldId?: string; kind?: string; labelFieldId?: string; localFieldId?: string }>;
        [key: string]: unknown;
    } | null;
    sync?: { lastSuccessAt?: string | null } | null;
    [key: string]: unknown;
}

/** One filter condition, as the builder edits it and the server reads it. */
export interface RowFilter {
    field: string;
    op: string;
    value?: unknown;
}

export interface RowSort {
    field: string | null;
    dir: 'asc' | 'desc';
}

interface RowPage {
    rows?: DtRow[];
    hasMore?: boolean;
    nextCursor?: string | null;
    total?: number;
}

/** A refusal from the datatables API: the server's code and body ride on the Error. */
interface ApiError {
    message?: string;
    code?: string;
    body?: { limit?: number } | null;
}

/** The datatables API calls the browser makes (datatablesApi.ts types them). */
export const rowsApi = datatablesApi;

export const PAGE = 50;
/** The server's own cap on one bulk delete (413 `too_many_ids` above it). */
export const BULK_DELETE_MAX = 200;

export const LINK_BTN = 'text-xs inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
export const CHIP_BTN = 'text-xs inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
export const ICON_BTN = 'p-1 rounded focus-visible:outline focus-visible:outline-2';
export const SUBTLE: CSSProperties = { color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' };
export const CHIP_STYLE: CSSProperties = {
    background: 'var(--bg-card)', borderColor: 'var(--border-default)',
    color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)',
};

/** Columns a `?q=` search reaches, mirroring the server's SEARCHABLE_TYPES. */
export const SEARCHABLE = new Set(['text', 'richtext', 'select', 'multiselect']);

/** "412 rows", grouped. */
export function rowsWord(t: TranslateFn, n: unknown): string {
    const count = Number(n) || 0;
    if (count === 1) return t('datatables.one_row', '1 row');
    return t('datatables.n_rows', '{n} rows', { n: new Intl.NumberFormat().format(count) });
}

/**
 * What part of the table is on screen.
 *
 * On page one the sentence names the RIGHT END of the table — the sort is
 * created_at DESC, so "the first 50" named the wrong one. Past page one an
 * honest range is not available (a keyset window has no offset, and that is
 * the point), so it says which page instead of inventing "51–100".
 */
export function windowText(t: TranslateFn, { rows, total, page }: { rows: number; total: number; page: number }): string {
    if (page > 0) {
        return t('datatables.rows_page', 'page {p} · {n} of {total}', { p: page + 1, n: rows, total });
    }
    if (rows === total) {
        return total === 1 ? t('datatables.one_row', '1 row') : t('datatables.n_rows', '{n} rows', { n: total });
    }
    return t('datatables.rows_recent', 'the {n} most recent of {total}', { n: rows, total });
}
