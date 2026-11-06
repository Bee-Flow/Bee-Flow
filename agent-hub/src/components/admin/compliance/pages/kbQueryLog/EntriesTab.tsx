import { useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import DataTable, { TableRow, TableCell, type TableColumn } from '@/components/shared/DataTable';
import EmptyState from '@/components/shared/EmptyState';
import Pager from '@/components/shared/Pager';
import { toast } from '@/components/shared/Toast';
import { fetchDownload, kbQueryLogUrls } from '@/api/complianceApi';
import { kbQueryLogQuery, useKbQueryLogEntriesQuery, useKbQueryLogOverviewQuery } from '@/api/queries/complianceReads';
import { KQL_CHANNELS, KQL_OUTCOMES, KQL_STATUSES, type KqlEntriesFilter, type KqlEntry } from '@/api/kbQueryLog.types';
import { ActionButton, DateInput, Field, Intro, ReadFailed, RegisterLayout, Select, UserSelect, fmtStamp, labelOf, type SelectOption } from '../audits/auditForms';
import type { OrgUser } from '../accessAuditLabels';
import { KQL_CHANNEL, KQL_OUTCOME, KQL_STATUS } from './labels';

interface EntriesTabProps {
    orgUsers?: OrgUser[] | null;
    isMobile?: boolean;
    exportsEnabled?: boolean;
}

interface EntriesFiltersProps {
    filter: KqlEntriesFilter;
    orgUsers: OrgUser[] | null;
    onSet: (patch: KqlEntriesFilter) => void;
    onClear: () => void;
}

/** The selection behind the entries table. */
function EntriesFilters({ filter, orgUsers, onSet, onClear }: EntriesFiltersProps) {
    const { t } = useTranslation();
    const kbs = useKbQueryLogOverviewQuery().data?.kbs ?? [];
    const set = onSet;
    const any: SelectOption = { value: '', label: t('compliance.aa_filter_any', 'Any') };
    const kbOptions: SelectOption[] = [any, ...kbs.map((k) => ({ value: k.id, label: k.name }))];
    const channelOptions: SelectOption[] = [any, ...KQL_CHANNELS.map((c) => ({ value: c, label: labelOf(t, KQL_CHANNEL, c) }))];
    const outcomeOptions: SelectOption[] = [any, ...KQL_OUTCOMES.map((c) => ({ value: c, label: labelOf(t, KQL_OUTCOME, c) }))];
    const statusOptions: SelectOption[] = [any, ...KQL_STATUSES.map((c) => ({ value: c, label: labelOf(t, KQL_STATUS, c) }))];

    return (
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-3 flex flex-wrap items-end gap-3" data-testid="kql-entries-filters">
                <Field label={t('compliance.kql_col_kb', 'Knowledge base')} className="w-[180px]">
                    <Select value={filter.kbId || ''} options={kbOptions} onChange={(v) => set({ kbId: v })} data-testid="kql-filter-kb" />
                </Field>
                <Field label={t('compliance.kql_col_person', 'Person')} className="w-[180px]">
                    <UserSelect value={filter.userId || ''} orgUsers={orgUsers} noneLabel={t('compliance.aa_filter_any', 'Any')} onChange={(v) => set({ userId: v })} data-testid="kql-filter-user" />
                </Field>
                <Field label={t('compliance.kql_col_channel', 'Channel')} className="w-[160px]">
                    <Select value={filter.channel || ''} options={channelOptions} onChange={(v) => set({ channel: v })} data-testid="kql-filter-channel" />
                </Field>
                <Field label={t('compliance.kql_col_outcome', 'Outcome')} className="w-[140px]">
                    <Select value={filter.outcome || ''} options={outcomeOptions} onChange={(v) => set({ outcome: v })} data-testid="kql-filter-outcome" />
                </Field>
                <Field label={t('compliance.kql_col_status', 'Status')} className="w-[140px]">
                    <Select value={filter.status || ''} options={statusOptions} onChange={(v) => set({ status: v })} data-testid="kql-filter-status" />
                </Field>
                <Field label={t('compliance.aa_filter_since', 'From')} className="w-[150px]">
                    <DateInput value={filter.from || ''} onChange={(v) => set({ from: v })} data-testid="kql-filter-from" />
                </Field>
                <Field label={t('compliance.aa_filter_until', 'To')} className="w-[150px]">
                    <DateInput value={filter.to || ''} onChange={(v) => set({ to: v })} data-testid="kql-filter-to" />
                </Field>
                <ActionButton onClick={onClear} data-testid="kql-filter-clear">{t('compliance.aa_filter_clear', 'Clear')}</ActionButton>
            </div>
    );
}

function entryColumns(t: TranslateFn): TableColumn[] {
    return [
        { id: 'when', width: '170px', label: t('compliance.kql_col_when', 'When') },
        { id: 'kb', width: '1fr', label: t('compliance.kql_col_kb', 'Knowledge base') },
        { id: 'person', width: '1fr', label: t('compliance.kql_col_person', 'Person'), foldBelow: 900 },
        { id: 'channel', width: '150px', label: t('compliance.kql_col_channel', 'Channel'), foldBelow: 1180 },
        { id: 'outcome', width: '110px', label: t('compliance.kql_col_outcome', 'Outcome') },
        { id: 'status', width: '120px', label: t('compliance.kql_col_status', 'Status'), foldBelow: 900 },
    ];
}

/** The CSV of the metadata under the filter on screen. A refusal is a toast, not a half file. */
function ExportButton({ filter }: { filter: KqlEntriesFilter }) {
    const { t } = useTranslation();
    const [exporting, setExporting] = useState(false);
    const exportCsv = async () => {
        setExporting(true);
        try { await fetchDownload(kbQueryLogUrls.entriesCsv(kbQueryLogQuery(filter)), 'kb-query-log-metadata.csv'); }
        catch { toast.error(t('compliance.kql_export_failed', 'The export could not be created.')); }
        finally { setExporting(false); }
    };
    return (
        <ActionButton icon={Download} onClick={exportCsv} disabled={exporting} data-testid="kql-entries-export">
            {t('compliance.kql_export_csv', 'Export metadata (CSV)')}
        </ActionButton>
    );
}

/** The metadata of every logged search: when, where, who, how it ended. The text is never part of this list. */
export default function EntriesTab({ orgUsers = null, isMobile = false, exportsEnabled = true }: EntriesTabProps) {
    const { t, resolvedLocale } = useTranslation();
    const [filter, setFilter] = useState<KqlEntriesFilter>({});
    const [offset, setOffset] = useState(0);
    const q = useKbQueryLogEntriesQuery(filter, offset);
    const set = (patch: KqlEntriesFilter) => { setFilter((f) => ({ ...f, ...patch })); setOffset(0); };

    const columns = entryColumns(t);
    const rows = q.data?.rows ?? null;

    if (q.isError) {
        return <div className="p-3.5" data-testid="kql-entries-failed"><ReadFailed>{t('compliance.kql_read_failed_entries', 'The entries could not be read.')}</ReadFailed></div>;
    }

    return (
        <RegisterLayout
            isMobile={isMobile}
            testId="kql-entries"
            toolbar={(
                <>
                    <Intro testId="kql-entries-intro">
                        {t('compliance.kql_entries_intro', 'When a search was logged, where, by whom and how it ended. Not what was asked: the text of a search is only opened for an open data-subject request.')}
                    </Intro>
                    {exportsEnabled && <ExportButton filter={filter} />}
                </>
            )}
        >
            <EntriesFilters filter={filter} orgUsers={orgUsers} onSet={set} onClear={() => { setFilter({}); setOffset(0); }} />
            <DataTable
                columns={columns}
                rows={rows ?? []}
                loading={rows === null}
                isMobile={isMobile}
                rowKey={(r: KqlEntry) => r.id}
                ariaLabel={t('compliance.kql_tab_entries_title', 'Logged searches')}
                testId="kql-entries-table"
                empty={<EmptyState title={t('compliance.kql_entries_empty', 'No logged searches in this selection')} description={t('compliance.kql_entries_empty_sub', 'Searches are logged only in knowledge bases whose log is on, from the moment it was switched on.')} />}
                footer={<Pager offset={offset} limit={q.data?.limit ?? 50} total={q.data?.total ?? null} onOffset={setOffset} testId="kql-entries-pager" />}
                renderRow={(r: KqlEntry, ctx) => (
                    <TableRow columns={ctx.columns} testId={`kql-entry-${r.id}`}>
                        <TableCell column={ctx.columns[0]}><span className="whitespace-nowrap tabular-nums text-[var(--text-secondary)]">{fmtStamp(r.createdAt, resolvedLocale)}</span></TableCell>
                        <TableCell column={ctx.columns[1]}><span className="truncate">{r.kbName || r.kbId}</span></TableCell>
                        <TableCell column={ctx.columns[2]}><span className="truncate text-[var(--text-secondary)]">{r.userName || r.userId || '—'}</span></TableCell>
                        <TableCell column={ctx.columns[3]}><span className="truncate text-[var(--text-secondary)]">{labelOf(t, KQL_CHANNEL, r.channel)}</span></TableCell>
                        <TableCell column={ctx.columns[4]}>{labelOf(t, KQL_OUTCOME, r.outcome)}</TableCell>
                        <TableCell column={ctx.columns[5]}>{labelOf(t, KQL_STATUS, r.reviewStatus)}</TableCell>
                    </TableRow>
                )}
                renderCard={(r: KqlEntry) => (
                    <div className="flex flex-col gap-0.5 min-w-0" data-testid={`kql-entry-card-${r.id}`}>
                        <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">{fmtStamp(r.createdAt, resolvedLocale)}</span>
                        <span className="text-xs font-semibold">{r.kbName || r.kbId}</span>
                        <span className="text-[11px] text-[var(--text-secondary)]">{r.userName || r.userId || '—'} · {labelOf(t, KQL_CHANNEL, r.channel)}</span>
                        <span className="text-[11px] text-[var(--text-secondary)]">{labelOf(t, KQL_OUTCOME, r.outcome)} · {labelOf(t, KQL_STATUS, r.reviewStatus)}</span>
                    </div>
                )}
            />
        </RegisterLayout>
    );
}
