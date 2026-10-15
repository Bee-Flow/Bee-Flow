import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import {
    Activity, BarChart3, RefreshCw, DollarSign, Bot,
    ChevronRight, MessageSquare, ThumbsUp, Clock, Calendar, AlertTriangle
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { COLORS, rowCost } from './shared';
import type { ChartRow } from './shared';
import type { DrawerDetail, ModelRate, UsageRow } from './drawer/drawerTypes';
import type { FeedbackItem, FeedbackSummary } from './feedback/feedbackModel';
import { styles } from './index.styles';
import type { MonitoringPanelProps, PageDef, UsageSummary } from './index.types';
import { OverviewPage } from './OverviewPage';
import { UsageExplorerPage } from './UsageExplorerPage';
import { FeedbackPage } from './FeedbackPage';
import { ActivityPage } from './ActivityPage';
import { TerminationsPage } from './TerminationsPage';
import { DetailDrawer } from './DetailDrawer';
import { authFetch } from '../../../utils/helpers';
import { monitoringUrl } from './monitoringUrl';

const API = (import.meta.env.VITE_API_URL || '') + '/api/usage';
const AI_API = (import.meta.env.VITE_API_URL || '') + '/ai';
const FEEDBACK_API = (import.meta.env.VITE_API_URL || '') + '/api/feedback';
// authFetch, not raw fetch. Both send credentials, but authFetch also sets the
// no-store handling that exists because the Nextcloud proxy path was replaying
// stale per-user API responses from the browser cache — and usage figures are
// exactly that kind of per-org, always-changing response. It is also the seam
// the public demo transport hooks, so a raw fetch here silently bypasses it.

const RANGES = [
    { id: 'today', labelKey: 'admin.mon_today' },
    { id: '7d', labelKey: 'admin.mon_7d' },
    { id: '30d', labelKey: 'admin.mon_30d' },
    { id: 'all', labelKey: 'admin.mon_all_time' },
    { id: 'custom', labelKey: 'admin_monitoring.range_custom', label: 'Custom' },
];

function rangeToFilter(rangeId: string, customStart: string, customEnd: string): Record<string, string> {
    if (rangeId === 'all') return {};
    if (rangeId === 'custom') {
        if (!customStart || !customEnd) return {};
        return { startDate: new Date(customStart).toISOString(), endDate: new Date(customEnd).toISOString() };
    }
    const now = new Date();
    let start;
    if (rangeId === 'today') {
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (rangeId === '7d') {
        start = new Date(now.getTime() - 7 * 86400000);
    } else {
        start = new Date(now.getTime() - 30 * 86400000);
    }
    return { startDate: start.toISOString(), endDate: now.toISOString() };
}

// Previous period: same duration ending where current starts
function prevPeriodFilter(rangeId: string, customStart: string, customEnd: string): { startDate: string; endDate: string } | null {
    if (rangeId === 'all') return null;
    const now = new Date();
    let start: Date, end: Date;
    if (rangeId === 'custom') {
        if (!customStart || !customEnd) return null;
        const s = new Date(customStart), e = new Date(customEnd);
        const dur = e.getTime() - s.getTime();
        if (dur <= 0) return null;
        end = s;
        start = new Date(s.getTime() - dur);
    } else if (rangeId === 'today') {
        end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        start = new Date(end.getTime() - 86400000);
    } else if (rangeId === '7d') {
        end = new Date(now.getTime() - 7 * 86400000);
        start = new Date(end.getTime() - 7 * 86400000);
    } else {
        end = new Date(now.getTime() - 30 * 86400000);
        start = new Date(end.getTime() - 30 * 86400000);
    }
    return { startDate: start.toISOString(), endDate: end.toISOString() };
}

// Decide chart interval based on the date span
function autoInterval(rangeId: string, customStart: string, customEnd: string): string {
    if (rangeId === 'today') return 'hour';
    if (rangeId === 'custom' && customStart && customEnd) {
        const diffMs = new Date(customEnd).getTime() - new Date(customStart).getTime();
        if (diffMs <= 86400000) return 'hour'; // ≤ 1 day
        return 'day';
    }
    return 'day';
}

// Format a datetime-local string from a Date
function toLocalInput(date: Date | string | number): string {
    const d = new Date(date);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const PAGES: PageDef[] = [
    { id: 'overview', labelKey: 'admin.mon_overview', icon: BarChart3, descriptionKey: 'admin_monitoring.desc_overview', description: 'Dashboard & cost overview' },
    { id: 'usage', labelKey: 'admin.mon_usage_explorer', icon: Activity, descriptionKey: 'admin_monitoring.desc_usage', description: 'Explore models, agents, users & conversations' },
    { id: 'feedback', labelKey: 'admin.mon_feedback', icon: ThumbsUp, descriptionKey: 'admin_monitoring.desc_feedback', description: 'User feedback on AI responses' },
    { id: 'activity', labelKey: 'admin.mon_activity', icon: Clock, descriptionKey: 'admin_monitoring.desc_activity', description: 'Recent API call log' },
    { id: 'terminations', labelKey: 'admin.mon_terminations', icon: AlertTriangle, descriptionKey: 'admin_monitoring.desc_terminations', description: 'Prematurely ended tasks & errors' },
];

async function fetchJson<T>(url: string): Promise<T | null> {
    try {
        const r = await authFetch(url);
        if (!r.ok) return null;
        return await r.json() as T;
    } catch { return null; }
}

export default function MonitoringPanel({ activeSection = '', onNavigate }: MonitoringPanelProps) {
    const { t } = useTranslation();

    const VALID_IDS = PAGES.map(p => p.id);
    const page = VALID_IDS.includes(activeSection) ? activeSection : 'overview';
    const [range, setRange] = useState<string>('7d');
    const [customStart, setCustomStart] = useState(() => {
        const d = new Date(); d.setDate(d.getDate() - 7); d.setHours(0, 0, 0, 0); return toLocalInput(d);
    });
    const [customEnd, setCustomEnd] = useState(() => toLocalInput(new Date()));
    const [loading, setLoading] = useState(true);
    const [detailDrawer, setDetailDrawer] = useState<DrawerDetail | null>(null);

    // ── Data stores ──
    const [summary, setSummary] = useState<UsageSummary | null>(null);
    const [prevSummary, setPrevSummary] = useState<UsageSummary | null>(null);
    const [byModel, setByModel] = useState<UsageRow[]>([]);
    const [byAgent, setByAgent] = useState<UsageRow[]>([]);
    const [byUser, setByUser] = useState<UsageRow[]>([]);
    const [timeline, setTimeline] = useState<ChartRow[]>([]);
    const [costTimeline, setCostTimeline] = useState<ChartRow[]>([]);
    const [tools, setTools] = useState<UsageRow[]>([]);
    const [recent, setRecent] = useState<UsageRow[]>([]);
    const [modelCosts, setModelCosts] = useState<Record<string, ModelRate>>({});
    const [byConversation, setByConversation] = useState<UsageRow[]>([]);
    const [filterSources, setFilterSources] = useState<string[]>([]);
    const [filterModels, setFilterModels] = useState<string[]>([]);
    const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
    const [feedbackSummary, setFeedbackSummary] = useState<FeedbackSummary>({ total: 0, thumbs_up: 0, thumbs_down: 0, with_comments: 0 });

    const fetchData = useCallback(async () => {
        setLoading(true);
        const filters = rangeToFilter(range, customStart, customEnd);
        const qs = new URLSearchParams(filters).toString();
        const q = qs ? '?' + qs : '';
        const interval = autoInterval(range, customStart, customEnd);

        try {
            // Core data (always needed)
            const [s, m, a, u, tl, ct, mc, t, r, fs, fm, bc] = await Promise.all([
                fetchJson<UsageSummary>(`${API}/summary${q}`),
                fetchJson<UsageRow[]>(`${API}/by-model${q}`),
                fetchJson<UsageRow[]>(`${API}/by-agent${q}`),
                fetchJson<UsageRow[]>(`${API}/by-user${q}`),
                fetchJson<ChartRow[]>(monitoringUrl(`${API}/timeline`, { ...filters, interval })),
                fetchJson<ChartRow[]>(monitoringUrl(`${API}/cost-timeline`, { ...filters, interval })),
                fetchJson<Record<string, ModelRate>>(`${AI_API}/model-costs`),
                fetchJson<UsageRow[]>(`${API}/tools${q}`),
                fetchJson<UsageRow[]>(`${API}/recent?limit=100`),
                fetchJson<string[]>(`${API}/filters/sources`),
                fetchJson<string[]>(`${API}/filters/models`),
                fetchJson<UsageRow[]>(`${API}/by-conversation${q}`),
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
                const ps = await fetchJson<UsageSummary>(`${API}/summary?${prevQs}`);
                setPrevSummary(ps);
            } else {
                setPrevSummary(null);
            }

            // Feedback
            try {
                const fbQs = qs ? '?' + qs : '';
                const [fbData, fbSum] = await Promise.all([
                    fetchJson<FeedbackItem[]>(`${FEEDBACK_API}${fbQs}`),
                    fetchJson<FeedbackSummary>(`${FEEDBACK_API}/summary${fbQs}`),
                ]);
                setFeedback(Array.isArray(fbData) ? fbData : []);
                setFeedbackSummary(fbSum || { total: 0, thumbs_up: 0, thumbs_down: 0, with_comments: 0 });
            } catch { /* ignore */ }
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
        const c = modelCosts[m.model as string];
        if (!c) return sum;
        return sum + rowCost(m, c);
    }, 0), [byModel, modelCosts]);

    const costPerModel = useMemo(() => {
        const map: Record<string, number> = {};
        byModel.forEach(m => {
            const c = modelCosts[m.model as string];
            if (c) map[m.model as string] = rowCost(m, c);
        });
        return map;
    }, [byModel, modelCosts]);

    // Deltas
    const deltas = useMemo<Record<string, number | null | undefined>>(() => {
        if (!prevSummary || !summary) return {};
        const calc = (curr: number, prev: number): number | null => prev > 0 ? ((curr - prev) / prev) * 100 : null;
        return {
            calls: calc(summary.total_calls || 0, prevSummary.total_calls || 0),
            tokens: calc(summary.total_tokens || 0, prevSummary.total_tokens || 0),
            cost: calc(summary.total_estimated_cost || 0, prevSummary.total_estimated_cost || 0),
            latency: calc(summary.avg_duration_ms || 0, prevSummary.avg_duration_ms || 0),
        };
    }, [summary, prevSummary]);

    const deltaLabel = range === 'today' ? 'vs yesterday' : range === '7d' ? 'vs prev 7d' : range === '30d' ? 'vs prev 30d' : range === 'custom' ? 'vs prev period' : '';

    return (
        <div style={styles.container}>
            {/* ── Sidebar ── */}
            <div style={styles.sidebar}>
                <div style={styles.sidebarHeader}>
                    <Activity style={{ width: 20, height: 20, color: COLORS.primary }} />
                    <span style={styles.sidebarTitle}>{t('admin_monitoring.title', 'AI Monitor')}</span>
                </div>

                <nav style={styles.nav}>
                    {PAGES.map(p => (
                        <button
                            key={p.id}
                            onClick={() => { if (onNavigate) onNavigate(`admin/monitoring/${p.id}`); }}
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
                            <div style={{ flex: 1, textAlign: 'left' }}>
                                <div style={{
                                    fontSize: '13px', fontWeight: page === p.id ? 600 : 500,
                                    color: page === p.id ? 'var(--text-primary, #fff)' : 'var(--text-secondary, #aaa)',
                                }}>{t(p.labelKey)}</div>
                            </div>
                            {page === p.id && <ChevronRight style={{ width: 14, height: 14, color: COLORS.primary, flexShrink: 0 }} />}
                        </button>
                    ))}
                </nav>
            </div>

            {/* ── Main Content ── */}
            <div style={styles.main}>
                {/* Top bar */}
                <div style={styles.topBar}>
                    <div>
                        <h2 style={styles.pageTitle}>
                            {t(PAGES.find(p => p.id === page)?.labelKey ?? '')}
                        </h2>
                        <p style={styles.pageDesc}>
                            {t(PAGES.find(p => p.id === page)?.descriptionKey ?? '', PAGES.find(p => p.id === page)?.description)}
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
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
                                    {r.id === 'custom' && <Calendar style={{ width: 12, height: 12 }} />}
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
                                <span style={{ color: 'var(--text-muted, #666)', fontSize: '12px', padding: '0 2px' }}>→</span>
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
                        <button onClick={fetchData} style={styles.refreshBtn} title={t('admin_monitoring.refresh', 'Refresh')}>
                            <RefreshCw style={{ width: 15, height: 15, animation: loading ? 'spin 1s linear infinite' : 'none' }} />
                        </button>
                    </div>
                </div>

                {/* Page Content */}
                <div style={styles.content}>
                    {page === 'overview' && (
                        <OverviewPage
                            summary={summary} prevSummary={prevSummary} deltas={deltas} deltaLabel={deltaLabel}
                            byModel={byModel} byAgent={byAgent} timeline={timeline}
                            costTimeline={costTimeline} tools={tools} totalCost={totalCost}
                            costPerModel={costPerModel} modelCosts={modelCosts} range={range}
                            onSelectModel={(m: UsageRow) => setDetailDrawer({ type: 'model', data: m })}
                            onSelectAgent={(a: UsageRow) => setDetailDrawer({ type: 'agent', data: a })}
                            onNavigate={onNavigate}
                        />
                    )}
                    {page === 'usage' && (
                        <UsageExplorerPage
                            byModel={byModel} byAgent={byAgent} byUser={byUser}
                            byConversation={byConversation} costPerModel={costPerModel}
                            modelCosts={modelCosts}
                            onSelectModel={(m: UsageRow) => setDetailDrawer({ type: 'model', data: m })}
                            onSelectAgent={(a: UsageRow) => setDetailDrawer({ type: 'agent', data: a })}
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
                            refreshKey={undefined}
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
