import { useState, useMemo, type CSSProperties } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import {
    Search, ChevronRight, Cpu, Activity
} from 'lucide-react';
import {
    fmt, fmtCost, fmtDuration, fmtTime, shortModel, COLORS, 
    Card, Empty, getSourceDetails, type UsageRecord,
} from './shared';
import type { ModelRate } from './drawer/drawerTypes';

const PAGE_SIZE = 25;

interface ActivityPageProps {
    recent: UsageRecord[];
    modelCosts: Record<string, ModelRate>;
    filterSources: string[];
    filterModels: string[];
}

export function ActivityPage({ recent, modelCosts, filterSources, filterModels }: ActivityPageProps) {
    const { t } = useTranslation();
    const [search, setSearch] = useState('');
    const [filterSource, setFilterSource] = useState('');
    const [filterModel, setFilterModel] = useState('');
    const [pageNum, setPageNum] = useState(0);
    const [expanded, setExpanded] = useState<string | number | null>(null);

    const filtered = useMemo(() => {
        let data = recent;
        if (filterSource) data = data.filter((r) => r.source === filterSource);
        if (filterModel) data = data.filter((r) => r.model === filterModel);
        if (search) {
            const q = search.toLowerCase();
            data = data.filter((r) =>
                r.source?.toLowerCase().includes(q) ||
                r.model?.toLowerCase().includes(q) ||
                r.agent_name?.toLowerCase().includes(q) ||
                r.type?.toLowerCase().includes(q)
            );
        }
        return data;
    }, [recent, filterSource, filterModel, search]);

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const paged = filtered.slice(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE);

    const sourceOptions = useMemo(() => {
        const set = new Set(recent.map(r => r.source).filter(Boolean));
        return Array.from(set).sort();
    }, [recent]);

    const modelOptions = useMemo(() => {
        const set = new Set(recent.map(r => r.model).filter(Boolean));
        return Array.from(set).sort();
    }, [recent]);

    return (
        <div className="[animation:fadeIn_0.3s_ease]">
            <Card>
                {/* Filter row */}
                <div className="[display:flex] [gap:8px] [margin-bottom:14px] [flex-wrap:wrap] [align-items:center]">
                    {/* Search */}
                    <div className="[display:flex] [align-items:center] [gap:6px] [padding:5px_10px] [border-radius:8px] [background:var(--bg-primary,#0f0f1a)] [border:1px_solid_var(--border-default,rgba(255,255,255,0.08))] [flex:0_1_200px]">
                        <Search className="w-[12px] h-[12px] [color:var(--text-muted,#888)]" />
                        <input
                            value={search}
                            onChange={e => { setSearch(e.target.value); setPageNum(0); }}
                            placeholder={t('admin_monitoring.activity_search', 'Search calls...')}
                            className="[background:transparent] [border:none] [outline:none] [font-size:12px] [color:var(--text-primary,#fff)] w-[100%]"
                        />
                    </div>

                    {/* Source filter */}
                    <div style={filterSelectWrapper}>
                        <Activity className="w-[12px] h-[12px] [color:var(--text-muted,#888)]" />
                        <select
                            value={filterSource}
                            onChange={e => { setFilterSource(e.target.value); setPageNum(0); }}
                            style={filterSelectStyle}
                        >
                            <option value="">{t('admin_monitoring.all_sources', 'All Sources')}</option>
                            {sourceOptions.map(s => <option key={s} value={s}>{getSourceDetails(s).label}</option>)}
                        </select>
                    </div>

                    {/* Model filter */}
                    <div style={filterSelectWrapper}>
                        <Cpu className="w-[12px] h-[12px] [color:var(--text-muted,#888)]" />
                        <select
                            value={filterModel}
                            onChange={e => { setFilterModel(e.target.value); setPageNum(0); }}
                            style={filterSelectStyle}
                        >
                            <option value="">{t('admin_monitoring.all_models', 'All Models')}</option>
                            {modelOptions.map(m => <option key={m} value={m}>{shortModel(m)}</option>)}
                        </select>
                    </div>

                    <div className="[flex:1]" />
                    <span className="[font-size:11px] [color:var(--text-muted,#888)]">
                        {filtered.length === 1 ? t('admin_monitoring.activity_count_one', '{n} call', { n: filtered.length }) : t('admin_monitoring.activity_count_other', '{n} calls', { n: filtered.length })}
                    </span>
                </div>

                {/* Table Header */}
                <div className="[display:grid] [grid-template-columns:110px_1fr_1fr_70px_80px_90px_70px_24px] [gap:8px] [padding:8px_8px] [margin-bottom:2px] [font-size:10px] [font-weight:700] [text-transform:uppercase] [letter-spacing:0.05em] [color:var(--text-muted,#666)]">
                    <span>{t('admin_monitoring.col_time', 'Time')}</span>
                    <span>{t('admin_monitoring.col_source_agent', 'Source / Agent')}</span>
                    <span>{t('admin_monitoring.col_model', 'Model')}</span>
                    <span className="[text-align:right]">{t('admin_monitoring.col_tokens', 'Tokens')}</span>
                    <span className="[text-align:right]">{t('admin_monitoring.col_latency', 'Latency')}</span>
                    <span className="[text-align:right]">{t('admin_monitoring.col_cost', 'Cost')}</span>
                    <span className="[text-align:right]">{t('admin_monitoring.col_type', 'Type')}</span>
                    <span></span>
                </div>

                {/* Rows */}
                {paged.length === 0 ? <Empty text={t('admin_monitoring.activity_empty', 'No API calls found')} /> : paged.map((r, i) => {
                    const isExpanded = expanded === (r.id || i);
                    const src = getSourceDetails(r.source);

                    return (
                        <div key={r.id || i}>
                            <div
                                onClick={() => setExpanded(isExpanded ? null : (r.id || i))}
                                className={`[display:grid] [grid-template-columns:110px_1fr_1fr_70px_80px_90px_70px_24px] [gap:8px] [padding:8px_8px] [align-items:center] [border-radius:6px] [cursor:pointer] [transition:background_0.12s] ${i % 2 === 0 ? '[background:transparent]' : '[background:var(--bg-tertiary,_rgba(255,255,255,0.02))]'}`}
                                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary, rgba(255,255,255,0.05))'}
                                onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'var(--bg-tertiary, rgba(255,255,255,0.02))'}
                            >
                                <span className="[font-size:11px] [color:var(--text-muted,#888)]">
                                    {fmtTime(r.created_at)}
                                </span>
                                <div className="[overflow:hidden]">
                                    <div className="[display:flex] [align-items:center] [gap:5px]">
                                        <src.icon style={{ width: 12, height: 12, color: src.color, flexShrink: 0 }} />
                                        <span className="[font-size:12px] [font-weight:600] [color:var(--text-primary,#fff)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                                            {r.agent_name || src.label}
                                        </span>
                                    </div>
                                </div>
                                <span style={{ fontSize: '11px', fontWeight: 600, color: COLORS.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {shortModel(r.model)}
                                </span>
                                <span style={{ fontSize: '12px', fontWeight: 600, color: COLORS.green, textAlign: 'right' }}>
                                    {fmt(r.total_tokens)}
                                </span>
                                <span className="[font-size:11px] [color:var(--text-muted,#888)] [text-align:right]">
                                    {fmtDuration(r.duration_ms)}
                                </span>
                                <span style={{ fontSize: '12px', fontWeight: 600, color: COLORS.amber, textAlign: 'right' }}>
                                    {fmtCost(r.estimated_cost || 0)}
                                </span>
                                <span style={{
                                    fontSize: '10px', fontWeight: 600, textAlign: 'right',
                                    padding: '2px 6px', borderRadius: '4px',
                                    background: r.type === 'chat' ? COLORS.primary + '15' : COLORS.amber + '15',
                                    color: r.type === 'chat' ? COLORS.primary : COLORS.amber,
                                }}>
                                    {r.type || '—'}
                                </span>
                                <ChevronRight className={`[width:13px] [height:13px] [color:var(--text-muted,_#888)] [transition:transform_0.2s] ${isExpanded ? '[transform:rotate(90deg)]' : '[transform:none]'}`} />
                            </div>

                            {/* Expanded detail */}
                            {isExpanded && (
                                <div className="[padding:8px_16px_12px_32px] [display:grid] [grid-template-columns:1fr_1fr_1fr] [gap:10px] [background:var(--bg-tertiary,rgba(255,255,255,0.02))] [border-radius:0_0_8px_8px] [margin-bottom:4px] [font-size:11px]">
                                    <DetailItem label={t('admin_monitoring.activity_detail_prompt_tokens', 'Prompt Tokens')} value={fmt(r.prompt_tokens)} color={COLORS.blue} />
                                    <DetailItem label={t('admin_monitoring.activity_detail_completion_tokens', 'Completion Tokens')} value={fmt(r.completion_tokens)} color={COLORS.amber} />
                                    <DetailItem label={t('admin_monitoring.activity_detail_total_tokens', 'Total Tokens')} value={fmt(r.total_tokens)} color={COLORS.green} />
                                    <DetailItem label={t('admin_monitoring.activity_detail_input_cost', 'Input Cost')} value={fmtCost(r.input_cost || 0)} color={COLORS.blue} />
                                    <DetailItem label={t('admin_monitoring.activity_detail_output_cost', 'Output Cost')} value={fmtCost(r.output_cost || 0)} color={COLORS.amber} />
                                    <DetailItem label={t('admin_monitoring.activity_detail_total_cost', 'Total Cost')} value={fmtCost(r.estimated_cost || 0)} color={COLORS.green} />
                                    <DetailItem label={t('admin_monitoring.activity_detail_source', 'Source')} value={src.label} />
                                    <DetailItem label={t('admin_monitoring.col_model', 'Model')} value={r.model || 'Unknown'} />
                                    {r.conversation_id && <DetailItem label={t('admin_monitoring.activity_detail_conversation', 'Conversation')} value={r.conversation_id.slice(0, 12) + '…'} />}
                                    {r.user_id && <DetailItem label={t('admin_monitoring.activity_detail_user', 'User')} value={r.display_name || r.user_id} />}
                                </div>
                            )}
                        </div>
                    );
                })}

                {/* Pagination */}
                {totalPages > 1 && (
                    <div className="[display:flex] [justify-content:center] [gap:6px] [margin-top:14px] [align-items:center]">
                        <button onClick={() => setPageNum(p => Math.max(0, p - 1))} disabled={pageNum === 0} style={paginationBtn}>←</button>
                        <span className="[font-size:12px] [color:var(--text-muted,#888)] [padding:0_8px]">
                            {pageNum + 1} / {totalPages}
                        </span>
                        <button onClick={() => setPageNum(p => Math.min(totalPages - 1, p + 1))} disabled={pageNum >= totalPages - 1} style={paginationBtn}>→</button>
                    </div>
                )}
            </Card>
        </div>
    );
}

interface DetailItemProps {
    label: string;
    value: string;
    color?: string;
}

function DetailItem({ label, value, color }: DetailItemProps) {
    return (
        <div>
            <div className="[font-size:10px] [font-weight:600] [color:var(--text-muted,#888)] [text-transform:uppercase] [letter-spacing:0.04em] [margin-bottom:2px]">{label}</div>
            <div style={{ fontSize: '12px', fontWeight: 600, color: color || 'var(--text-primary, #fff)', wordBreak: 'break-all' }}>{value}</div>
        </div>
    );
}

const filterSelectWrapper: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 10px',
    borderRadius: '8px', background: 'var(--bg-primary, #0f0f1a)',
    border: '1px solid var(--border-default, rgba(255,255,255,0.08))',
};

const filterSelectStyle: CSSProperties = {
    background: 'transparent', border: 'none', outline: 'none',
    fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary, #aaa)',
    cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none',
};

const paginationBtn: CSSProperties = {
    padding: '5px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
    border: '1px solid var(--border-default, rgba(255,255,255,0.1))',
    background: 'var(--bg-secondary, #1a1a2e)', color: 'var(--text-secondary, #aaa)',
    cursor: 'pointer',
};
