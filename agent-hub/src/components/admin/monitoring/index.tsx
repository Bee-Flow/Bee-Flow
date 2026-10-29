import { useState, useEffect, useCallback, useMemo } from 'react';
import { TranslateParams, useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { Activity, RefreshCw, ChevronRight, Calendar } from 'lucide-react';
import { rowCost, type AgentUsage, type ChartPoint, type ModelUsage, type ToolUsage, type UsageRecord, type UsageSummary, type UserUsage } from './shared';
import { COLORS } from './shared/SvgAreaChart';
import { OverviewPage, type UsageDeltas } from './OverviewPage';
import { UsageExplorerPage } from './UsageExplorerPage';
import { FeedbackPage } from './FeedbackPage';
import { ActivityPage } from './ActivityPage';
import { TerminationsPage } from './TerminationsPage';
import { DetailDrawer } from './DetailDrawer';
import { monitoringUrl } from './monitoringUrl';
import type { DrawerDetail, ModelRate } from './drawer/drawerTypes';
import type { FeedbackItem } from './feedback/feedbackModel';
import type { MonitoringPanelProps } from './index.types';
import { logger } from '@/utils/logger';
import { API, AI_API, FEEDBACK_API, RANGES, PAGES, styles } from './monitoring.constants';
import { rangeToFilter, prevPeriodFilter, autoInterval, toLocalInput, fetchJson } from './monitoring.helpers';

// authFetch, not raw fetch. Both send credentials, but authFetch also sets the
// no-store handling that exists because the Nextcloud proxy path was replaying
// stale per-user API responses from the browser cache — and usage figures are
// exactly that kind of per-org, always-changing response. It is also the seam
// the public demo transport hooks, so a raw fetch here silently bypasses it.

/** Change against the previous period, in percent (null where the previous period had none). */
function usageDeltas(summary: UsageSummary | null, prevSummary: UsageSummary | null): UsageDeltas {
    if (!prevSummary || !summary) return {};
    const calc = (curr: number, prev: number) => prev > 0 ? ((curr - prev) / prev) * 100 : null;
    return {
        calls: calc(summary.total_calls || 0, prevSummary.total_calls || 0),
        tokens: calc(summary.total_tokens || 0, prevSummary.total_tokens || 0),
        cost: calc(summary.total_estimated_cost || 0, prevSummary.total_estimated_cost || 0),
        latency: calc(summary.avg_duration_ms || 0, prevSummary.avg_duration_ms || 0),
    };
}

export default function MonitoringPanel({ activeSection = '', onNavigate }: MonitoringPanelProps) {
    const { t } = useTranslation();
    const VALID_IDS = PAGES.map(p => p.id);
    const page = VALID_IDS.includes(activeSection) ? activeSection : 'overview';
    const [range, setRange] = useState('7d');
    const [customStart, setCustomStart] = useState(() => {
        const d = new Date(); d.setDate(d.getDate() - 7); d.setHours(0, 0, 0, 0); return toLocalInput(d);
    });
    const [customEnd, setCustomEnd] = useState(() => toLocalInput(new Date()));
    const [loading, setLoading] = useState(true);
    const [detailDrawer, setDetailDrawer] = useState<DrawerDetail | null>(null);

    // ── Data stores ──
    const [summary, setSummary] = useState<UsageSummary | null>(null);
    const [prevSummary, setPrevSummary] = useState<UsageSummary | null>(null);
    const [byModel, setByModel] = useState<ModelUsage[]>([]);
    const [byAgent, setByAgent] = useState<AgentUsage[]>([]);
    const [byUser, setByUser] = useState<UserUsage[]>([]);
    const [timeline, setTimeline] = useState<ChartPoint[]>([]);
    const [costTimeline, setCostTimeline] = useState<ChartPoint[]>([]);
    const [tools, setTools] = useState<ToolUsage[]>([]);
    const [recent, setRecent] = useState<UsageRecord[]>([]);
    const [modelCosts, setModelCosts] = useState<Record<string, ModelRate>>({});
    const [byConversation, setByConversation] = useState<UsageRecord[]>([]);
    const [filterSources, setFilterSources] = useState<string[]>([]);
    const [filterModels, setFilterModels] = useState<string[]>([]);
    const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
    const [feedbackSummary, setFeedbackSummary] = useState({ total: 0, thumbs_up: 0, thumbs_down: 0, with_comments: 0 });
    const fetchData = useCallback(async () => {
        setLoading(true);
        const filters = rangeToFilter(range, customStart, customEnd);
        const qs = new URLSearchParams(filters).toString();
        const q = qs ? '?' + qs : '';
        const interval = autoInterval(range, customStart, customEnd);
        try {
            // Core data (always needed)
            const [s, m, a, u, tl, ct, mc, t, r, fs, fm, bc] = await Promise.all([
                fetchJson(`${API}/summary${q}`),
                fetchJson(`${API}/by-model${q}`),
                fetchJson(`${API}/by-agent${q}`),
                fetchJson(`${API}/by-user${q}`),
                fetchJson(monitoringUrl(`${API}/timeline`, { ...filters, interval })),
                fetchJson(monitoringUrl(`${API}/cost-timeline`, { ...filters, interval })),
                fetchJson(`${AI_API}/model-costs`),
                fetchJson(`${API}/tools${q}`),
                fetchJson(`${API}/recent?limit=100`),
                fetchJson(`${API}/filters/sources`),
                fetchJson(`${API}/filters/models`),
                fetchJson(`${API}/by-conversation${q}`),
            ]);

            setSummary(s || { total_calls: 0, total_tokens: 0, total_estimated_cost: 0, total_billed_cost: 0, avg_duration_ms: 0 });
            setByModel(Array.isArray(m) ? m : []);
            setByAgent(Array.isArray(a) ? a : []);
            setByUser(Array.isArray(u) ? u : []);
            setTimeline(Array.isArray(tl) ? tl : []);
            setCostTimeline(Array.isArray(ct) ? ct : []);
            setModelCosts(mc && typeof mc === 'object' ? mc : {});
            setTools(Array.isArray(t) ? t : []);
            setRecent(Array.isArray(r) ? r : []);
            setFilterSources(Array.isArray(fs) ? fs : []);
            setFilterModels(Array.isArray(fm) ? fm : []);
            setByConversation(Array.isArray(bc) ? bc : []);

            // Previous period for delta comparison
            const prevFilter = prevPeriodFilter(range, customStart, customEnd);
            if (prevFilter) {
                const prevQs = new URLSearchParams(prevFilter).toString();
                const ps = await fetchJson(`${API}/summary?${prevQs}`);
                setPrevSummary(ps);
            } else {
                setPrevSummary(null);
            }

            // Feedback
            try {
                const fbQs = qs ? '?' + qs : '';
                const [fbData, fbSum] = await Promise.all([
                    fetchJson(`${FEEDBACK_API}${fbQs}`),
                    fetchJson(`${FEEDBACK_API}/summary${fbQs}`),
                ]);
                setFeedback(Array.isArray(fbData) ? fbData : []);
                setFeedbackSummary(fbSum || { total: 0, thumbs_up: 0, thumbs_down: 0, with_comments: 0 });
            } catch (err) { logger.debug('ignore', err); }
        } catch (e) {
            console.error('[Monitoring] fetch error:', e);
        }
        setLoading(false);
    }, [range, customStart, customEnd]);

    useEffect(() => { fetchData(); }, [fetchData]);
    useEffect(() => {
        const iv = setInterval(fetchData, 60000); // reduced from 30s to 60s
        return () => clearInterval(iv);
    }, [fetchData]);

    // Computed costs per model (cache-aware — see rowCost in shared.jsx)
    const totalCost = useMemo(() => byModel.reduce((sum, m) => {
        const c = modelCosts[m.model];
        if (!c) return sum;
        return sum + rowCost(m, c);
    }, 0), [byModel, modelCosts]);

    const costPerModel = useMemo(() => {
        const map: Record<string, number> = {};
        byModel.forEach(m => {
            const c = modelCosts[m.model];
            if (c) map[m.model] = rowCost(m, c);
        });
        return map;
    }, [byModel, modelCosts]);

    // Deltas
    const deltas = useMemo(() => usageDeltas(summary, prevSummary), [summary, prevSummary]);

    const deltaLabel = range === 'today' ? 'vs yesterday' : range === '7d' ? 'vs prev 7d' : range === '30d' ? 'vs prev 30d' : range === 'custom' ? 'vs prev period' : '';

    return (
        <div style={styles.container}>
            {/* ── Sidebar ── */}
            <MonitoringPanelSection t={t} onNavigate={onNavigate} page={page} />

            {/* ── Main Content ── */}
            <div style={styles.main}>
                {/* Top bar */}
                <div style={styles.topBar}>
                    <div>
                        <h2 style={styles.pageTitle}>
                            {t(PAGES.find(p => p.id === page)?.labelKey)}
                        </h2>
                        <p style={styles.pageDesc}>
                            {t(PAGES.find(p => p.id === page)?.descriptionKey, PAGES.find(p => p.id === page)?.description)}
                        </p>
                    </div>
                    <RangeControls
                        t={t} range={range} setRange={setRange} customStart={customStart} setCustomStart={setCustomStart}
                        customEnd={customEnd} setCustomEnd={setCustomEnd} loading={loading} onRefresh={fetchData}
                    />
                </div>

                {/* Page Content */}
                <div style={styles.content}>
                    {page === 'overview' && (
                        <OverviewPage
                            summary={summary} prevSummary={prevSummary} deltas={deltas} deltaLabel={deltaLabel}
                            byModel={byModel} byAgent={byAgent} timeline={timeline}
                            costTimeline={costTimeline} tools={tools} totalCost={totalCost}
                            costPerModel={costPerModel} modelCosts={modelCosts} range={range}
                            onSelectModel={m => setDetailDrawer({ type: 'model', data: m })}
                            onSelectAgent={a => setDetailDrawer({ type: 'agent', data: a })}
                            onNavigate={onNavigate}
                        />
                    )}
                    {page === 'usage' && (
                        <UsageExplorerPage
                            byModel={byModel} byAgent={byAgent} byUser={byUser}
                            byConversation={byConversation} costPerModel={costPerModel}
                            modelCosts={modelCosts}
                            onSelectModel={m => setDetailDrawer({ type: 'model', data: m })}
                            onSelectAgent={a => setDetailDrawer({ type: 'agent', data: a })}
                        />
                    )}
                    {page === 'feedback' && (
                        <FeedbackPage feedback={feedback} summary={feedbackSummary} />
                    )}
                    {page === 'activity' && (
                        <ActivityPage
                            recent={recent} modelCosts={modelCosts}
                            filterSources={filterSources} filterModels={filterModels}
                        />
                    )}
                    {page === 'terminations' && (
                        <TerminationsPage
                            range={range}
                            customStart={customStart}
                            customEnd={customEnd}
                        />
                    )}
                </div>
            </div>

            {/* Detail Drawer */}
            {detailDrawer && (
                <DetailDrawer detail={detailDrawer} modelCosts={modelCosts} costPerModel={costPerModel}
                    recent={recent} onClose={() => setDetailDrawer(null)} />
            )}

            <style>{`
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes slideIn { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: translateX(0); } }
                @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.15; } }
            `}</style>
        </div>
    );
}


function MonitoringPanelSection({ t, onNavigate, page }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; onNavigate: ((path: string) => void) | undefined; page: string; }) {
    return <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
            <Activity style={{ width: 20, height: 20, color: COLORS.primary }} />
            <span style={styles.sidebarTitle}>{t('admin_monitoring.title', 'AI Monitor')}</span>
        </div>

        <nav style={styles.nav}>
            {PAGES.map(p => (
                <button
                    key={p.id}
                    onClick={() => { if (onNavigate) onNavigate(`admin/monitoring/${p.id}`); } }
                    style={{
                        ...styles.navItem,
                        ...(page === p.id ? styles.navItemActive : {}),
                    }}
                >
                    <p.icon style={{
                        width: 18, height: 18,
                        color: page === p.id ? COLORS.primary : 'var(--text-muted, #666)',
                        flexShrink: 0
                    }} />
                    <div className="[flex:1] [text-align:left]">
                        <div className={`[font-size:13px] ${page === p.id ? '[font-weight:600] [color:var(--text-primary,_#fff)]' : '[font-weight:500] [color:var(--text-secondary,_#aaa)]'}`}>{t(p.labelKey)}</div>
                    </div>
                    {page === p.id && <ChevronRight style={{ width: 14, height: 14, color: COLORS.primary, flexShrink: 0 }} />}
                </button>
            ))}
        </nav>
    </div>;
}

interface RangeControlsProps {
    t: TranslateFn;
    range: string;
    setRange: (range: string) => void;
    customStart: string;
    setCustomStart: (value: string) => void;
    customEnd: string;
    setCustomEnd: (value: string) => void;
    loading: boolean;
    onRefresh: () => void;
}

/** The range chips, the custom from/to pickers, and Refresh. */
function RangeControls({ t, range, setRange, customStart, setCustomStart, customEnd, setCustomEnd, loading, onRefresh }: RangeControlsProps) {
    return (
        <div className="[display:flex] [gap:8px] [align-items:center] [flex-wrap:wrap]">
            <div style={styles.rangeGroup}>
                {RANGES.map(r => (
                    <button
                        key={r.id}
                        onClick={() => setRange(r.id)}
                        style={{
                            ...styles.rangeBtn,
                            ...(range === r.id ? styles.rangeBtnActive : {}),
                            ...(r.id === 'custom' ? { display: 'flex', alignItems: 'center', gap: '5px' } : {}),
                        }}
                    >
                        {r.id === 'custom' && <Calendar className="w-[12px] h-[12px]" />}
                        {r.labelKey ? t(r.labelKey, r.label) : r.label}
                    </button>
                ))}
            </div>
            {range === 'custom' && (
                <div style={styles.datePickerRow}>
                    <div style={styles.datePickerField}>
                        <span style={styles.datePickerLabel}>{t('admin_monitoring.from', 'From')}</span>
                        <input
                            type="datetime-local"
                            value={customStart}
                            onChange={e => setCustomStart(e.target.value)}
                            max={customEnd}
                            style={styles.dateInput}
                        />
                    </div>
                    <span className="[color:var(--text-muted,#666)] [font-size:12px] [padding:0_2px]">→</span>
                    <div style={styles.datePickerField}>
                        <span style={styles.datePickerLabel}>{t('admin_monitoring.to', 'To')}</span>
                        <input
                            type="datetime-local"
                            value={customEnd}
                            onChange={e => setCustomEnd(e.target.value)}
                            min={customStart}
                            style={styles.dateInput}
                        />
                    </div>
                </div>
            )}
            <button onClick={onRefresh} style={styles.refreshBtn} title={t('admin_monitoring.refresh', 'Refresh')}>
                <RefreshCw className={`[width:15px] [height:15px] ${loading ? '[animation:spin_1s_linear_infinite]' : '[animation:none]'}`} />
            </button>
        </div>
    );
}
