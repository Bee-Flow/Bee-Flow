import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '@/utils/logger';
import type { AgentUsage, ChartPoint, ModelUsage, ToolUsage, UsageRecord, UsageSummary, UserUsage } from './shared';
import type { ModelRate } from './drawer/drawerTypes';
import type { FeedbackItem, FeedbackSummary } from './feedback/feedbackModel';
import { monitoringUrl } from './monitoringUrl';
import { API, AI_API, FEEDBACK_API } from './monitoring.constants';
import { rangeToFilter, prevPeriodFilter, autoInterval, fetchJson } from './monitoring.helpers';

// authFetch, not raw fetch (fetchJson goes through api/mutate's request). Both
// send credentials, but authFetch also sets the no-store handling that exists
// because the Nextcloud proxy path was replaying stale per-user API responses
// from the browser cache — and usage figures are exactly that kind of per-org,
// always-changing response. It is also the seam the public demo transport
// hooks, so a raw fetch here silently bypasses it.

const EMPTY_SUMMARY: UsageSummary = { total_calls: 0, total_tokens: 0, total_estimated_cost: 0, total_billed_cost: 0, avg_duration_ms: 0 };
const EMPTY_FEEDBACK: FeedbackSummary = { total: 0, thumbs_up: 0, thumbs_down: 0, with_comments: 0 };

export interface MonitoringData {
    summary: UsageSummary | null;
    prevSummary: UsageSummary | null;
    byModel: ModelUsage[];
    byAgent: AgentUsage[];
    byUser: UserUsage[];
    timeline: ChartPoint[];
    costTimeline: ChartPoint[];
    tools: ToolUsage[];
    recent: UsageRecord[];
    modelCosts: Record<string, ModelRate>;
    byConversation: UsageRecord[];
    filterSources: string[];
    filterModels: string[];
    feedback: FeedbackItem[];
    feedbackSummary: FeedbackSummary;
}

const INITIAL: MonitoringData = {
    summary: null, prevSummary: null, byModel: [], byAgent: [], byUser: [], timeline: [], costTimeline: [],
    tools: [], recent: [], modelCosts: {}, byConversation: [], filterSources: [], filterModels: [],
    feedback: [], feedbackSummary: EMPTY_FEEDBACK,
};

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []);

/**
 * Marks the start of a read and returns "has a newer read started since?".
 * Only the newest read may land: a slow answer for the range that was left
 * must not overwrite the figures of the range that is shown now.
 */
function useLatestOnly() {
    const latest = useRef(0);
    return useCallback(() => {
        const id = ++latest.current;
        return () => latest.current !== id;
    }, []);
}

/** The core figures of a range, all read at once. */
async function readCore(range: string, customStart: string, customEnd: string): Promise<Partial<MonitoringData>> {
    const filters = rangeToFilter(range, customStart, customEnd);
    const qs = new URLSearchParams(filters).toString();
    const q = qs ? '?' + qs : '';
    const interval = autoInterval(range, customStart, customEnd);
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
    return {
        summary: s || EMPTY_SUMMARY,
        byModel: list(m), byAgent: list(a), byUser: list(u), timeline: list(tl), costTimeline: list(ct),
        modelCosts: mc && typeof mc === 'object' ? mc : {},
        tools: list(t), recent: list(r), filterSources: list(fs), filterModels: list(fm), byConversation: list(bc),
    };
}

type SetData = (update: (d: MonitoringData) => MonitoringData) => void;

/** Core figures, then the previous period's summary, then feedback; each step stops once a newer read has started. */
async function readAll(range: string, customStart: string, customEnd: string, superseded: () => boolean, setData: SetData) {
    const qs = new URLSearchParams(rangeToFilter(range, customStart, customEnd)).toString();
    try {
        const core = await readCore(range, customStart, customEnd);
        if (superseded()) return;
        setData(d => ({ ...d, ...core }));

        // Previous period for delta comparison
        const prevFilter = prevPeriodFilter(range, customStart, customEnd);
        const prevSummary = prevFilter ? await fetchJson(`${API}/summary?${new URLSearchParams(prevFilter).toString()}`) : null;
        if (superseded()) return;
        setData(d => ({ ...d, prevSummary }));

        try {
            const fbQs = qs ? '?' + qs : '';
            const [fbData, fbSum] = await Promise.all([
                fetchJson(`${FEEDBACK_API}${fbQs}`),
                fetchJson(`${FEEDBACK_API}/summary${fbQs}`),
            ]);
            if (superseded()) return;
            setData(d => ({ ...d, feedback: list(fbData), feedbackSummary: fbSum || EMPTY_FEEDBACK }));
        } catch (err) { logger.debug('ignore', err); }
    } catch (e) {
        logger.error('[Monitoring] fetch error:', e);
    }
}

/**
 * Everything the AI Monitor shows for a range: read on a range change, every
 * minute, and on `reload()` (the Refresh button). `loading` holds from the
 * start of a read until the newest one has answered; `refreshKey` counts the
 * reloads, for the pages that read on their own (Terminations).
 */
export function useMonitoringData(range: string, customStart: string, customEnd: string) {
    const [data, setData] = useState<MonitoringData>(INITIAL);
    const [refreshKey, setRefreshKey] = useState(0);
    const [settledKey, setSettledKey] = useState<string | null>(null);
    const beginFetch = useLatestOnly();
    const readKey = `${range}|${customStart}|${customEnd}|${refreshKey}`;

    useEffect(() => {
        const superseded = beginFetch();
        readAll(range, customStart, customEnd, superseded, setData).then(() => {
            if (!superseded()) setSettledKey(readKey);
        });
    }, [range, customStart, customEnd, readKey, beginFetch]);

    const reload = useCallback(() => setRefreshKey(k => k + 1), []);
    useEffect(() => {
        const iv = setInterval(reload, 60000);
        return () => clearInterval(iv);
    }, [reload]);

    return { data, loading: settledKey !== readKey, reload, refreshKey };
}
