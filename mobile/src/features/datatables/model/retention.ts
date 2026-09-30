/**
 * How long a table keeps its rows — the pure half of the web's RetentionPanel
 * (agent-hub/src/components/admin/Studio/Datatables/RetentionPanel.jsx),
 * pinned to it by retention.lockstep.test.ts.
 *
 * THE WINDOW AND THE COLUMN ARE ONE SETTING. PATCH /:id refuses a window that
 * does not name the date column it counts from (`retention_field_required`),
 * because a window that silently inherits a default is one submission away
 * from deleting rows on a rule nobody chose. `retentionPatch` never builds
 * one without the other; turning the window off sends the null alone.
 *
 * A managed table's column is not the author's: the platform stamps it (a
 * cache's `fetched_at`, a form's `created_at`). A mirror's rows are its
 * source's, and the server refuses it a window (`mirror_no_retention`).
 */

import type { TranslateFn } from '@/core/i18n';

import { columnLabel, isSourceMirror } from './columns';
import type { Column, Datatable, RetentionPatch } from './types';

/** The windows offered as one tap (the web's PRESETS). */
export const RETENTION_PRESETS = [7, 30, 90] as const;
/** The server's own cap (routes/datatables/engine MAX_RETENTION_DAYS); past it is a 400. */
export const MAX_RETENTION_DAYS = 3650;
/** How far ahead "about to expire" looks (the web's SOON_DAYS). */
export const EXPIRING_WITHIN_DAYS = 7;
/** One page of rows, so the count is a real count (the rows route's ROWS_PAGE_MAX). */
export const EXPIRING_COUNT_LIMIT = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The date each managed kind stamps (dataModel/managedTables): a cache ages by
 * when an answer was fetched, a form's answers by when they were given. The
 * web names only the cache's; a form's answers table always carries its own
 * `retentionField`, so the second entry is the server's spec written down.
 */
const MANAGED_RETENTION_FIELD: Readonly<Record<string, string>> = {
    http_cache: 'fetched_at',
    form_answers: 'created_at',
};

/** The one control's choices: never, a preset, or a number of one's own. */
export type RetentionChoice = 'off' | 'custom' | `${(typeof RETENTION_PRESETS)[number]}`;

type RetentionFacts = Pick<Datatable, 'managedKind' | 'retentionDays' | 'retentionField'>;

/** A mirror is not aged out here: its rows stay as long as they are in the source. */
export function offersRetention(table: Pick<Datatable, 'managedKind'>): boolean {
    return !isSourceMirror(table);
}

/** Date and date-and-time columns: the only ones a row can be aged by. */
export function dateColumns(columns: readonly Column[]): Column[] {
    return columns.filter((c) => c.type === 'date' || c.type === 'datetime');
}

/** The column a new window would count from, when the table has an obvious one (the web's defaultField). */
export function defaultRetentionField(table: Pick<Datatable, 'managedKind'>, columns: readonly Column[]): string {
    const managed = MANAGED_RETENTION_FIELD[table.managedKind ?? ''];
    if (managed) return managed;
    return dateColumns(columns)[0]?.key ?? '';
}

/**
 * The column the editor starts on. A managed table's is fixed. Otherwise the
 * stored column is the truth while a window is set; with none set it is kept
 * only when it names one of the table's date columns — the server's
 * `created_at` default is not a choice anybody made, so the first date column
 * is offered instead.
 */
export function initialRetentionField(table: RetentionFacts, columns: readonly Column[]): string {
    const stored = table.retentionField ?? '';
    if (table.managedKind) return stored || defaultRetentionField(table, columns);
    if (stored && (table.retentionDays || dateColumns(columns).some((c) => c.key === stored))) return stored;
    return defaultRetentionField(table, columns);
}

export interface FieldOption {
    key: string;
    label: string;
}

/**
 * What the column picker shows: a managed table's one column; otherwise the
 * date columns, plus the column a live window already counts from when that
 * is not one of them (a system date), so the picker never hides the truth.
 */
export function retentionFieldOptions(table: Pick<Datatable, 'managedKind'>, columns: readonly Column[], field: string): FieldOption[] {
    const option = (key: string): FieldOption => {
        const column = columns.find((c) => c.key === key);
        return { key, label: column ? columnLabel(column) : key };
    };
    if (table.managedKind) return field ? [option(field)] : [];
    const keys = dateColumns(columns).map((c) => c.key);
    return (field && !keys.includes(field) ? [field, ...keys] : keys).map(option);
}

/** What to call the column in a sentence: its name, else its key (the web's labelOf). */
export function retentionFieldLabel(t: TranslateFn, columns: readonly Column[], key: string | null | undefined): string {
    if (!key) return t('datatables.retention_no_field', 'no column');
    return columns.find((c) => c.key === key)?.name || key;
}

/** Both halves, always; `null` turns the window off and then the column is not part of the question. */
export function retentionPatch(days: number | null, field: string): RetentionPatch {
    return days === null ? { retentionDays: null } : { retentionDays: days, retentionField: field };
}

/** A typed window: a whole number of days from 1 to the server's cap, else null. */
export function customDays(text: string): number | null {
    const trimmed = text.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const days = Number(trimmed);
    return days >= 1 && days <= MAX_RETENTION_DAYS ? days : null;
}

export function isPresetDays(days: number | null | undefined): boolean {
    return (RETENTION_PRESETS as readonly number[]).includes(days ?? -1);
}

/** Which choice a window reads as; a window that is not a preset is "Other…". */
export function retentionChoice(days: number | null, custom: boolean): RetentionChoice {
    if (custom || (!!days && !isPresetDays(days))) return 'custom';
    return days ? (String(days) as RetentionChoice) : 'off';
}

/**
 * The moment before which a row expires within `withinDays` (the web's
 * datatableDisplay.expiringSoonCutoffIso): rows whose date is at or before it
 * are the ones the sweep takes next.
 */
export function expiringSoonCutoffIso(retentionDays: number | null, withinDays: number, now = Date.now()): string | null {
    if (!retentionDays || !withinDays) return null;
    return new Date(now - (retentionDays - withinDays) * DAY_MS).toISOString();
}
