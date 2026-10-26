import {
    AlertTriangle, AlertOctagon, ZapOff, RefreshCcw, XCircle,
    Clock, Filter, Search, Bot, Paperclip, FileWarning, RefreshCw,
} from 'lucide-react';
import { useState, useMemo } from 'react';
import { fNum as fmt, fmtTime, fmtDuration, fmtBytes, shortModel } from './usage/format';
import { Card, MetricCard, MetricGrid, MonitorHero, TabHeader, AlertBanner, EmptyInline, TOKENS } from './usage/kit';
import { SEMANTIC } from '../../config/analyticsConfig';
import { useTranslation, type TranslateParams } from '../../hooks/useTranslation';
import { useOrgTerminationsQuery } from '../../api/queries/orgReports';
import { TYPE_ORDER, isLargeInput } from '../../utils/terminationsModel';
import type { RangeParams } from '../../utils/usageHelpers';
import type { TypeBadgeProps, StackedBarChartProps, DetailRowProps, TerminationRow, TerminationsByType, OrgTerminationsPanelProps } from './OrgTerminationsPanel.types';

const TERMINATIONS_ERROR_ALERT_PCT = 5;
const TERMINATIONS_MIN_SAMPLE = 10;

const C = SEMANTIC;


function typeMeta(tk: string) {
    if (tk === 'max_tokens') return { color: C.amber, icon: ZapOff };
    if (tk === 'max_iterations') return { color: C.orange, icon: RefreshCcw };
    if (tk === 'error') return { color: C.rose, icon: AlertOctagon };
    if (tk === 'aborted') return { color: C.cyan, icon: XCircle };
    return { color: C.rose, icon: AlertTriangle };
}

function TypeBadge({ type, t }: TypeBadgeProps) {
    const meta = typeMeta(type);
    const Icon = meta.icon;
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: `${meta.color}15`, color: meta.color, border: `1px solid ${meta.color}30` }}>
            <Icon style={{ width: 11, height: 11 }} />{t(`org.terminations_type_${type}`) || type}
        </span>
    );
}

function StackedBarChart({ data, t }: StackedBarChartProps) {
    if (!data || data.length === 0) return <EmptyInline boxed text={t('org.terminations_no_data')} />;
    const buckets: Record<string, { period: string; [type: string]: string | number }> = {};
    for (const r of data) {
        if (!buckets[r.period]) buckets[r.period] = { period: r.period };
        buckets[r.period][r.termination_type] = (buckets[r.period][r.termination_type] as number || 0) + r.count;
    }
    const periods = Object.values(buckets).sort((a, b) => a.period.localeCompare(b.period));
    const maxTotal = Math.max(...periods.map(p => TYPE_ORDER.reduce((s, t2) => s + (p[t2] as number || 0), 0)), 1);
    return (
        <div className="[display:flex] [align-items:flex-end] [gap:4px] h-[140px] [padding:8px_0]">
            {periods.map(p => {
                const total = TYPE_ORDER.reduce((s, t2) => s + (p[t2] as number || 0), 0);
                const heightPct = (total / maxTotal) * 100;
                return (
                    <div key={p.period} className="[flex:1] [display:flex] [flex-direction:column] [align-items:center] [gap:4px] min-w-[8px]">
                        <div title={`${p.period} · ${total}`} style={{ width: '100%', height: `${heightPct}%`, minHeight: total > 0 ? 2 : 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', borderRadius: '4px 4px 0 0', overflow: 'hidden' }}>
                            {TYPE_ORDER.map(tk => {
                                const v = p[tk] as number || 0;
                                if (v === 0) return null;
                                return <div key={tk} style={{ height: `${(v / total) * 100}%`, background: typeMeta(tk).color }} />;
                            })}
                        </div>
                        <span className="[font-size:9px] [color:var(--text-muted)] [white-space:nowrap]">{p.period.slice(5)}</span>
                    </div>
                );
            })}
        </div>
    );
}

function DetailRow({ label, value, mono }: DetailRowProps) {
    return (
        <div className="[display:flex] [gap:12px] [align-items:baseline]">
            <span className="min-w-[110px] [font-size:11px] [color:var(--text-muted)] [text-transform:uppercase] [letter-spacing:0.04em]">{label}</span>
            <span style={{ fontFamily: mono ? 'var(--font-mono, ui-monospace, monospace)' : 'inherit', wordBreak: 'break-all', flex: 1, color: value ? 'var(--text-primary)' : 'var(--text-muted)' }}>{value || '—'}</span>
        </div>
    );
}

const NO_REPORT: { summary: null; timeline: never[]; rows: never[]; byAgent: never[] } = { summary: null, timeline: [], rows: [], byAgent: [] };

export default function OrgTerminationsPanel({ rangeParams, showTokens = true }: OrgTerminationsPanelProps) {
    const { t } = useTranslation();
    const q = rangeParams?.startDate
        ? `?startDate=${encodeURIComponent(rangeParams.startDate)}&endDate=${encodeURIComponent(String(rangeParams.endDate))}`
        : (rangeParams?.days != null ? `?days=${rangeParams.days}` : '');
    const report = useOrgTerminationsQuery<
        { total: number; by_type: TerminationsByType },
        { period: string; termination_type: string; count: number },
        TerminationRow,
        { aborted?: number; max_iterations?: number; agent_id?: string; agent_name?: string; total: number; max_tokens?: number; errors?: number }
    >(q, rangeParams?.interval || 'day');
    const fetchData = () => { report.refetch(); };
    const loading = report.isFetching;
    const { summary, timeline, rows, byAgent } = report.data ?? NO_REPORT;

    const [filterType, setFilterType] = useState('');
    const [filterAgent, setFilterAgent] = useState('');
    const [search, setSearch] = useState('');
    const [expanded, setExpanded] = useState<string | null>(null);


    const filtered = useMemo(() => {
        let data = rows;
        if (filterType) data = data.filter(r => r.termination_type === filterType);
        if (filterAgent) data = data.filter(r => r.agent_id === filterAgent);
        if (search) {
            const q = search.toLowerCase();
            data = data.filter(r => (r.agent_name || '').toLowerCase().includes(q) || (r.model || '').toLowerCase().includes(q) || (r.error_code || '').toLowerCase().includes(q));
        }
        return data;
    }, [rows, filterType, filterAgent, search]);

    const agentOptions = useMemo(() => {
        const seen = new Map();
        for (const r of rows) if (r.agent_id && !seen.has(r.agent_id)) seen.set(r.agent_id, r.agent_name || r.agent_id);
        return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
    }, [rows]);

    const largeInputCount = useMemo(() => rows.filter(r => isLargeInput(r, showTokens)).length, [rows, showTokens]);

    const total = summary?.total || 0;
    const by: TerminationsByType = summary?.by_type || {};
    const errCount = by.error || 0;
    const errPct = total > 0 ? Math.round((errCount / total) * 100) : null;
    const cleanPct = errPct === null ? null : 100 - errPct;
    const heroColor = cleanPct === null ? '#94a3b8' : cleanPct >= 95 ? '#10b981' : cleanPct >= 80 ? '#f59e0b' : '#ef4444';
    const heroLabel = cleanPct === null ? 'No data' : cleanPct >= 95 ? 'Healthy' : cleanPct >= 80 ? 'Watch' : 'Failing';

    // Detail table column template (drop the TOKENS track in the cloud view).
    const cols = showTokens
        ? '90px 1fr 1fr 130px 90px 50px 70px 70px 24px'
        : '90px 1fr 1fr 130px 90px 50px 70px 24px';

    const refreshBtn = (
        <button onClick={fetchData} title={t('org.terminations_refresh')} className="[display:flex] [align-items:center] [justify-content:center] w-[30px] h-[30px] [border-radius:8px] [border:1px_solid_var(--border-subtle)] [background:var(--bg-secondary)] [cursor:pointer] [color:var(--text-muted)]">
            <RefreshCw style={{ width: 13, height: 13, animation: loading ? 'spin 1s linear infinite' : 'none' }} />
        </button>
    );

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: TOKENS.pagePad }}>
            <TabHeader icon={AlertTriangle} iconColor="#f43f5e" title={t('org.terminations_title')} description={t('org.terminations_subtitle')} actions={refreshBtn} />

            {loading && rows.length === 0 ? (
                <Card><div className="[padding:32px] [text-align:center] [color:var(--text-muted)]">{t('org.terminations_loading')}</div></Card>
            ) : (
                <>
                    {total >= TERMINATIONS_MIN_SAMPLE && errPct !== null && errPct > TERMINATIONS_ERROR_ALERT_PCT && (
                        <AlertBanner
                            severity={errPct > TERMINATIONS_ERROR_ALERT_PCT * 4 ? 'red' : 'amber'}
                            icon={AlertOctagon}
                            message={`${errCount} session${errCount === 1 ? '' : 's'} terminated by error (${errPct}% of total) — investigate failing integrations.`}
                            ctaLabel="Review errors"
                            onCta={() => setFilterType('error')}
                        />
                    )}

                    <MonitorHero
                        accent={heroColor}
                        eyebrow="Clean completion rate"
                        value={cleanPct === null ? '—' : `${cleanPct}%`}
                        valueColor={heroColor}
                        status={{ label: heroLabel, color: heroColor }}
                        subline={`${total} session${total === 1 ? '' : 's'} terminated · ${errCount} error${errCount === 1 ? '' : 's'} (${errPct ?? 0}%)`}
                        aside={
                            <MetricGrid cols={2} gap={TOKENS.tileGap}>
                                <MetricCard size="sm" icon={ZapOff} color={C.amber} label={t('org.terminations_kpi_max_tokens')} value={fmt(by.max_tokens || 0)} />
                                <MetricCard size="sm" icon={RefreshCcw} color={C.orange} label={t('org.terminations_kpi_max_iterations')} value={fmt(by.max_iterations || 0)} />
                                <MetricCard size="sm" icon={AlertOctagon} color={C.rose} label={t('org.terminations_kpi_errors')} value={fmt(errCount)} />
                                <MetricCard size="sm" icon={XCircle} color={C.cyan} label={t('org.terminations_kpi_aborted')} value={fmt(by.aborted || 0)} />
                            </MetricGrid>
                        }
                    />

                    {largeInputCount > 0 && (
                        <MetricGrid min={170}>
                            <MetricCard size="md" icon={FileWarning} color={C.amber} label={t('org.terminations_kpi_large_input')} value={fmt(largeInputCount)} subtitle={t('org.terminations_kpi_large_input_sub')} />
                        </MetricGrid>
                    )}

                    {/* Timeline */}
                    <Card title={t('org.terminations_over_time')} icon={Clock}>
                        <div className="[display:flex] [gap:12px] [font-size:11px] [color:var(--text-muted)] [margin-bottom:6px] [flex-wrap:wrap]">
                            {TYPE_ORDER.map(tk => (
                                <span key={tk} className="[display:flex] [align-items:center] [gap:4px]">
                                    <span style={{ width: 8, height: 8, borderRadius: 2, background: typeMeta(tk).color }} />{t(`org.terminations_type_${tk}`)}
                                </span>
                            ))}
                        </div>
                        <StackedBarChart data={timeline} t={t} />
                    </Card>

                    {/* By agent */}
                    {byAgent.length > 0 && (
                        <Card title={t('org.terminations_by_agent')} icon={Bot}>
                            <div className="[display:grid] [grid-template-columns:1fr_70px_70px_70px_70px_70px] [gap:8px] [padding:6px_4px] [font-size:10px] [font-weight:700] [text-transform:uppercase] [color:var(--text-muted)]">
                                <span>{t('org.terminations_col_agent')}</span>
                                <span className="[text-align:right]">{t('org.terminations_col_total')}</span>
                                <span className="[text-align:right]">{t('org.terminations_col_max_tok')}</span>
                                <span className="[text-align:right]">{t('org.terminations_col_max_iter')}</span>
                                <span className="[text-align:right]">{t('org.terminations_col_errors')}</span>
                                <span className="[text-align:right]">{t('org.terminations_col_aborted')}</span>
                            </div>
                            {byAgent.map(a => (
                                <div key={a.agent_id || 'unknown'} className="[display:grid] [grid-template-columns:1fr_70px_70px_70px_70px_70px] [gap:8px] [padding:8px_4px] [border-top:1px_solid_var(--border-subtle)] [font-size:12px] [color:var(--text-primary)] [align-items:center]">
                                    <span className="[overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">{a.agent_name || a.agent_id || '—'}</span>
                                    <span className="[text-align:right] [font-weight:700]">{a.total}</span>
                                    <span style={{ textAlign: 'right', color: C.amber }}>{a.max_tokens || 0}</span>
                                    <span style={{ textAlign: 'right', color: C.orange }}>{a.max_iterations || 0}</span>
                                    <span style={{ textAlign: 'right', color: C.rose }}>{a.errors || 0}</span>
                                    <span style={{ textAlign: 'right', color: C.cyan }}>{a.aborted || 0}</span>
                                </div>
                            ))}
                        </Card>
                    )}

                    {/* Detail table */}
                    <Card>
                        <div className="[display:flex] [gap:8px] [margin-bottom:12px] [flex-wrap:wrap] [align-items:center]">
                            <div className="[display:flex] [align-items:center] [gap:6px] [padding:5px_10px] [border-radius:8px] [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)] [flex:0_1_220px]">
                                <Search style={{ width: 12, height: 12, color: 'var(--text-muted)' }} />
                                <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('org.terminations_search_placeholder')} className="[background:transparent] [border:none] [outline:none] [font-size:12px] [color:var(--text-primary)] w-[100%]" />
                            </div>
                            <div style={filterSelectWrapper}>
                                <Filter style={{ width: 12, height: 12, color: 'var(--text-muted)' }} />
                                <select value={filterType} onChange={e => setFilterType(e.target.value)} style={filterSelectStyle}>
                                    <option value="">{t('org.terminations_all_types')}</option>
                                    {TYPE_ORDER.map(tk => <option key={tk} value={tk}>{t(`org.terminations_type_${tk}`)}</option>)}
                                </select>
                            </div>
                            <div style={filterSelectWrapper}>
                                <Bot style={{ width: 12, height: 12, color: 'var(--text-muted)' }} />
                                <select value={filterAgent} onChange={e => setFilterAgent(e.target.value)} style={filterSelectStyle}>
                                    <option value="">{t('org.terminations_all_agents')}</option>
                                    {agentOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                                </select>
                            </div>
                            <div className="[flex:1]" />
                            <span className="[font-size:11px] [color:var(--text-muted)]">{filtered.length} {t(filtered.length === 1 ? 'org.terminations_event' : 'org.terminations_events')}</span>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '8px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
                            <span>{t('org.terminations_col_time')}</span>
                            <span>{t('org.terminations_col_agent')}</span>
                            <span>{t('org.terminations_col_model')}</span>
                            <span>{t('org.terminations_col_type')}</span>
                            <span>{t('org.terminations_col_error_code')}</span>
                            <span className="[text-align:right]">{t('org.terminations_col_iter')}</span>
                            <span className="[text-align:right]">{t('org.terminations_col_duration')}</span>
                            {showTokens && <span className="[text-align:right]">{t('org.terminations_col_tokens')}</span>}
                            <span></span>
                        </div>

                        {filtered.length === 0 && <EmptyInline boxed text={t('org.terminations_empty')} />}

                        {filtered.map(r => {
                            const isOpen = expanded === r.id;
                            const meta = typeMeta(r.termination_type);
                            return (
                                <div key={r.id}>
                                    <div onClick={() => setExpanded(isOpen ? null : r.id)} style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '10px 8px', borderTop: '1px solid var(--border-subtle)', fontSize: 12, color: 'var(--text-primary)', alignItems: 'center', cursor: 'pointer' }}>
                                        <span className="[color:var(--text-muted)] [font-size:11px]">{fmtTime(r.timestamp)}</span>
                                        <span className="[overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">{r.agent_name || r.agent_id || <span className="text-[var(--text-muted)]">—</span>}</span>
                                        <span className="[overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap] [color:var(--text-muted)]">{shortModel(r.model)}</span>
                                        <span className="[display:flex] [align-items:center] [flex-wrap:wrap]">
                                            <TypeBadge type={r.termination_type} t={t} />
                                            {isLargeInput(r, showTokens) && (
                                                <span title={t('org.terminations_large_input_hint')} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 6px', borderRadius: 999, fontSize: 10, fontWeight: 600, background: `${C.amber}15`, color: C.amber, border: `1px solid ${C.amber}30`, marginLeft: 6 }}>
                                                    <FileWarning style={{ width: 10, height: 10 }} />{t('org.terminations_large_input')}
                                                </span>
                                            )}
                                        </span>
                                        <span style={{ fontSize: 11, color: r.error_code ? C.rose : 'var(--text-muted)' }}>{r.error_code || '—'}</span>
                                        <span className="[text-align:right] [color:var(--text-muted)]">{r.iteration_count || 0}</span>
                                        <span className="[text-align:right] [color:var(--text-muted)]">{fmtDuration(r.duration_ms)}</span>
                                        {showTokens && (
                                            <span className="[text-align:right] [color:var(--text-muted)] [display:inline-flex] [align-items:center] [justify-content:flex-end] [gap:4px]">
                                                {r.attachment_count > 0 && <Paperclip title={`${r.attachment_count} · ${fmtBytes(r.attachment_bytes || 0)}`} style={{ width: 11, height: 11, color: C.amber }} />}
                                                {fmt(r.total_tokens)}
                                            </span>
                                        )}
                                        <span style={{ color: meta.color, textAlign: 'right' }}>{isOpen ? '▾' : '▸'}</span>
                                    </div>
                                    {isOpen && (
                                        <div className="[padding:12px_16px] [background:var(--bg-primary)] [font-size:12px] [color:var(--text-muted)] [display:flex] [flex-direction:column] [gap:6px] [border-top:1px_solid_var(--border-subtle)]">
                                            <DetailRow label={t('org.terminations_detail_source')} value={r.source} />
                                            <DetailRow label={t('org.terminations_detail_conversation')} value={r.conversation_id} mono />
                                            <DetailRow label={t('org.terminations_detail_user')} value={r.user_id} mono />
                                            <DetailRow label={t('org.terminations_detail_error_class')} value={r.error_class} />
                                            <DetailRow label={t('org.terminations_detail_error')} value={r.error_first_line} mono />
                                            <DetailRow label={t('org.terminations_detail_stack')} value={r.stack_first_line} mono />
                                            {showTokens && (
                                                <DetailRow label={t('org.terminations_detail_tokens')} value={(() => {
                                                    const tot = (r.prompt_tokens || 0) + (r.completion_tokens || 0);
                                                    const ratio = tot > 0 ? Math.round((r.prompt_tokens / tot) * 100) : 0;
                                                    return `prompt ${fmt(r.prompt_tokens)} · completion ${fmt(r.completion_tokens)} · total ${fmt(r.total_tokens)}${tot > 0 ? ` (prompt ${ratio}%)` : ''}`;
                                                })()} />
                                            )}
                                            <DetailRow label={t('org.terminations_detail_attachments')} value={r.attachment_count > 0 ? `${r.attachment_count} · ${fmtBytes(r.attachment_bytes || 0)}` : null} />
                                            {isLargeInput(r, showTokens) && (
                                                <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 8, background: `${C.amber}12`, border: `1px solid ${C.amber}30`, fontSize: 11, color: C.amber, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                                                    <FileWarning style={{ width: 12, height: 12, marginTop: 1, flexShrink: 0 }} />
                                                    <span><strong>{t('org.terminations_large_input_strong')}</strong> {t('org.terminations_large_input_explain')}</span>
                                                </div>
                                            )}
                                            <div className="[margin-top:4px] [font-size:10px] [color:var(--text-muted)] [font-style:italic]">{t('org.terminations_privacy_note')}</div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </Card>
                </>
            )}
        </div>
    );
}

const filterSelectWrapper = {
    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px',
    borderRadius: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)',
};
const filterSelectStyle = {
    background: 'transparent', border: 'none', outline: 'none', fontSize: 12, color: 'var(--text-primary)', cursor: 'pointer',
};

declare module 'lucide-react' {
    // lucide passes `title` through to the <svg> and counts it as an accessible
    // name (hasA11yProp drops aria-hidden for it); its types just leave it out.
    interface LucideProps { title?: string }
}
