// The org-wide monitoring reads behind the Settings panels (feedback,
// terminations, academy overview). Each panel keeps showing the last answer
// while a new date range loads (`keepPreviousData`), as the hand-written
// loaders did, and its refresh button is `refetch`.

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import { request, RefusedError } from '../mutate';

const orgReportKeys = {
    all: ['org-reports'] as const,
    feedback: (q: string) => [...orgReportKeys.all, 'feedback', q] as const,
    terminations: (q: string, interval: string) => [...orgReportKeys.all, 'terminations', q, interval] as const,
    academy: () => [...orgReportKeys.all, 'academy'] as const,
};

/** The JSON of an answer, or null when it was refused or unreadable. */
async function jsonOrNull(res: Response): Promise<unknown> {
    try { return res.ok ? await res.json() : null; } catch { return null; }
}

const FEEDBACK_API = `${API_BASE}/api/feedback/org`;

interface FeedbackSummary { total: number; thumbs_up: number; thumbs_down: number; with_comments: number }
const NO_FEEDBACK: FeedbackSummary = { total: 0, thumbs_up: 0, thumbs_down: 0, with_comments: 0 };

/** The date-range filter string of the org reports (`?startDate=..&endDate=..` or none). */
export function feedbackRangeQuery(range: { startDate?: string | null; endDate?: unknown } | undefined): string {
    const filters: Record<string, string> = range?.startDate ? { startDate: range.startDate, endDate: String(range.endDate) } : {};
    const qs = new URLSearchParams(filters).toString();
    return qs ? `?${qs}` : '';
}

/** The org's feedback list and its summary for one range; an unreadable half reads as empty. */
export function useOrgFeedbackQuery<Item>(q: string) {
    return useQuery({
        queryKey: orgReportKeys.feedback(q),
        queryFn: async ({ signal }) => {
            const [listResp, sumResp] = await Promise.all([
                authFetch(`${FEEDBACK_API}${q}`, { signal }),
                authFetch(`${FEEDBACK_API}/summary${q}`, { signal }),
            ]);
            const list = await jsonOrNull(listResp);
            const sum = (await jsonOrNull(sumResp)) as FeedbackSummary | null;
            return { feedback: (Array.isArray(list) ? list : []) as Item[], summary: sum || NO_FEEDBACK };
        },
        placeholderData: keepPreviousData,
    });
}

const TERMINATIONS_API = `${API_BASE}/api/terminations/org`;

export interface TerminationsReport<Summary, Timeline, Row, ByAgent> {
    summary: Summary | null;
    timeline: Timeline[];
    rows: Row[];
    byAgent: ByAgent[];
}

/** Summary, timeline, rows and per-agent split of the agent terminations for one range. */
export function useOrgTerminationsQuery<Summary, Timeline, Row, ByAgent>(q: string, interval: string) {
    return useQuery<TerminationsReport<Summary, Timeline, Row, ByAgent>>({
        queryKey: orgReportKeys.terminations(q, interval),
        queryFn: async ({ signal }) => {
            const intervalQ = `${q ? '&' : '?'}interval=${interval}`;
            const [sumR, tlR, listR, agR] = await Promise.all([
                authFetch(`${TERMINATIONS_API}/summary${q}`, { signal }),
                authFetch(`${TERMINATIONS_API}/timeline${q}${intervalQ}`, { signal }),
                authFetch(`${TERMINATIONS_API}${q}${q ? '&' : '?'}limit=200`, { signal }),
                authFetch(`${TERMINATIONS_API}/by-agent${q}`, { signal }),
            ]);
            const [sum, tl, list, ag] = (await Promise.all([sumR, tlR, listR, agR].map(jsonOrNull))) as [
                Summary | null, { rows?: Timeline[] } | null, { rows?: Row[] } | null, { rows?: ByAgent[] } | null,
            ];
            return { summary: sum, timeline: tl?.rows || [], rows: list?.rows || [], byAgent: ag?.rows || [] };
        },
        placeholderData: keepPreviousData,
    });
}

/** GET /ai/learning/org-overview; a refusal throws `HTTP <status>`. */
export function useOrgAcademyOverviewQuery<T>() {
    return useQuery<T, Error>({
        queryKey: orgReportKeys.academy(),
        queryFn: async ({ signal }) => {
            let res: Response;
            try {
                res = await request(`${API_BASE}/ai/learning/org-overview`, { signal });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                throw new Error(`HTTP ${err.status}`);
            }
            return res.json();
        },
    });
}
