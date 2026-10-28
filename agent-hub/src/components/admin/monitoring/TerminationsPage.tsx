import { useState, useEffect, useMemo, SetStateAction, Dispatch } from 'react';
import {
    AlertTriangle, AlertOctagon, ZapOff, RefreshCcw, XCircle,
    Clock, Filter, Search, Bot, Paperclip, FileWarning,
    type LucideIcon,
} from 'lucide-react';
import {
    fmt, fmtDuration, fmtTime, shortModel, COLORS,
    Card, Empty, MetricCard
} from './shared';
import { TYPE_ORDER, isLargeInput, LARGE_ATTACHMENT_BYTES_THRESHOLD, LARGE_INPUT_TOKEN_THRESHOLD } from '@/utils/terminationsModel';
import { TranslateParams, useTranslation } from '@/hooks/useTranslation';
import type { TypeMeta, TerminationRow, TerminationSummary, TimelineRow, AgentTerminations, TypeBadgeProps, TerminationsPageProps, DetailRowProps } from './TerminationsPage.types';
import { API, TYPE_META, typeLabel, fetchJson, rangeQuery, fmtBytes, filterSelectWrapper, filterSelectStyle } from './TerminationsPage.helpers';
import { StackedBarChart } from './StackedBarChart';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';
// authFetch, not raw fetch. Both send credentials, but authFetch also sets the
// no-store handling that exists because the Nextcloud proxy path was replaying
// stale per-user API responses from the browser cache — and usage figures are
// exactly that kind of per-org, always-changing response. It is also the seam
// the public demo transport hooks, so a raw fetch here silently bypasses it.

function TypeBadge({ type }: TypeBadgeProps) {
    const { t } = useTranslation();
    const meta = TYPE_META[type] || { label: type, color: COLORS.rose, icon: AlertTriangle };
    const Icon = meta.icon;
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
            background: meta.color + '15', color: meta.color, border: `1px solid ${meta.color}30`,
        }}>
            <Icon className="w-[11px] h-[11px]" />
            {typeLabel(t, type)}
        </span>
    );
}

function LargeInputBadge() {
    const { t } = useTranslation();
    return (
        <span title={t('admin_monitoring.term_large_title', 'Prompt or attachment was unusually large, likely cause of the stop')}
            style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                padding: '2px 6px', borderRadius: 999, fontSize: 10, fontWeight: 600,
                background: COLORS.amber + '15', color: COLORS.amber, border: `1px solid ${COLORS.amber}30`,
                marginLeft: 6,
            }}>
            <FileWarning className="w-[10px] h-[10px]" />
            {t('admin_monitoring.term_large_input', 'Large input')}
        </span>
    );
}

export function TerminationsPage({ range = '7d', customStart, customEnd, refreshKey }: TerminationsPageProps) {
    const { t } = useTranslation();
    const [summary, setSummary] = useState<TerminationSummary | null>(null);
    const [timeline, setTimeline] = useState<TimelineRow[]>([]);
    const [rows, setRows] = useState<TerminationRow[]>([]);
    const [byAgent, setByAgent] = useState<AgentTerminations[]>([]);
    const [loading, setLoading] = useState(true);
    const [filterType, setFilterType] = useState('');
    const [filterAgent, setFilterAgent] = useState('');
    const [search, setSearch] = useState('');
    const [expanded, setExpanded] = useState<string | number | null>(null);
    useAdjustOnChange([range, customStart, customEnd], () => setLoading(true));
    useEffect(() => {
        let cancelled = false;
        const q = rangeQuery(range, customStart, customEnd);
        const interval = (range === 'today' || (range === 'custom' && customStart && customEnd && (new Date(customEnd).getTime() - new Date(customStart).getTime()) <= 86400000))
            ? 'hour' : 'day';
        const intervalQ = (q ? '&' : '?') + `interval=${interval}`;
        Promise.all([
            fetchJson(API + '/summary' + q),
            fetchJson(API + '/timeline' + q + intervalQ),
            fetchJson(API + q + (q ? '&' : '?') + 'limit=200'),
            fetchJson(API + '/by-agent' + q),
        ]).then(([sum, tl, list, ag]) => {
            if (cancelled) return;
            setSummary(sum);
            setTimeline(tl?.rows || []);
            setRows(list?.rows || []);
            setByAgent(ag?.rows || []);
            setLoading(false);
        });
        return () => { cancelled = true; };
    }, [range, customStart, customEnd, refreshKey]);
    const filtered = useMemo(() => {
        let data = rows;
        if (filterType) data = data.filter(r => r.termination_type === filterType);
        if (filterAgent) data = data.filter(r => r.agent_id === filterAgent);
        if (search) {
            const q = search.toLowerCase();
            data = data.filter(r =>
                (r.agent_name || '').toLowerCase().includes(q) ||
                (r.model || '').toLowerCase().includes(q) ||
                (r.error_code || '').toLowerCase().includes(q)
            );
        }
        return data;
    }, [rows, filterType, filterAgent, search]);

    const agentOptions = useMemo(() => {
        const seen = new Map<string, string>();
        for (const r of rows) {
            if (r.agent_id && !seen.has(r.agent_id)) seen.set(r.agent_id, r.agent_name || r.agent_id);
        }
        return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
    }, [rows]);

    const largeInputCount = useMemo(() => rows.filter(isLargeInput).length, [rows]);

    if (loading) {
        return (
            <Card>
                <div className="[padding:40px] [text-align:center] [color:var(--text-muted,#888)]">
                    {t('admin_monitoring.term_loading', 'Loading terminations…')}
                </div>
            </Card>
        );
    }

    const total = summary?.total || 0;
    const by: Record<string, number> = summary?.by_type || {};

    return (
        <div className="[display:flex] [flex-direction:column] [gap:16px] [animation:fadeIn_0.3s_ease]">
            {/* KPI cards */}
            <div className="[display:grid] [grid-template-columns:repeat(auto-fit,minmax(170px,1fr))] [gap:12px]">
                <MetricCard icon={AlertTriangle}  label={t('admin_monitoring.col_total', 'Total')}          value={fmt(total)}                       color={COLORS.rose} />
                <MetricCard icon={ZapOff}          label={typeLabel(t, 'max_tokens')}    value={fmt(by.max_tokens || 0)}          color={COLORS.amber}
                    subtitle={total ? t('admin_monitoring.term_pct_stops', '{pct}% of stops', { pct: Math.round(((by.max_tokens || 0) / total) * 100) }) : ''} />
                <MetricCard icon={RefreshCcw}      label={typeLabel(t, 'max_iterations')} value={fmt(by.max_iterations || 0)}     color={COLORS.orange}
                    subtitle={total ? t('admin_monitoring.term_pct_stops', '{pct}% of stops', { pct: Math.round(((by.max_iterations || 0) / total) * 100) }) : ''} />
                <MetricCard icon={AlertOctagon}    label={t('admin_monitoring.col_errors', 'Errors')}         value={fmt(by.error || 0)}              color={COLORS.rose}
                    subtitle={total ? t('admin_monitoring.term_pct_stops', '{pct}% of stops', { pct: Math.round(((by.error || 0) / total) * 100) }) : ''} />
                <MetricCard icon={XCircle}         label={typeLabel(t, 'aborted')}        value={fmt(by.aborted || 0)}            color={COLORS.cyan}
                    subtitle={t('admin_monitoring.term_client_disconnects', 'Client disconnects')} />
                <MetricCard icon={FileWarning}     label={t('admin_monitoring.term_large_input', 'Large input')}    value={fmt(largeInputCount)}            color={COLORS.amber}
                    subtitle={t('admin_monitoring.term_likely_big', 'Likely caused by big prompt / attachment')} />
            </div>

            {/* Timeline chart */}
            <Card title={t('admin_monitoring.term_over_time', 'Terminations over time')} icon={Clock}>
                <div className="[display:flex] [gap:12px] [font-size:11px] [color:var(--text-muted,#888)] [margin-bottom:6px]">
                    {TYPE_ORDER.map(ty => (
                        <span key={ty} className="[display:flex] [align-items:center] [gap:4px]">
                            <span style={{ width: 8, height: 8, borderRadius: 2, background: TYPE_META[ty].color }} />
                            {typeLabel(t, ty)}
                        </span>
                    ))}
                </div>
                <StackedBarChart data={timeline} />
            </Card>

            {/* By agent */}
            {byAgent.length > 0 && (
                <Card title={t('admin_monitoring.term_by_agent', 'By agent')} icon={Bot}>
                    <div className="[display:grid] [grid-template-columns:1fr_80px_80px_80px_80px_80px] [gap:8px] [padding:6px_4px] [font-size:10px] [font-weight:700] [text-transform:uppercase] [color:var(--text-muted,#666)]">
                        <span>{t('admin_monitoring.col_agent', 'Agent')}</span>
                        <span className="[text-align:right]">{t('admin_monitoring.col_total', 'Total')}</span>
                        <span className="[text-align:right]">{t('admin_monitoring.col_max_tok', 'Max tok.')}</span>
                        <span className="[text-align:right]">{t('admin_monitoring.col_max_iter', 'Max iter.')}</span>
                        <span className="[text-align:right]">{t('admin_monitoring.col_errors', 'Errors')}</span>
                        <span className="[text-align:right]">{t('admin_monitoring.col_aborted', 'Aborted')}</span>
                    </div>
                    {byAgent.map(a => (
                        <div key={a.agent_id || 'unknown'} className="[display:grid] [grid-template-columns:1fr_80px_80px_80px_80px_80px] [gap:8px] [padding:8px_4px] [border-top:1px_solid_var(--border-default,rgba(255,255,255,0.06))] [font-size:12px] [color:var(--text-primary,#fff)] [align-items:center]">
                            <span>{a.agent_name || a.agent_id || '—'}</span>
                            <span className="[text-align:right] [font-weight:700]">{a.total}</span>
                            <span style={{ textAlign: 'right', color: COLORS.amber }}>{a.max_tokens || 0}</span>
                            <span style={{ textAlign: 'right', color: COLORS.orange }}>{a.max_iterations || 0}</span>
                            <span style={{ textAlign: 'right', color: COLORS.rose }}>{a.errors || 0}</span>
                            <span style={{ textAlign: 'right', color: COLORS.cyan }}>{a.aborted || 0}</span>
                        </div>
                    ))}
                </Card>
            )}

            {/* Detail table */}
            <TerminationsPageCard search={search} setSearch={setSearch} t={t} filterType={filterType} setFilterType={setFilterType} filterAgent={filterAgent} setFilterAgent={setFilterAgent} agentOptions={agentOptions} filtered={filtered} expanded={expanded} setExpanded={setExpanded} />
        </div>
    );
}

function TerminationsPageCard({ search, setSearch, t, filterType, setFilterType, filterAgent, setFilterAgent, agentOptions, filtered, expanded, setExpanded }: { search: string; setSearch: Dispatch<SetStateAction<string>>; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; filterType: string; setFilterType: Dispatch<SetStateAction<string>>; filterAgent: string; setFilterAgent: Dispatch<SetStateAction<string>>; agentOptions: { id: string; name: string; }[]; filtered: TerminationRow[]; expanded: string | number | null; setExpanded: Dispatch<SetStateAction<string | number | null>>; }) {
    return <Card>
        {/* Filter row */}
        <div className="[display:flex] [gap:8px] [margin-bottom:14px] [flex-wrap:wrap] [align-items:center]">
            <div className="[display:flex] [align-items:center] [gap:6px] [padding:5px_10px] [border-radius:8px] [background:var(--bg-primary,#0f0f1a)] [border:1px_solid_var(--border-default,rgba(255,255,255,0.08))] [flex:0_1_220px]">
                <Search className="w-[12px] h-[12px] [color:var(--text-muted,#888)]" />
                <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder={t('admin_monitoring.term_search', 'Search agent / model / error...')}
                    className="[background:transparent] [border:none] [outline:none] [font-size:12px] [color:var(--text-primary,#fff)] w-[100%]" />
            </div>
            <div style={filterSelectWrapper}>
                <Filter className="w-[12px] h-[12px] [color:var(--text-muted,#888)]" />
                <select value={filterType} onChange={e => setFilterType(e.target.value)} style={filterSelectStyle}>
                    <option value="">{t('admin_monitoring.term_all_types', 'All types')}</option>
                    {TYPE_ORDER.map(ty => <option key={ty} value={ty}>{typeLabel(t, ty)}</option>)}
                </select>
            </div>
            <div style={filterSelectWrapper}>
                <Bot className="w-[12px] h-[12px] [color:var(--text-muted,#888)]" />
                <select value={filterAgent} onChange={e => setFilterAgent(e.target.value)} style={filterSelectStyle}>
                    <option value="">{t('admin_monitoring.term_all_agents', 'All agents')}</option>
                    {agentOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
            </div>
            <div className="[flex:1]" />
            <span className="[font-size:11px] [color:var(--text-muted,#888)]">
                {filtered.length === 1 ? t('admin_monitoring.term_event_one', '{n} event', { n: filtered.length }) : t('admin_monitoring.term_event_other', '{n} events', { n: filtered.length })}
            </span>
        </div>

        {/* Table header */}
        <div className="[display:grid] [grid-template-columns:110px_1fr_1fr_130px_100px_60px_70px_70px_24px] [gap:8px] [padding:8px] [font-size:10px] [font-weight:700] [text-transform:uppercase] [letter-spacing:0.05em] [color:var(--text-muted,#666)]">
            <span>{t('admin_monitoring.col_time', 'Time')}</span>
            <span>{t('admin_monitoring.col_agent', 'Agent')}</span>
            <span>{t('admin_monitoring.col_model', 'Model')}</span>
            <span>{t('admin_monitoring.col_type', 'Type')}</span>
            <span>{t('admin_monitoring.term_col_error_code', 'Error code')}</span>
            <span className="[text-align:right]">{t('admin_monitoring.term_col_iter', 'Iter.')}</span>
            <span className="[text-align:right]">{t('admin_monitoring.term_col_duration', 'Duration')}</span>
            <span className="[text-align:right]">{t('admin_monitoring.col_tokens', 'Tokens')}</span>
            <span></span>
        </div>

        {filtered.length === 0 && <Empty text="No terminations match the filters" />}

        {filtered.map(r => {
            const isOpen = expanded === r.id;
            const meta: Partial<TypeMeta> = TYPE_META[r.termination_type] || {};
            return (
                <div key={r.id}>
                    <div
                        onClick={() => setExpanded(isOpen ? null : r.id)}
                        className="[display:grid] [grid-template-columns:110px_1fr_1fr_130px_100px_60px_70px_70px_24px] [gap:8px] [padding:10px_8px] [border-top:1px_solid_var(--border-default,rgba(255,255,255,0.06))] [font-size:12px] [color:var(--text-primary,#fff)] [align-items:center] [cursor:pointer]"
                    >
                        <span className="[color:var(--text-muted,#888)] [font-size:11px]">{fmtTime(r.timestamp)}</span>
                        <span className="[overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                            {r.agent_name || r.agent_id || <span className="[color:var(--text-muted,#666)]">—</span>}
                        </span>
                        <span className="[overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap] [color:var(--text-muted,#aaa)]">
                            {shortModel(r.model)}
                        </span>
                        <span className="[display:flex] [align-items:center] [flex-wrap:wrap]">
                            <TypeBadge type={r.termination_type} />
                            {isLargeInput(r) && <LargeInputBadge />}
                        </span>
                        <span style={{ fontSize: 11, color: r.error_code ? COLORS.rose : 'var(--text-muted, #666)' }}>
                            {r.error_code || '—'}
                        </span>
                        <span className="[text-align:right] [color:var(--text-muted,#aaa)]">{r.iteration_count || 0}</span>
                        <span className="[text-align:right] [color:var(--text-muted,#aaa)]">{fmtDuration(r.duration_ms)}</span>
                        <span className="[text-align:right] [color:var(--text-muted,#aaa)] [display:inline-flex] [align-items:center] [justify-content:flex-end] [gap:4px]">
                            {r.attachment_count > 0 && (
                                <Paperclip
                                    style={{ width: 11, height: 11, color: COLORS.amber }}
                                >
                                    <title>{`${r.attachment_count} attachment${r.attachment_count !== 1 ? 's' : ''} · ${fmtBytes(r.attachment_bytes || 0)}`}</title>
                                </Paperclip>
                            )}
                            {fmt(r.total_tokens)}
                        </span>
                        <span style={{ color: meta.color || 'var(--text-muted, #666)', textAlign: 'right' }}>
                            {isOpen ? '▾' : '▸'}
                        </span>
                    </div>
                    {isOpen && (
                        <div className="[padding:12px_16px] [background:var(--bg-primary,#0f0f1a)] [font-size:12px] [color:var(--text-muted,#aaa)] [display:flex] [flex-direction:column] [gap:6px] [border-top:1px_solid_var(--border-default,rgba(255,255,255,0.06))]">
                            <DetailRow label="Source" value={r.source} />
                            <DetailRow label={t('admin_monitoring.term_d_conversation', 'Conversation')} value={r.conversation_id} mono />
                            <DetailRow label={t('admin_monitoring.term_d_user', 'User')} value={r.user_id} mono />
                            <DetailRow label={t('admin_monitoring.term_d_org', 'Organization')} value={r.organization_id} mono />
                            <DetailRow label={t('admin_monitoring.term_d_error_class', 'Error class')} value={r.error_class} />
                            <DetailRow label={t('admin_monitoring.term_d_error', 'Error')} value={r.error_first_line} mono />
                            <DetailRow label={t('admin_monitoring.term_d_stack', 'Stack')} value={r.stack_first_line} mono />
                            <DetailRow label={t('admin_monitoring.col_tokens', 'Tokens')} value={(() => {
                                const total = (r.prompt_tokens || 0) + (r.completion_tokens || 0);
                                const ratio = total > 0 ? Math.round((r.prompt_tokens / total) * 100) : 0;
                                return t('admin_monitoring.term_tokens_detail', 'prompt {prompt} · completion {completion} · total {total}', { prompt: fmt(r.prompt_tokens), completion: fmt(r.completion_tokens), total: fmt(r.total_tokens) }) + (total > 0 ? ' ' + t('admin_monitoring.term_tokens_ratio', '(prompt {ratio}%)', { ratio }) : '');
                            })()} />
                            <DetailRow
                                label={t('admin_monitoring.term_d_attachments', 'Attachments')}
                                value={r.attachment_count > 0
                                    ? t('admin_monitoring.term_files_detail', '{n} files · {size}', { n: r.attachment_count, size: fmtBytes(r.attachment_bytes || 0) })
                                    : null} />
                            {isLargeInput(r) && (
                                <div style={{
                                    marginTop: 6, padding: '8px 10px', borderRadius: 8,
                                    background: COLORS.amber + '12', border: `1px solid ${COLORS.amber}30`,
                                    fontSize: 11, color: COLORS.amber, display: 'flex', gap: 6, alignItems: 'flex-start',
                                }}>
                                    <FileWarning className="w-[12px] h-[12px] [margin-top:1px] [flex-shrink:0]" />
                                    <span>
                                        <strong>{t('admin_monitoring.term_likely_large', 'Likely caused by large input.')}</strong>{' '}
                                        {r.attachment_bytes >= LARGE_ATTACHMENT_BYTES_THRESHOLD
                                            ? t('admin_monitoring.term_hint_attachment', 'An attachment of {size} was sent; ', { size: fmtBytes(r.attachment_bytes) })
                                            : ''}
                                        {r.prompt_tokens >= LARGE_INPUT_TOKEN_THRESHOLD
                                            ? t('admin_monitoring.term_hint_prompt', 'the prompt was {n} tokens; ', { n: fmt(r.prompt_tokens) })
                                            : ''}
                                        {t('admin_monitoring.term_hint_smaller', 'Suggest a smaller context or split the upload.')}
                                    </span>
                                </div>
                            )}
                            <div className="[margin-top:4px] [font-size:10px] [color:var(--text-muted,#666)] [font-style:italic]">
                                {t('admin_monitoring.term_privacy_note', 'Privacy: messages are not logged. Only sanitised metadata is visible here.')}
                            </div>
                        </div>
                    )}
                </div>
            );
        })}
    </Card>;
}

function DetailRow({ label, value, mono }: DetailRowProps) {
    return (
        <div className="[display:flex] [gap:12px] [align-items:baseline]">
            <span className="min-w-[110px] [font-size:11px] [color:var(--text-muted,#666)] [text-transform:uppercase] [letter-spacing:0.04em]">{label}</span>
            <span style={{
                fontFamily: mono ? 'var(--font-mono, ui-monospace, monospace)' : 'inherit',
                wordBreak: 'break-all', flex: 1,
                color: value ? 'var(--text-primary, #fff)' : 'var(--text-muted, #666)',
            }}>
                {value || '—'}
            </span>
        </div>
    );
}

