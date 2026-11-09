import { useMemo, useState } from 'react';
import { AlertTriangle, Bot, ChevronRight, FileWarning, Filter, Paperclip } from 'lucide-react';
import DataTable, { TableCell, TableRow, type TableColumn } from '@/components/shared/DataTable';
import { CHIP_ERROR, CHIP_WARNING } from '@/components/mcpLibrary/ui';
import { TYPE_ORDER, isLargeInput } from '@/utils/terminationsModel';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { fmt, fmtDuration, fmtTime, shortModel, Empty, TablePanel } from '../shared';
import { FilterRow, SearchField, SelectField } from '../shared/FilterControls';
import { TYPE_META, typeLabel, fmtBytes } from '../TerminationsPage.helpers';
import type { TerminationRow } from '../TerminationsPage.types';
import { TerminationDetail } from './TerminationDetail';

function TypeBadge({ type }: { type: string }) {
    const { t } = useTranslation();
    const meta = TYPE_META[type] || { color: 'var(--chart-8)', icon: AlertTriangle };
    const Icon = meta.icon;
    return (
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[var(--border-default)] px-2 py-[3px] text-[11px] font-medium text-[var(--text-primary)]">
            <Icon className="h-3 w-3 shrink-0" style={{ color: meta.color }} aria-hidden="true" />
            {typeLabel(t, type)}
        </span>
    );
}

function LargeInputBadge() {
    const { t } = useTranslation();
    return (
        <span className={CHIP_WARNING} title={t('admin_monitoring.term_large_title', 'Prompt or attachment was unusually large, likely cause of the stop')}>
            <FileWarning className="h-2.5 w-2.5" aria-hidden="true" />
            {t('admin_monitoring.term_large_input', 'Large input')}
        </span>
    );
}

function columnsOf(t: TranslateFn): TableColumn[] {
    return [
        { id: 'time', label: t('admin_monitoring.col_time', 'Time'), width: '84px' },
        { id: 'agent', label: t('admin_monitoring.col_agent', 'Agent'), width: 'minmax(0,1fr)' },
        { id: 'model', label: t('admin_monitoring.col_model', 'Model'), width: 'minmax(0,1fr)', foldBelow: 900 },
        { id: 'type', label: t('admin_monitoring.col_type', 'Type'), width: '150px' },
        { id: 'code', label: t('admin_monitoring.term_col_error_code', 'Error code'), width: '100px', foldBelow: 1180 },
        { id: 'iter', label: t('admin_monitoring.term_col_iter', 'Iter.'), width: '50px', align: 'right', foldBelow: 1180 },
        { id: 'duration', label: t('admin_monitoring.term_col_duration', 'Duration'), width: '70px', align: 'right', foldBelow: 900 },
        { id: 'tokens', label: t('admin_monitoring.col_tokens', 'Tokens'), width: '76px', align: 'right' },
        { id: 'open', label: '', width: '16px' },
    ];
}

function EventRow({ r, columns, open, onToggle }: { r: TerminationRow; columns: TableColumn[]; open: boolean; onToggle: () => void }) {
    const quiet = 'tabular-nums text-[var(--text-secondary)]';
    return (
        <TableRow columns={columns} expanded={open} ariaExpanded={open} onClick={onToggle}>
            <TableCell column={columns[0]} className="text-[11px] text-[var(--text-tertiary)]">{fmtTime(r.timestamp)}</TableCell>
            <TableCell column={columns[1]} className="truncate text-[var(--text-primary)]">{r.agent_name || r.agent_id || <span className="text-[var(--text-tertiary)]">—</span>}</TableCell>
            <TableCell column={columns[2]} className="truncate text-[var(--text-secondary)]">{shortModel(r.model)}</TableCell>
            <TableCell column={columns[3]}>
                <span className="flex flex-wrap items-center gap-1"><TypeBadge type={r.termination_type} />{isLargeInput(r) && <LargeInputBadge />}</span>
            </TableCell>
            <TableCell column={columns[4]} className="truncate text-[11px]">{r.error_code ? <span className={CHIP_ERROR}>{r.error_code}</span> : <span className="text-[var(--text-tertiary)]">—</span>}</TableCell>
            <TableCell column={columns[5]} className={quiet}>{r.iteration_count || 0}</TableCell>
            <TableCell column={columns[6]} className={quiet}>{fmtDuration(r.duration_ms)}</TableCell>
            <TableCell column={columns[7]} className={`${quiet} flex items-center gap-1`}>
                {r.attachment_count > 0 && (
                    <Paperclip className="h-3 w-3 text-[var(--warning-ink)]">
                        <title>{`${r.attachment_count} attachment${r.attachment_count !== 1 ? 's' : ''} · ${fmtBytes(r.attachment_bytes || 0)}`}</title>
                    </Paperclip>
                )}
                {fmt(r.total_tokens)}
            </TableCell>
            <TableCell column={columns[8]}>
                <ChevronRight className={`h-3.5 w-3.5 text-[var(--text-tertiary)] transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
            </TableCell>
        </TableRow>
    );
}

function useFilteredEvents(rows: TerminationRow[], filterType: string, filterAgent: string, search: string) {
    return useMemo(() => {
        const q = search.toLowerCase();
        return rows
            .filter(r => !filterType || r.termination_type === filterType)
            .filter(r => !filterAgent || r.agent_id === filterAgent)
            .filter(r => !q || [r.agent_name, r.model, r.error_code].some(v => (v || '').toLowerCase().includes(q)));
    }, [rows, filterType, filterAgent, search]);
}

/** Every termination of the range, filterable by type, agent and text; a row opens onto its sanitised metadata. */
export function TerminationsTable({ rows }: { rows: TerminationRow[] }) {
    const { t } = useTranslation();
    const [filterType, setFilterType] = useState('');
    const [filterAgent, setFilterAgent] = useState('');
    const [search, setSearch] = useState('');
    const [expanded, setExpanded] = useState<string | number | null>(null);
    const filtered = useFilteredEvents(rows, filterType, filterAgent, search);
    const agentOptions = useMemo(() => {
        const seen = new Map<string, string>();
        for (const r of rows) {
            if (r.agent_id && !seen.has(r.agent_id)) seen.set(r.agent_id, r.agent_name || r.agent_id);
        }
        return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
    }, [rows]);
    const columns = columnsOf(t);
    const title = t('admin.mon_terminations');

    return (
        <TablePanel title={title}>
            <FilterRow count={filtered.length === 1 ? t('admin_monitoring.term_event_one', '{n} event', { n: filtered.length }) : t('admin_monitoring.term_event_other', '{n} events', { n: filtered.length })}>
                <SearchField value={search} onChange={setSearch} placeholder={t('admin_monitoring.term_search', 'Search agent / model / error...')} className="w-full sm:w-60" />
                <SelectField icon={Filter} value={filterType} onChange={setFilterType} label={t('admin_monitoring.term_all_types', 'All types')}>
                    <option value="">{t('admin_monitoring.term_all_types', 'All types')}</option>
                    {TYPE_ORDER.map(ty => <option key={ty} value={ty}>{typeLabel(t, ty)}</option>)}
                </SelectField>
                <SelectField icon={Bot} value={filterAgent} onChange={setFilterAgent} label={t('admin_monitoring.term_all_agents', 'All agents')}>
                    <option value="">{t('admin_monitoring.term_all_agents', 'All agents')}</option>
                    {agentOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </SelectField>
            </FilterRow>
            <DataTable<TerminationRow & { id: string | number }>
                ariaLabel={title}
                columns={columns}
                rows={filtered}
                rowKey={r => r.id}
                empty={<Empty text="No terminations match the filters" />}
                renderRow={(r) => {
                    const open = expanded === r.id;
                    return (
                        <>
                            <EventRow r={r} columns={columns} open={open} onToggle={() => setExpanded(open ? null : r.id)} />
                            {open && <TerminationDetail r={r} />}
                        </>
                    );
                }}
            />
        </TablePanel>
    );
}
