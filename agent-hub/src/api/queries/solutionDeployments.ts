// The deploy dialog's requests about one Solution stage: the plan of a
// deployment (POST …/plan, which writes nothing but is asked anew each time
// the dialog opens or the stage moved), and a running deployment's progress,
// read again on the dialog's own interval through the query cache.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { getDeployment, planDeployment, type DeploymentKind, type StageKey } from '../stagesApi';

export interface PlanRequest {
    solutionId: string;
    stage: StageKey;
    releaseId: string | null;
    kind?: DeploymentKind;
}

export function usePlanDeploymentMutation() {
    return useMutation({
        mutationFn: ({ solutionId, stage, releaseId, kind }: PlanRequest) => planDeployment(solutionId, stage, releaseId, kind),
    });
}

export function useDeploymentProgressRead() {
    const qc = useQueryClient();
    return useCallback((solutionId: string, deploymentId: string) => qc.fetchQuery({
        queryKey: ['solutions', solutionId, 'deployments', deploymentId],
        queryFn: () => getDeployment(solutionId, deploymentId),
        staleTime: 0,
        gcTime: 0,
        retry: false,
    }), [qc]);
}
