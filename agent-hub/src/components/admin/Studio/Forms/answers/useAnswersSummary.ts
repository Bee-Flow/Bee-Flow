import { useCallback, useEffect, useRef, useState } from 'react';
import { rangeToQuery } from './answersRange';
import type { AnswersRange } from './answersRange';
import { datatablesApi } from '../../Datatables/datatablesApi';

const REFRESH_MS = 30_000;

/** One question's tally; which fields are set depends on `breakdown.kind`. */
export interface QuestionBreakdown {
    kind?: string;
    values?: Array<{ value: string; n: number; pct: number }>;
    yes?: number;
    no?: number;
    avg?: number | null;
    p50?: number | null;
    min?: number | null;
    max?: number | null;
    buckets?: Array<{ bucket: string; n: number }>;
    recent?: Array<{ rowId: string; value: string; at?: string | null }>;
    count?: number;
}

/** One question of the form, with its answers tallied. */
export interface AnswersQuestion {
    fieldId: string;
    key: string;
    label: string;
    answered: number;
    skipped?: number;
    retired?: boolean;
    columnType?: string;
    pageStepId?: string | null;
    breakdown?: QuestionBreakdown | null;
}

/** One recent response, with a preview of its first answers. */
export interface AnswersRecent {
    rowId: string;
    runId: string;
    submittedAt?: string | null;
    by?: { id: string; name?: string } | null;
    preview?: Record<string, unknown> | null;
}

/** The numbers over the whole table and over the chosen period. */
export interface AnswersTotals {
    all: number;
    inRange: number;
    today: number;
    open?: number;
    completed: number;
    lastAt?: string | null;
}

/** The server's answer for a form's dashboard. */
export interface AnswersSummary {
    table?: { name?: string; rowCount?: number } | null;
    range?: { bucket?: string } | null;
    totals?: AnswersTotals | null;
    timeline?: Array<{ bucket: string; n: number }>;
    questions?: AnswersQuestion[];
    recent?: AnswersRecent[];
}


/**
 * The dashboard's one answer, refetched every 30 s while the tab is on
 * screen (document.visibilityState) and at once when it comes back — no
 * pulse route, no socket: a submission that landed a minute ago is what a
 * dashboard is for. The last data stays on screen while a refresh runs.
 */
export default function useAnswersSummary(datatableId: string | null | undefined, range: AnswersRange) {
    const { from, to } = rangeToQuery(range);
    const [data, setData] = useState<AnswersSummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<unknown>(null);
    const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
    const alive = useRef<boolean>(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    const fetchOnce = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
        if (!datatableId) return;
        if (silent) setRefreshing(true); else setLoading(true);
        try {
            const body = await datatablesApi.answersSummary(datatableId, { from, to });
            if (!alive.current) return;
            setData(body);
            setError(null);
            setUpdatedAt(new Date());
        } catch (e) {
            if (alive.current) setError(e);
        } finally {
            if (alive.current) { setLoading(false); setRefreshing(false); }
        }
    }, [datatableId, from, to]);

    useEffect(() => { fetchOnce(); }, [fetchOnce]);

    useEffect(() => {
        if (!datatableId) return undefined;
        const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
        const tick = () => { if (visible()) fetchOnce({ silent: true }); };
        const timer = setInterval(tick, REFRESH_MS);
        const onVisibility = () => { if (visible()) fetchOnce({ silent: true }); };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
        return () => {
            clearInterval(timer);
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [datatableId, fetchOnce]);

    return { data, loading, refreshing, error, updatedAt, reload: () => fetchOnce({ silent: !!data }) };
}
