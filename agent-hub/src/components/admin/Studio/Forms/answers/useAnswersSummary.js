import { useCallback, useEffect, useRef, useState } from 'react';
import { rangeToQuery } from './answersRange';
import { datatablesApi } from '../../Datatables/datatablesApi';

const REFRESH_MS = 30_000;

/**
 * The dashboard's one answer, refetched every 30 s while the tab is on
 * screen (document.visibilityState) and at once when it comes back — no
 * pulse route, no socket: a submission that landed a minute ago is what a
 * dashboard is for. The last data stays on screen while a refresh runs.
 */
export default function useAnswersSummary(datatableId, range) {
    const { from, to } = rangeToQuery(range);
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState(null);
    const [updatedAt, setUpdatedAt] = useState(null);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    const fetchOnce = useCallback(async ({ silent = false } = {}) => {
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
