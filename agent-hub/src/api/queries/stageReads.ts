// The Solution pipeline's reads: one stage's settings (its addresses) and the
// deployments it has had (newest first, older ones on request). The key holds
// `refreshKey`, which the pipeline bumps whenever a deployment may have moved,
// so a bump reads again exactly where the effect used to re-run.

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
    getStage, listDeployments,
    type DeploymentSummary, type StageKey, type StageSettingsSummary,
} from '../stagesApi';

const stageKeys = {
    stage: (solutionId: string, stage: StageKey, refreshKey: number) => ['stages', 'stage', solutionId, stage, refreshKey] as const,
    history: (solutionId: string, stage: StageKey) => ['stages', 'history', solutionId, stage] as const,
};

/** The stage's settings; a refused read is an error (the page says it could not read them). */
export function useStageSettingsQuery(solutionId: string, stage: StageKey, refreshKey: number) {
    return useQuery<StageSettingsSummary, Error>({
        queryKey: stageKeys.stage(solutionId, stage, refreshKey),
        queryFn: async () => {
            const res = await getStage(solutionId, stage);
            if (!res.ok) throw new Error('stage not readable');
            return res.data;
        },
        staleTime: 0,
        retry: false,
    });
}

/** The cache key of a stage's deployment history, for the reset after a retry or cancel. */
export const stageHistoryKey = stageKeys.history;

interface HistoryPage { deployments: DeploymentSummary[]; nextCursor: string | null }

/** The deployments of a stage, a page at a time (`fetchNextPage` shows older ones). */
export function useStageHistoryQuery(solutionId: string, stage: StageKey, refreshKey: number) {
    return useInfiniteQuery<HistoryPage, Error>({
        queryKey: [...stageKeys.history(solutionId, stage), refreshKey],
        initialPageParam: null as string | null,
        queryFn: async ({ pageParam }) => {
            const res = await listDeployments(solutionId, stage, pageParam as string | null);
            if (!res.ok || !Array.isArray(res.data?.deployments)) throw new Error('history not readable');
            return { deployments: res.data.deployments, nextCursor: res.data.nextCursor || null };
        },
        getNextPageParam: (last) => last.nextCursor,
        staleTime: 0,
        retry: false,
    });
}
