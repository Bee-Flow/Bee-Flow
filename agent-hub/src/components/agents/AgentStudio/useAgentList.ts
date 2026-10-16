import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentListRow } from './agentCardFacts';
import { fetchAgentList } from '../../../api/agentStudio';
import { isAbortError, messageOf } from '../../../utils/caughtError';

export interface AgentList {
    agents: AgentListRow[];
    loading: boolean;
    loadError: string | null;
    fetchAgents: () => Promise<void>;
}

/**
 * The agent list of the Studio screen: one fetch, re-armed by `fetchAgents`.
 *
 * Track in-flight list fetches so an unmount or rapid refetch can abort the
 * older request before its setState fires. React strict-mode double-invokes
 * effects in dev (mount → cleanup → mount); the setup re-arms the flag so
 * the second "mount" doesn't see a permanently-false ref left over by the
 * first cleanup — without this, every state setter inside fetchAgents was
 * skipped on the live mount and the loading spinner stuck forever.
 */
export default function useAgentList(systemMode: boolean): AgentList {
    const [agents, setAgents] = useState<AgentListRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    const listAbortRef = useRef<AbortController | null>(null);
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (listAbortRef.current) {
                try { listAbortRef.current.abort(); } catch (_) { /* noop */ }
            }
        };
    }, []);

    const fetchAgents = useCallback(async () => {
        if (listAbortRef.current) {
            try { listAbortRef.current.abort(); } catch (_) { /* noop */ }
        }
        const ctrl = new AbortController();
        listAbortRef.current = ctrl;
        setLoading(true);
        setLoadError(null);
        try {
            const res = await fetchAgentList(systemMode, ctrl.signal);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const data: unknown = await res.json();
            if (!mountedRef.current || ctrl.signal.aborted) return;
            setAgents(Array.isArray(data) ? data : []);
        } catch (e) {
            if (isAbortError(e)) return;
            console.error('Failed to load agents', e);
            if (mountedRef.current) {
                setLoadError(messageOf(e, 'Failed to load'));
                setAgents([]);
            }
        } finally {
            if (mountedRef.current && listAbortRef.current === ctrl) {
                setLoading(false);
            }
        }
    }, [systemMode]);

    useEffect(() => { fetchAgents(); }, [fetchAgents]);

    return { agents, loading, loadError, fetchAgents };
}
