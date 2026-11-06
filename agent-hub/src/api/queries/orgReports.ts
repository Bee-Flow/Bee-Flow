// The org-wide monitoring reads behind the Settings panels (feedback,
// terminations, academy overview). Each panel keeps showing the last answer
// while a new date range loads (the previous answer, but never one that
// carries names), as the hand-written loaders did, and its refresh button is `refetch`.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import { request, RefusedError } from '../mutate';

const orgReportKeys = {
    all: ['org-reports'] as const,
    feedback: (q: string, reveal: boolean) => [...orgReportKeys.all, 'feedback', reveal ? 'revealed' : 'pseudonymous', q] as const,
    terminations: (q: string, interval: string, reveal: boolean) => [...orgReportKeys.all, 'terminations', reveal ? 'revealed' : 'pseudonymous', q, interval] as const,
    academy: () => [...orgReportKeys.all, 'academy'] as const,
};

/** The JSON of an answer, or null when it was refused or unreadable. */
async function jsonOrNull(res: Response): Promise<unknown> {
    try { return res.ok ? await res.json() : null; } catch { return null; }
}

/**
 * True when the server refused a name reveal because it could not write the
 * access-audit row (503 `audit_unavailable`): it then sends no rows at all.
 */
async function auditRefused(res: Response): Promise<boolean> {
    if (res.status !== 503) return false;
    const body = await res.clone().json().catch(() => null) as { code?: unknown } | null;
    return body?.code === 'audit_unavailable';
}

/** `?a=b` or `&a=b` appended to a query string that may be empty. */
const withRevealParam = (q: string, reveal: boolean) => (reveal ? `${q}${q ? '&' : '?'}reveal=true` : q);

/**
 * What a hidden read may show while its own answer loads: the previous answer,
 * but only when it carries no names. TanStack hands over the last data the
 * observer had, whatever its key, so after a reveal that would be the revealed list.
 */
const pseudonymousOnly = <T extends { revealed: boolean }>(prev: T | undefined): T | undefined => (prev && !prev.revealed ? prev : undefined);

/** A revealed read is never retried, refetched on focus or kept: each one writes an access-audit row. */
const revealPolicy = (reveal: boolean) => (reveal
    ? { retry: false, refetchOnWindowFocus: false, staleTime: Infinity, gcTime: 0 } as const
    : {} as const);

const FEEDBACK_API = `${API_BASE}/api/feedback/org`;

interface FeedbackSummary { total: number; thumbs_up: number; thumbs_down: number; with_comments: number }
const NO_FEEDBACK: FeedbackSummary = { total: 0, thumbs_up: 0, thumbs_down: 0, with_comments: 0 };

/** The date-range filter string of the org reports (`?startDate=..&endDate=..` or none). */
export function feedbackRangeQuery(range: { startDate?: string | null; endDate?: unknown } | undefined): string {
    const filters: Record<string, string> = range?.startDate ? { startDate: range.startDate, endDate: String(range.endDate) } : {};
    const qs = new URLSearchParams(filters).toString();
    return qs ? `?${qs}` : '';
}

export interface FeedbackReport<Item> {
    feedback: Item[];
    summary: FeedbackSummary;
    /** The list carries names (an audited reveal), not pseudonyms. */
    revealed: boolean;
    /** The reveal was refused: the access audit log could not record it, so no rows came. */
    auditFailed: boolean;
}

/**
 * The org's feedback list and its summary for one range; an unreadable half reads as empty.
 * With `reveal` the list asks for names, which the server records first (see `revealPolicy`).
 */
export function useOrgFeedbackQuery<Item>(q: string, reveal = false) {
    return useQuery<FeedbackReport<Item>>({
        queryKey: orgReportKeys.feedback(q, reveal),
        queryFn: async ({ signal }) => {
            const [listResp, sumResp] = await Promise.all([
                authFetch(`${FEEDBACK_API}${withRevealParam(q, reveal)}`, { signal }),
                authFetch(`${FEEDBACK_API}/summary${q}`, { signal }),
            ]);
            const auditFailed = reveal && await auditRefused(listResp);
            const list = await jsonOrNull(listResp);
            const sum = (await jsonOrNull(sumResp)) as FeedbackSummary | null;
            return {
                feedback: (Array.isArray(list) ? list : []) as Item[],
                summary: sum || NO_FEEDBACK,
                revealed: reveal && Array.isArray(list),
                auditFailed,
            };
        },
        placeholderData: reveal ? undefined : pseudonymousOnly,
        ...revealPolicy(reveal),
    });
}

/** The range filter of the terminations reads: a start/end window, else `?days=N`, else none. */
export function terminationsRangeQuery(range: { startDate?: string | null; endDate?: unknown; days?: number | null } | undefined): string {
    if (range?.startDate) return `?startDate=${encodeURIComponent(range.startDate)}&endDate=${encodeURIComponent(String(range.endDate))}`;
    return range?.days != null ? `?days=${range.days}` : '';
}

const TERMINATIONS_API = `${API_BASE}/api/terminations/org`;

export interface TerminationsReport<Summary, Timeline, Row, ByAgent> {
    summary: Summary | null;
    timeline: Timeline[];
    rows: Row[];
    byAgent: ByAgent[];
    /** The rows carry names (an audited reveal), not pseudonyms. */
    revealed: boolean;
    /** The reveal was refused: the access audit log could not record it, so no rows came. */
    auditFailed: boolean;
}

/**
 * Summary, timeline, rows and per-agent split of the agent terminations for one range.
 * With `reveal` the rows ask for names, which the server records first (see `revealPolicy`).
 */
export function useOrgTerminationsQuery<Summary, Timeline, Row, ByAgent>(q: string, interval: string, reveal = false) {
    return useQuery<TerminationsReport<Summary, Timeline, Row, ByAgent>>({
        queryKey: orgReportKeys.terminations(q, interval, reveal),
        queryFn: async ({ signal }) => {
            const intervalQ = `${q ? '&' : '?'}interval=${interval}`;
            const [sumR, tlR, listR, agR] = await Promise.all([
                authFetch(`${TERMINATIONS_API}/summary${q}`, { signal }),
                authFetch(`${TERMINATIONS_API}/timeline${q}${intervalQ}`, { signal }),
                authFetch(`${TERMINATIONS_API}${q}${q ? '&' : '?'}limit=200${reveal ? '&reveal=true' : ''}`, { signal }),
                authFetch(`${TERMINATIONS_API}/by-agent${q}`, { signal }),
            ]);
            const auditFailed = reveal && await auditRefused(listR);
            const [sum, tl, list, ag] = (await Promise.all([sumR, tlR, listR, agR].map(jsonOrNull))) as [
                Summary | null, { rows?: Timeline[] } | null, { rows?: Row[] } | null, { rows?: ByAgent[] } | null,
            ];
            return {
                summary: sum, timeline: tl?.rows || [], rows: list?.rows || [], byAgent: ag?.rows || [],
                revealed: reveal && Array.isArray(list?.rows), auditFailed,
            };
        },
        placeholderData: reveal ? undefined : pseudonymousOnly,
        ...revealPolicy(reveal),
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
