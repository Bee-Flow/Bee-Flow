import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Loader2 } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { useTranslation } from '@/hooks/useTranslation';
import { AutomationRequestError } from '@/api/queries/automation/http';
import { downloadRunTableCsv, useRunTablePage } from '@/api/queries/automation/runTables';
import type { TableColumn, TableHandle } from '@/api/queries/automation/runTables';

/** Rows on one page of the grid. */
const TABLE_PAGE_SIZE = 50;

const BTN = 'inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed';

/** A cell as the grid shows it: plain text, no formatting that would change the value. */
export function cellText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function Grid({ name, columns, rows }: { name: string; columns: TableColumn[]; rows: Record<string, unknown>[] }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-auto max-h-[60vh] rounded-md border border-[var(--border-default)] bg-[var(--bg-card)]">
            <table
                className="min-w-full border-collapse text-xs"
                aria-label={`${name} (${t('automation_tables.view.columns', '{count} columns', { count: columns.length })})`}
            >
                <thead className="sticky top-0 bg-[var(--bg-secondary)]">
                    <tr>
                        {columns.map((c) => (
                            <th
                                key={c.key}
                                scope="col"
                                title={c.label}
                                className={`px-2.5 py-1.5 font-semibold text-[var(--text-primary)] border-b border-[var(--border-default)] whitespace-nowrap max-w-[16rem] truncate ${c.type === 'number' ? 'text-right' : 'text-left'}`}
                            >
                                {c.label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, i) => (
                        <tr key={i} className="odd:bg-transparent even:bg-[var(--bg-secondary)]/40">
                            {columns.map((c) => {
                                const text = cellText(row[c.key]);
                                return (
                                    <td
                                        key={c.key}
                                        title={text}
                                        className={`px-2.5 py-1 text-[var(--text-secondary)] whitespace-nowrap max-w-[16rem] truncate ${c.type === 'number' ? 'text-right tabular-nums' : 'text-left'}`}
                                    >
                                        {text}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

type PageQuery = ReturnType<typeof useRunTablePage>;

/** What the dialog shows in place of the grid: the expired, failed, loading or empty state, else the grid. */
function Body({ query, table, offset }: { query: PageQuery; table: TableHandle; offset: number }) {
    const { t } = useTranslation();
    const { data, error, isPending } = query;
    if (error instanceof AutomationRequestError && error.status === 404) {
        return <div role="alert" className="py-10 text-center text-xs text-[var(--text-secondary)]">{t('automation_tables.view.expired', 'This table has expired.')}</div>;
    }
    if (error) {
        return <div role="alert" className="py-10 text-center text-xs text-[var(--error)]">{t('automation_tables.view.error', 'The rows could not be loaded.')}</div>;
    }
    if (isPending) {
        return (
            <div role="status" className="py-10 grid place-items-center gap-2 text-xs text-[var(--text-tertiary)]">
                <Loader2 size={18} className="animate-spin" aria-hidden />
                <span>{t('automation_tables.view.loading', 'Loading rows…')}</span>
            </div>
        );
    }
    if (!data.rows.length && offset === 0) {
        return <div className="py-10 text-center text-xs text-[var(--text-secondary)]">{t('automation_tables.view.empty', 'This table has no rows.')}</div>;
    }
    return <Grid name={table.name} columns={data.columns.length ? data.columns : table.columns} rows={data.rows} />;
}

function Pager({ offset, shown, total, hasMore, onOffset }: { offset: number; shown: number; total: number; hasMore: boolean; onOffset: (n: number) => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-between gap-2 text-xs text-[var(--text-secondary)]">
            <button type="button" className={BTN} disabled={offset <= 0} onClick={() => onOffset(Math.max(0, offset - TABLE_PAGE_SIZE))}>
                <ChevronLeft size={14} aria-hidden />
                <span>{t('automation_tables.view.prev', 'Previous')}</span>
            </button>
            <span>{t('automation_tables.view.rows_range', 'Rows {from}–{to} of {total}', { from: shown ? offset + 1 : 0, to: offset + shown, total })}</span>
            <button type="button" className={BTN} disabled={!hasMore} onClick={() => onOffset(offset + TABLE_PAGE_SIZE)}>
                <span>{t('automation_tables.view.next', 'Next')}</span>
                <ChevronRight size={14} aria-hidden />
            </button>
        </div>
    );
}

/**
 * A table a run kept, in a dialog: 50 rows at a time with the column labels,
 * a pager and a CSV download. The rows come from the server page by page
 * (the table can hold a million of them); the handle's own run is asked for
 * them, which can be an earlier run of the same automation.
 */
export default function RunTableView({ runId, table, onClose }: {
    /** The run of the step; used when the handle names no run of its own. */
    runId: string;
    table: TableHandle;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [offset, setOffset] = useState(0);
    const [csvError, setCsvError] = useState<'expired' | 'failed' | null>(null);
    const sourceRun = table.runId ?? runId;
    const query = useRunTablePage(sourceRun, table.tableId, offset, TABLE_PAGE_SIZE);
    const { data, error } = query;

    const expired = error instanceof AutomationRequestError && error.status === 404;
    const total = data?.rowCount ?? table.rowCount;
    const shown = data?.rows.length ?? 0;

    const download = async () => {
        setCsvError(null);
        try {
            await downloadRunTableCsv(sourceRun, table.tableId, table.name);
        } catch (e) {
            setCsvError(e instanceof AutomationRequestError && e.status === 404 ? 'expired' : 'failed');
        }
    };

    return (
        <Modal
            open
            onClose={onClose}
            title={table.name}
            description={t('automation_tables.view.summary', '{rows} rows · {columns} columns', { rows: total, columns: table.columns.length })}
            size="xl"
            data-testid="run-table-view"
            headerActions={!expired && (
                <button type="button" className={BTN} onClick={download}>
                    <Download size={13} aria-hidden />
                    <span>{t('automation_tables.view.download_csv', 'Download as CSV')}</span>
                </button>
            )}
        >
            <div className="flex flex-col gap-3 min-h-[200px]">
                <Body query={query} table={table} offset={offset} />
                {csvError && (
                    <div role="alert" className="text-xs text-[var(--error)]">
                        {csvError === 'expired'
                            ? t('automation_tables.view.expired', 'This table has expired.')
                            : t('runs.file.download_failed', 'Could not download this file. It may have expired.')}
                    </div>
                )}
                {data && !error && (shown > 0 || offset > 0) && (
                    <Pager offset={offset} shown={shown} total={total} hasMore={data.hasMore} onOffset={setOffset} />
                )}
            </div>
        </Modal>
    );
}
