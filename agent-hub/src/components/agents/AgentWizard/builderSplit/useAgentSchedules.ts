/**
 * The scheduled items (Cowork) that run as this agent, for the schedules
 * panel. Moved verbatim from BuilderSplit.
 *
 * Unified entitlements check (false while the snapshot loads: the schedules
 * panel pops in once it resolves; refreshAgentSchedules re-fires via its
 * dependency when the flag flips true).
 */
import { useCallback, useMemo } from 'react';
import { useCoworkSchedulesQuery } from '@/api/queries/sharedReads';
import { useCan } from '@/components/licensing/Gate';

export interface Schedule { id: string; title?: string; agentId?: string | number | null; [key: string]: unknown }

const NO_SCHEDULES: Schedule[] = [];

export default function useAgentSchedules(agentId: string | number | null | undefined) {
    const schedulesAllowed = useCan('agent_routines');
    // The Cowork list is per user; this panel shows the items that run as this agent.
    const query = useCoworkSchedulesQuery<Schedule>(schedulesAllowed && !!agentId);
    const all = query.data;
    const agentSchedules = useMemo(() => (all ?? NO_SCHEDULES).filter(s => s.agentId === agentId), [all, agentId]);
    const { refetch } = query;
    const refreshAgentSchedules = useCallback(async () => {
        if (schedulesAllowed && agentId) await refetch();
    }, [schedulesAllowed, agentId, refetch]);
    return { schedulesAllowed, agentSchedules, refreshAgentSchedules };
}
