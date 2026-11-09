import { useState, useMemo } from 'react';
import { ChevronRight, Cpu, Activity } from 'lucide-react';
import DataTable, { TableCell, TableRow, TABLE_FOLDED_ONLY, type TableColumn } from '@/components/shared/DataTable';
import Pager from '@/components/shared/Pager';
import { CHIP, CHIP_INFO } from '@/components/mcpLibrary/ui';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { fmt, fmtCost, fmtDuration, fmtTime, shortModel, Empty, getSourceDetails, type UsageRecord } from './shared';
import { FilterRow, SearchField, SelectField } from './shared/FilterControls';

const PAGE_SIZE = 25;

interface ActivityPageProps {
    recent: UsageRecord[];
}

function DetailItem({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0">
            <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-[var(--text-tertiary)]">{label}</div>
            <div className="break-all text-xs font-semibold tabular-nums text-[var(--text-primary)]">{value}</div>
        </div>
    );
}

/** One call opened: tokens and cost split by input/output, and where it came from. */
function CallDetail({ r }: { r: UsageRecord }) {
    const { t } = useTranslation();
    const src = getSourceDetails(r.source, t);
    return (
        <div role="row" className="grid grid-cols-2 gap-3 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] py-3 pl-8 pr-4 sm:grid-cols-3">
            <DetailItem label={t('admin_monitoring.activity_detail_prompt_tokens', 'Prompt Tokens')} value={fmt(r.prompt_tokens)} />
            <DetailItem label={t('admin_monitoring.activity_detail_completion_tokens', 'Completion Tokens')} value={fmt(r.completion_tokens)} />
            <DetailItem label={t('admin_monitoring.activity_detail_total_tokens', 'Total Tokens')} value={fmt(r.total_tokens)} />
            <DetailItem label={t('admin_monitoring.activity_detail_input_cost', 'Input Cost')} value={fmtCost(r.input_cost || 0)} />
            <DetailItem label={t('admin_monitoring.activity_detail_output_cost', 'Output Cost')} value={fmtCost(r.output_cost || 0)} />
            <DetailItem label={t('admin_monitoring.activity_detail_total_cost', 'Total Cost')} value={fmtCost(r.estimated_cost || 0)} />
            <DetailItem label={t('admin_monitoring.activity_detail_source', 'Source')} value={src.label} />
            <DetailItem label={t('admin_monitoring.col_model', 'Model')} value={r.model || 'Unknown'} />
            {r.conversation_id && <DetailItem label={t('admin_monitoring.activity_detail_conversation', 'Conversation')} value={r.conversation_id.slice(0, 12) + '…'} />}
            {r.user_id && <DetailItem label={t('admin_monitoring.activity_detail_user', 'User')} value={r.display_name || r.user_id} />}
        </div>
    );
}

function activityColumns(t: TranslateFn): TableColumn[] {
    return [
        { id: 'time', label: t('admin_monitoring.col_time', 'Time'), width: '90px' },
        { id: 'source', label: t('admin_monitoring.col_source_agent', 'Source / Agent'), width: 'minmax(0,1fr)' },
        { id: 'model', label: t('admin_monitoring.col_model', 'Model'), width: 'minmax(0,1fr)', foldBelow: 900 },
        { id: 'tokens', label: t('admin_monitoring.col_tokens', 'Tokens'), width: '70px', align: 'right' },
        { id: 'latency', label: t('admin_monitoring.col_latency', 'Latency'), width: '70px', align: 'right', foldBelow: 900 },
        { id: 'cost', label: t('admin_monitoring.col_cost', 'Cost'), width: '84px', align: 'right' },
        { id: 'type', label: t('admin_monitoring.col_type', 'Type'), width: '76px', align: 'right', foldBelow: 1180 },
        { id: 'open', label: '', width: '16px' },
    ];
}

function CallRow({ r, columns, open, onToggle }: { r: UsageRecord; columns: TableColumn[]; open: boolean; onToggle: () => void }) {
    const { t } = useTranslation();
    const src = getSourceDetails(r.source, t);
    const SourceIcon = src.icon;
    return (
        <TableRow columns={columns} expanded={open} ariaExpanded={open} onClick={onToggle}>
            <TableCell column={columns[0]} className="text-[11px] text-[var(--text-tertiary)]">{fmtTime(r.created_at)}</TableCell>
            <TableCell column={columns[1]}>
                <span className="flex min-w-0 items-center gap-1.5">
                    <SourceIcon className="h-3 w-3 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <span className="truncate font-semibold text-[var(--text-primary)]">{r.agent_name || src.label}</span>
                </span>
                <span className={`${TABLE_FOLDED_ONLY[900]} truncate text-[10px] text-[var(--text-tertiary)]`}>{shortModel(r.model)}</span>
            </TableCell>
            <TableCell column={columns[2]} className="truncate text-[11px] text-[var(--text-secondary)]">{shortModel(r.model)}</TableCell>
            <TableCell column={columns[3]} className="font-semibold tabular-nums text-[var(--text-primary)]">{fmt(r.total_tokens)}</TableCell>
            <TableCell column={columns[4]} className="text-[11px] tabular-nums text-[var(--text-tertiary)]">{fmtDuration(r.duration_ms)}</TableCell>
            <TableCell column={columns[5]} className="tabular-nums text-[var(--text-secondary)]">{fmtCost(r.estimated_cost || 0)}</TableCell>
            <TableCell column={columns[6]}><span className={r.type === 'chat' ? CHIP_INFO : CHIP}>{r.type || '—'}</span></TableCell>
            <TableCell column={columns[7]}>
                <ChevronRight className={`h-3.5 w-3.5 text-[var(--text-tertiary)] transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
            </TableCell>
        </TableRow>
    );
}

function sortedSet(values: (string | undefined)[]) {
    return Array.from(new Set(values.filter(Boolean) as string[])).sort();
}

export function ActivityPage({ recent }: ActivityPageProps) {
    const { t } = useTranslation();
    const [search, setSearch] = useState('');
    const [filterSource, setFilterSource] = useState('');
    const [filterModel, setFilterModel] = useState('');
    const [offset, setOffset] = useState(0);
    const [expanded, setExpanded] = useState<string | number | null>(null);

    const filtered = useMemo(() => {
        const q = search.toLowerCase();
        return recent
            .filter(r => !filterSource || r.source === filterSource)
            .filter(r => !filterModel || r.model === filterModel)
            .filter(r => !q || [r.source, r.model, r.agent_name, r.type].some(v => v?.toLowerCase().includes(q)));
    }, [recent, filterSource, filterModel, search]);

    const paged = filtered.slice(offset, offset + PAGE_SIZE);
    const sourceOptions = useMemo(() => sortedSet(recent.map(r => r.source)), [recent]);
    const modelOptions = useMemo(() => sortedSet(recent.map(r => r.model)), [recent]);
    const columns = activityColumns(t);
    const resetting = <T,>(set: (v: T) => void) => (v: T) => { set(v); setOffset(0); };

    return (
        <div className="flex flex-col gap-3">
            <FilterRow count={filtered.length === 1 ? t('admin_monitoring.activity_count_one', '{n} call', { n: filtered.length }) : t('admin_monitoring.activity_count_other', '{n} calls', { n: filtered.length })}>
                <SearchField value={search} onChange={resetting(setSearch)} placeholder={t('admin_monitoring.activity_search', 'Search calls...')} className="w-full sm:w-56" />
                <SelectField icon={Activity} value={filterSource} onChange={resetting(setFilterSource)} label={t('admin_monitoring.all_sources', 'All Sources')}>
                    <option value="">{t('admin_monitoring.all_sources', 'All Sources')}</option>
                    {sourceOptions.map(s => <option key={s} value={s}>{getSourceDetails(s, t).label}</option>)}
                </SelectField>
                <SelectField icon={Cpu} value={filterModel} onChange={resetting(setFilterModel)} label={t('admin_monitoring.all_models', 'All Models')}>
                    <option value="">{t('admin_monitoring.all_models', 'All Models')}</option>
                    {modelOptions.map(m => <option key={m} value={m}>{shortModel(m)}</option>)}
                </SelectField>
            </FilterRow>
            <DataTable<UsageRecord & { id?: string }>
                ariaLabel={t('admin.mon_activity')}
                columns={columns}
                rows={paged as (UsageRecord & { id?: string })[]}
                rowKey={(r, i) => r.id || i}
                empty={<Empty text={t('admin_monitoring.activity_empty', 'No API calls found')} />}
                footer={filtered.length > PAGE_SIZE ? <Pager offset={offset} limit={PAGE_SIZE} total={filtered.length} onOffset={setOffset} /> : null}
                renderRow={(r, ctx) => {
                    const key = r.id || ctx.index;
                    const open = expanded === key;
                    return (
                        <>
                            <CallRow r={r} columns={columns} open={open} onToggle={() => setExpanded(open ? null : key)} />
                            {open && <CallDetail r={r} />}
                        </>
                    );
                }}
            />
        </div>
    );
}
