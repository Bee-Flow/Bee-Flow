import React, { useMemo, useState } from 'react';
import { Table2 } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { tableHandlesIn } from '@/api/queries/automation/runTables';
import type { TableHandle } from '@/api/queries/automation/runTables';
import RunTableView from './RunTableView';

const OPEN_BTN = 'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]';

function RunTableChip({ runId, table }: { runId: string; table: TableHandle }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const summary = t('automation_tables.view.summary', '{rows} rows · {columns} columns', { rows: table.rowCount, columns: table.columns.length });
    const openLabel = t('automation_tables.view.open', 'Open table');
    return (
        <li className="min-w-0" data-testid="run-table-chip">
            <div className="flex items-center gap-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] pl-2.5 pr-1 py-1 min-w-0">
                <Table2 size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
                <span className="min-w-0 truncate font-medium text-[var(--text-primary)]" title={table.name}>{table.name}</span>
                <span className="shrink-0 pl-1 text-[var(--text-tertiary)]">{summary}</span>
                <span className="ml-auto flex shrink-0 items-center pl-1">
                    <button type="button" className={OPEN_BTN} onClick={() => setOpen(true)} aria-label={`${openLabel}: ${table.name}`}>
                        <span>{openLabel}</span>
                    </button>
                </span>
            </div>
            {open && <RunTableView runId={runId} table={table} onClose={() => setOpen(false)} />}
        </li>
    );
}

/**
 * The tables a step kept, one compact chip each: name, rows and columns, and
 * Open table, which shows them a page at a time. Nothing renders for a step
 * that kept none.
 */
export default function RunTableChips({ runId, output }: { runId: string | null | undefined; output: unknown }) {
    const { t } = useTranslation();
    // A table can come from an earlier run of the same automation: ask the run that wrote it.
    const tables = useMemo(
        () => tableHandlesIn(output).flatMap((table) => { const from = table.runId ?? runId; return from ? [{ table, from }] : []; }),
        [output, runId],
    );
    if (!tables.length) return null;
    return (
        <ul aria-label={t('automation_tables.view.title', 'Table')} className="flex flex-col gap-1.5 text-xs shrink-0">
            {tables.map(({ table, from }) => <RunTableChip key={table.tableId} runId={from} table={table} />)}
        </ul>
    );
}
