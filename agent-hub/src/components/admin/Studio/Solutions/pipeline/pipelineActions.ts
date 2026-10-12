import { useRef, useState } from 'react';
import type { useTranslation } from '../../../../../hooks/useTranslation';
import type { DeployRequest } from './DeployDialog';
import { errorKind, type ColumnAction, type ErrorKind } from './pipelineModel';
import {
    cancelDeployment, createStages, cutRelease, findingsFromError, newRequestKey, retryDeployment,
    type PlanFinding, type StageKey,
} from './stagesApi';

/**
 * What a pipeline column's button does, and what it says. Shared by the Pipeline
 * tab (one button per column) and the stage rail under the header (the ONE next
 * step), so the two can never word or perform the same step differently.
 */

export type T = ReturnType<typeof useTranslation>['t'];

export function actionLabel(t: T, a: ColumnAction, stageName: (s: 'dev' | StageKey) => string): string {
    const seq = a.releaseSeq ?? '';
    switch (a.id) {
        case 'setup': return t('solution_stages.action_setup', 'Set up stages');
        case 'release_deploy_uat': return t('solution_stages.action_release_deploy', 'Release & deploy to UAT');
        case 'deploy': return t('solution_stages.action_deploy', 'Deploy R{seq} to {stage}', { seq, stage: stageName(a.stage || 'uat') });
        case 'promote': return t('solution_stages.action_promote', 'Promote R{seq} to Production', { seq });
        case 'request_approval': return t('solution_stages.action_request_approval', 'Request approval for R{seq}', { seq });
        case 'apply_settings': return t('solution_stages.action_apply_settings', 'Apply settings');
        case 'rollback': return a.releaseSeq == null
            ? t('solution_stages.action_rollback_previous', 'Roll back to the previous release')
            : t('solution_stages.action_rollback', 'Roll back to R{seq}', { seq });
        case 'cancel_request': return t('solution_stages.cancel_request', 'Cancel');
        default: return t('solution_stages.retry', 'Retry');
    }
}

/** The things the columns can do: each is one request, then either a reload or the deploy dialog. */
export function usePipelineActions(solutionId: string, onReload: () => void) {
    const [dialog, setDialog] = useState<DeployRequest | null>(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<ErrorKind | null>(null);
    const [findings, setFindings] = useState<PlanFinding[]>([]);
    // One key per intent, kept across a failed attempt so a retry replays.
    const keys = useRef<{ setup: string | null; cut: string | null }>({ setup: null, cut: null });

    const fail = (kind: ErrorKind, list: PlanFinding[] = []) => { setProblem(kind); setFindings(list); };

    const setup = async () => {
        keys.current.setup = keys.current.setup || newRequestKey();
        const res = await createStages(solutionId, ['uat', 'prd'], keys.current.setup);
        if (!res.ok) { fail(errorKind(res)); return; }
        keys.current.setup = null;
        onReload();
    };

    const cut = async () => {
        keys.current.cut = keys.current.cut || newRequestKey();
        const res = await cutRelease(solutionId, keys.current.cut);
        if (!res.ok) { fail(errorKind(res), findingsFromError(res)); return; }
        keys.current.cut = null;
        const release = res.data?.release;
        if (!release?.id) { fail('unknown'); return; }
        onReload();
        setDialog({ stage: 'uat', kind: 'deploy', releaseId: release.id, releaseSeq: release.seq ?? null });
    };

    const onDeployment = async (a: ColumnAction) => {
        if (!a.deploymentId) return;
        const res = a.id === 'cancel_request'
            ? await cancelDeployment(solutionId, a.deploymentId)
            : await retryDeployment(solutionId, a.deploymentId);
        if (!res.ok) { fail(errorKind(res)); return; }
        onReload();
    };

    const act = async (a: ColumnAction) => {
        setProblem(null);
        setFindings([]);
        if (a.stage && a.deployKind && a.id !== 'release_deploy_uat') {
            setDialog({ stage: a.stage, kind: a.deployKind, releaseId: a.releaseId ?? null, releaseSeq: a.releaseSeq ?? null });
            return;
        }
        setBusy(true);
        try {
            if (a.id === 'setup') await setup();
            else if (a.id === 'release_deploy_uat') await cut();
            else await onDeployment(a);
        } finally {
            setBusy(false);
        }
    };

    return { dialog, setDialog, busy, problem, findings, act };
}

