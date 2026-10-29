import PipelineTab from './pipeline/PipelineTab';
import StageSettingsTab from './pipeline/settings/StageSettingsTab';
import VariablesDeclarations from './pipeline/settings/VariablesDeclarations';
import StageHistory from './pipeline/StageHistory';
import StageStatus from './pipeline/StageStatus';
import Notice from './Notice';
import ProjectFlowTab from './ProjectFlowTab';
import ProjectOverviewTab from './ProjectOverviewTab';
import SolutionContentTable from './SolutionContentTable';
import SolutionControlPanel from './SolutionControlPanel';
import { humanizeActivity, OPEN_PATH, type useSolutionData } from './solutionDetailData';
import type { SolutionRole } from './SolutionAccessDialog';
import type { SolutionItem } from './solutionSections';
import SolutionInstallsTab from './SolutionInstallsTab';
import SolutionVersionsTab from './SolutionVersionsTab';
import { UpdateBanner, type updateAvailability } from './upgradeClient';
import { formatRelative } from '@/components/projects/relativeTime';
import type React from 'react';
import type { SolutionDetailViewProps } from './SolutionDetail.types';

// The tab panes of SolutionDetailView: the stage and pipeline panes, and the Solution's own.

interface StagePanesProps {
    availability: ReturnType<typeof updateAvailability>;
    onOpenUpgrade: (() => void) | undefined;
    tab: string;
    solutionId: string;
    solutionName: string;
    stage: SolutionDetailViewProps['stage'];
    stageRow: SolutionDetailViewProps['stageRow'];
    pipeline: SolutionDetailViewProps['pipeline'];
    pipelineState: SolutionDetailViewProps['pipelineState'];
    pipelineTick: number;
    role: SolutionRole;
    isOwner: boolean;
    canEdit: boolean;
    currentUserId: string | null;
    onReloadPipeline: SolutionDetailViewProps['onReloadPipeline'];
    onOpenStageSettings: SolutionDetailViewProps['onOpenStageSettings'];
    onOpenChecks: () => void;
}

/** The update banner (Dev), a stage's Status, History and Settings, and on Dev the Pipeline tab and its variable declarations. */
export function StagePanes({
    availability, onOpenUpgrade, tab, solutionId, solutionName, stage, stageRow, pipeline, pipelineState, pipelineTick, role, isOwner, canEdit,
    currentUserId, onReloadPipeline, onOpenStageSettings, onOpenChecks,
}: StagePanesProps) {
    const isStage = stage !== 'dev';
    return (
        <>
            {/* Above every tab, because “there is a newer version” concerns the Solution
                and not the tab that happens to be open. Only the owner can apply it —
                the same role the route requires — so only that person gets the button. */}
            {!isStage && (
                <UpdateBanner
                    availability={availability}
                    onOpen={onOpenUpgrade}
                />
            )}
            {isStage && tab === 'status' && (
                <StageStatus solutionId={solutionId} stage={stage} row={stageRow} refreshKey={pipelineTick} />
            )}
            {isStage && tab === 'history' && (
                <StageHistory
                    solutionId={solutionId}
                    stage={stage}
                    canAct={role === 'owner'}
                    refreshKey={pipelineTick}
                    onChanged={onReloadPipeline}
                />
            )}
            {isStage && tab === 'settings' && (
                <StageSettingsTab
                    solutionId={solutionId}
                    solutionName={solutionName}
                    stage={stage}
                    stageRow={stageRow}
                    currentUserId={currentUserId}
                    onChanged={onReloadPipeline}
                />
            )}
            {!isStage && tab === 'pipeline' && (
                <PipelineTab
                    solutionId={solutionId}
                    solutionName={solutionName}
                    pipeline={pipeline}
                    readState={pipelineState}
                    owner={isOwner}
                    onReload={onReloadPipeline}
                    onOpenSettings={onOpenStageSettings}
                    onOpenChecks={onOpenChecks}
                />
            )}
            {!isStage && tab === 'pipeline' && pipeline?.dev && (
                <VariablesDeclarations solutionId={solutionId} canEdit={canEdit} />
            )}
        </>
    );
}

interface SolutionPanesProps {
    tab: string;
    isStage: boolean;
    dataId: string;
    data: ReturnType<typeof useSolutionData>;
    role: SolutionRole;
    currentUserId: string | null;
    removeError: string | null;
    onRemove: React.ComponentProps<typeof SolutionContentTable>['onRemove'];
    onAdded: () => void;
    onOpenContent: () => void;
}

/** Content (with a failed removal said out loud), Checks, Versions, Installs, Flow and Overview. */
export function SolutionPanes({ tab, isStage, dataId, data, role, currentUserId, removeError, onRemove, onAdded, onOpenContent }: SolutionPanesProps) {
    return (
        <>
            {tab === 'content' && removeError && (
                <Notice tone="error" testId="solution-remove-error">{removeError}</Notice>
            )}
            {tab === 'content' && (
                <SolutionContentTable
                    projectId={dataId}
                    readOnly={isStage}
                    resources={data.resources}
                    loading={data.resourcesLoading}
                    role={role}
                    currentUserId={currentUserId}
                    graph={data.graph}
                    completeness={data.completeness}
                    onOpen={(kind: keyof typeof OPEN_PATH, item: SolutionItem) => OPEN_PATH[kind] && window.location.assign(OPEN_PATH[kind](item.id))}
                    onRemove={onRemove}
                    onAdded={onAdded}
                />
            )}
            {tab === 'control' && (
                <SolutionControlPanel
                    completeness={data.completeness}
                    readOnly={isStage}
                    loading={data.completenessLoading}
                    error={data.completenessError}
                    onOpen={(href) => window.location.assign(href)}
                />
            )}
            {tab === 'versions' && <SolutionVersionsTab remote={data.releases} />}
            {tab === 'installs' && <SolutionInstallsTab remote={data.installs} />}
            {tab === 'flow' && <ProjectFlowTab graph={data.graph} loading={data.graphLoading} />}
            {tab === 'overview' && (
                <ProjectOverviewTab
                    resources={data.resources}
                    loading={data.resourcesLoading}
                    activity={data.activityFailed ? null : data.activity}
                    activeRuns={data.runs}
                    onOpenTab={onOpenContent}
                    formatActivity={humanizeActivity}
                    formatRelative={formatRelative}
                />
            )}
        </>
    );
}
