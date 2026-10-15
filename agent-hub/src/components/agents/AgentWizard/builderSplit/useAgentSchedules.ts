/**
 * The scheduled items (Cowork) that run as this agent, for the schedules
 * panel. Moved verbatim from BuilderSplit.
 *
 * Unified entitlements check (false while the snapshot loads: the schedules
 * panel pops in once it resolves; refreshAgentSchedules re-fires via its
 * dependency when the flag flips true).
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchCoworkSchedules } from '../../../../api/agentEditor';
import { useCan } from '../../../licensing/Gate';

export interface Schedule { agentId?: string | number | null; [key: string]: unknown }

export default function useAgentSchedules(agentId: string | number | null | undefined) {
    const [agentSchedules, setAgentSchedules] = useState<Schedule[]>([]);
    const schedulesAllowed = useCan('agent_routines');
    const refreshAgentSchedules = useCallback(async () => {
        if (!schedulesAllowed || !agentId) return;
        try {
            // The Cowork list is per user; this panel shows the items that run as this agent.
            const res = await fetchCoworkSchedules();
            if (res.ok) {
                const data = await res.json();
                const all: Schedule[] = Array.isArray(data?.schedules) ? data.schedules : [];
                setAgentSchedules(all.filter(s => s.agentId === agentId));
            }
        } catch { /* non-fatal */ }
    }, [schedulesAllowed, agentId]);
    useEffect(() => { refreshAgentSchedules(); }, [refreshAgentSchedules]);
    return { schedulesAllowed, agentSchedules, refreshAgentSchedules };
}
