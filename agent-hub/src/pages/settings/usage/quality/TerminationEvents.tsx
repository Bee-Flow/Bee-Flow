import { Fragment, useMemo, useState } from 'react';
import { FileWarning, Paperclip, Search } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { isLargeInput, TYPE_ORDER } from '@/utils/terminationsModel';
import type { TerminationRow } from '@/pages/settings/OrgTerminationsPanel.types';
import { fNum, fmtBytes, fmtDuration, fmtTime, shortModel } from '../format';
import { EmptyInline } from '../kit';
import { TerminationDetail } from './TerminationDetail';
import { typeMeta } from './terminationMeta';

const TH = 'px-3 pb-2.5 text-left text-[11px] font-semibold uppercase tracking-[.06em] whitespace-nowrap text-[var(--text-muted)]';
const TD = 'border-t border-[var(--border-subtle)] px-3 py-3 align-top text-[13px] text-[var(--text-primary)]';
const FIELD = 'flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]';

function TypeBadge({ type }: { type: string }) {
    const { t } = useTranslation();
    const Icon = typeMeta(type).icon;
    return (
        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-primary)]">
            <Icon className="h-[11px] w-[11px]" aria-hidden="true" />{t(`org.terminations_type_${type}`, type)}
        </span>
    );
}

interface EventRowProps {
    row: TerminationRow;
    showTokens: boolean;
    open: boolean;
    colSpan: number;
    onToggle: () => void;
}

function EventRow({ row: r, showTokens, open, colSpan, onToggle }: EventRowProps) {
    const { t } = useTranslation();
    return (
        <Fragment>
            <tr>
                <td className={`${TD} whitespace-nowrap text-[11px] text-[var(--text-muted)]`}>{fmtTime(r.timestamp)}</td>
                <td className={TD}>{r.agent_name || r.agent_id || <span className="text-[var(--text-muted)]">—</span>}</td>
                <td className={`${TD} text-[var(--text-muted)]`}>{shortModel(r.model)}</td>
                <td className={TD}>
                    <span className="flex flex-wrap items-center gap-1.5">
                        <TypeBadge type={r.termination_type} />
                        {isLargeInput(r, showTokens) && (
                            <span title={t('org.terminations_large_input_hint', 'Prompt or attachment was unusually large — likely cause of the stop')} className="inline-flex items-center gap-[3px] rounded-full bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--warning)]">
                                <FileWarning className="h-2.5 w-2.5" aria-hidden="true" />{t('org.terminations_large_input', 'Large input')}
                            </span>
                        )}
                    </span>
                </td>
                <td className={`${TD} text-[11px] ${r.error_code ? '' : 'text-[var(--text-muted)]'}`}>{r.error_code || '—'}</td>
                <td className={`${TD} text-right text-[var(--text-muted)]`}>{r.iteration_count || 0}</td>
                <td className={`${TD} whitespace-nowrap text-right text-[var(--text-muted)]`}>{fmtDuration(r.duration_ms)}</td>
                {showTokens && (
                    <td className={`${TD} text-right text-[var(--text-muted)]`}>
                        <span className="inline-flex items-center justify-end gap-1">
                            {r.attachment_count > 0 && <Paperclip title={`${r.attachment_count} · ${fmtBytes(r.attachment_bytes || 0)}`} className="h-[11px] w-[11px] text-[var(--warning)]" />}
                            {fNum(r.total_tokens)}
                        </span>
                    </td>
                )}
                <td className={`${TD} text-right`}>
                    <button
                        type="button"
                        aria-expanded={open}
                        aria-label={t('org.terminations_toggle_details', 'Details for {agent}', { agent: r.agent_name || r.agent_id || r.id })}
                        onClick={onToggle}
                        className="cursor-pointer border-0 bg-transparent p-0 text-[var(--text-muted)]"
                    >
                        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                    </button>
                </td>
            </tr>
            {open && (
                <tr>
                    <td colSpan={colSpan} className="border-t border-[var(--border-subtle)] bg-[var(--bg-primary)] px-4 py-3">
                        <TerminationDetail row={r} showTokens={showTokens} />
                    </td>
                </tr>
            )}
        </Fragment>
    );
}

export interface TerminationEventsProps {
    rows: TerminationRow[];
    showTokens: boolean;
    /** Seeds the type filter (the error banner's button). */
    filterType: string;
    onFilterType: (type: string) => void;
}

export function TerminationEvents({ rows, showTokens, filterType, onFilterType }: TerminationEventsProps) {
    const { t } = useTranslation();
    const [filterAgent, setFilterAgent] = useState('');
    const [search, setSearch] = useState('');
    const [expanded, setExpanded] = useState<string | null>(null);
    const colSpan = showTokens ? 9 : 8;

    const filtered = useMemo(() => {
        const q = search.toLowerCase();
        return rows.filter(r => (!filterType || r.termination_type === filterType)
            && (!filterAgent || r.agent_id === filterAgent)
            && (!q || [r.agent_name, r.model, r.error_code].some(v => (v || '').toLowerCase().includes(q))));
    }, [rows, filterType, filterAgent, search]);

    const agentOptions = useMemo(() => {
        const seen = new Map<string, string>();
        for (const r of rows) if (r.agent_id && !seen.has(r.agent_id)) seen.set(r.agent_id, r.agent_name || r.agent_id);
        return [...seen.entries()].map(([id, name]) => ({ id, name }));
    }, [rows]);

    return (
        <section aria-label={t('org.terminations_events_title', 'Events')} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 pb-1 pt-2">
            <div className="flex flex-wrap items-center gap-2 px-3 pb-3.5 pt-2.5">
                <label className={`${FIELD} flex-[0_1_220px]`}>
                    <Search className="h-3 w-3 text-[var(--text-muted)]" aria-hidden="true" />
                    <input
                        type="search"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        aria-label={t('org.terminations_search_label', 'Search terminations')}
                        placeholder={t('org.terminations_search_placeholder', 'Search agent / model / error...')}
                        className="w-full border-0 bg-transparent text-xs text-[var(--text-primary)] outline-none"
                    />
                </label>
                <select aria-label={t('org.terminations_all_types', 'All types')} value={filterType} onChange={e => onFilterType(e.target.value)} className={`${FIELD} cursor-pointer`}>
                    <option value="">{t('org.terminations_all_types', 'All types')}</option>
                    {TYPE_ORDER.map(tk => <option key={tk} value={tk}>{t(`org.terminations_type_${tk}`, tk)}</option>)}
                </select>
                <select aria-label={t('org.terminations_all_agents', 'All agents')} value={filterAgent} onChange={e => setFilterAgent(e.target.value)} className={`${FIELD} cursor-pointer`}>
                    <option value="">{t('org.terminations_all_agents', 'All agents')}</option>
                    {agentOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <span className="ml-auto text-[11px] text-[var(--text-muted)]">{filtered.length} {t(filtered.length === 1 ? 'org.terminations_event' : 'org.terminations_events', filtered.length === 1 ? 'event' : 'events')}</span>
            </div>
            {filtered.length === 0 ? <EmptyInline boxed text={t('org.terminations_empty', 'No terminations match the filters')} /> : (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[820px] border-collapse">
                        <thead>
                            <tr>
                                <th className={TH}>{t('org.terminations_col_time', 'Time')}</th>
                                <th className={TH}>{t('org.terminations_col_agent', 'Agent')}</th>
                                <th className={TH}>{t('org.terminations_col_model', 'Model')}</th>
                                <th className={TH}>{t('org.terminations_col_type', 'Type')}</th>
                                <th className={TH}>{t('org.terminations_col_error_code', 'Error code')}</th>
                                <th className={`${TH} text-right`}>{t('org.terminations_col_iter', 'Iter.')}</th>
                                <th className={`${TH} text-right`}>{t('org.terminations_col_duration', 'Duration')}</th>
                                {showTokens && <th className={`${TH} text-right`}>{t('org.terminations_col_tokens', 'Tokens')}</th>}
                                <th className={TH}><span className="sr-only">{t('org.terminations_col_details', 'Details')}</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map(r => (
                                <EventRow key={r.id} row={r} showTokens={showTokens} open={expanded === r.id} colSpan={colSpan} onToggle={() => setExpanded(expanded === r.id ? null : r.id)} />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

declare module 'lucide-react' {
    // lucide passes `title` through to the <svg> and counts it as an accessible
    // name (hasA11yProp drops aria-hidden for it); its types just leave it out.
    interface LucideProps { title?: string }
}
