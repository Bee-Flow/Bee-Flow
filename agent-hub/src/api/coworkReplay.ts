// "Replay on last month" (server/usecases/coworkReplay.mts): the changed plan of an item, replayed on what its past
// runs read. A replay touches no app; started here, then read again until it is done.

import { useMutation, useQuery } from '@tanstack/react-query';
import { apiJson } from './typedRequest';

type ReplayVerdict = 'same' | 'differs' | 'partial' | 'not_replayable';
export type NotReplayableReason = 'too_old' | 'no_plan' | 'no_automation_run' | 'not_recorded' | 'failed';

export interface ReplayStart { replayId: string; fingerprint: string; total: number }

export interface ReplayRun {
    pastRunId: string;
    startedAt: string | null;
    verdict: ReplayVerdict;
    reason: NotReplayableReason | null;
    missingSteps: number;
    differingSteps: string[];
}

export interface ReplayState {
    replayId: string;
    status: 'running' | 'done' | 'failed';
    done: boolean;
    fingerprint: string;
    total: number;
    same: number;
    differs: number;
    partial: number;
    notReplayable: number;
    runs: ReplayRun[];
}

/** Replay the plan as it is now on the item's newest past runs. */
function startCoworkPlanReplay(id: string): Promise<ReplayStart> {
    return apiJson<'POST /api/cowork/{id}/plan/replay', ReplayStart>('POST /api/cowork/{id}/plan/replay', { params: { id }, body: {} });
}

/** How a replay is going. */
function getCoworkPlanReplay(id: string, replayId: string): Promise<ReplayState> {
    return apiJson<'GET /api/cowork/{id}/plan/replay/{replayId}', ReplayState>('GET /api/cowork/{id}/plan/replay/{replayId}', { params: { id, replayId } });
}

/** How often a replay that is still going is read again. */
const REPLAY_POLL_MS = 2000;

/** Start a replay and follow it until it is done (or a read fails). */
export function useCoworkPlanReplay(coworkId: string) {
    const start = useMutation<ReplayStart, Error, void>({ mutationFn: () => startCoworkPlanReplay(coworkId) });
    const started = start.data ?? null;
    const follow = useQuery<ReplayState, Error>({
        queryKey: ['cowork', 'plan-replay', coworkId, started?.replayId ?? ''],
        enabled: !!started,
        queryFn: () => getCoworkPlanReplay(coworkId, (started as ReplayStart).replayId),
        refetchInterval: (query) => (query.state.data?.done || query.state.error ? false : REPLAY_POLL_MS),
        staleTime: 0,
        retry: false,
    });
    return { start, started, state: follow.data ?? null, error: start.error ?? follow.error ?? null };
}
