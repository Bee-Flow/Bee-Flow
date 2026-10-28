import type { StageName, PipelineStage, Pipeline, StageKey } from '@/api/stagesApi';
import type { PipelineReadState } from './pipeline/pipelineModel';

/**
 * One Solution, opened in the builder.
 *
 * Split out of SolutionsStudio.jsx, which now owns only the gallery: the detail
 * view is the half that carries the header, five fetches and the publish gate,
 * and the two halves share nothing but the project row you clicked.
 */

/**
 * The detail view of ONE project id: Dev's own, or a stage's (`dataId`). It is
 * remounted (by `key`) when the stage changes, so nothing read for one project
 * can be painted under another's name.
 */
/** The row the overview listed, as far as the detail reads it. */
export type SolutionProject = {
    id: string;
    name: string;
    permission?: string;
    installedFromBlueprintId?: string | null;
    update?: { installedVersion?: number | null } | null;
};

export interface SolutionDetailViewProps {
    project: SolutionProject;
    onBack: () => void;
    currentUserId: string | null;
    dataId: string;
    stage: StageName;
    stageRow: PipelineStage | undefined;
    pipeline: Pipeline | null;
    pipelineState: PipelineReadState;
    onSelectStage: (stage: StageName) => void;
    initialTab: string | null;
    onReloadPipeline: () => void;
    pipelineTick: number;
    onOpenStageSettings: (stage: StageKey) => void;
}

/**
 * One Solution, Dev or one of its stages.
 *
 * The stage lives HERE, not in the router: the stage rail under the header
 * (Dev, UAT, Production and the next step) opens a stage, and the choice is
 * mirrored to `?stage=`. Dev shows
 * its tabs plus Pipeline; UAT and Production show Status, Content, Flow and
 * History of THEIR project id. A stage the pipeline does not list (or a failed
 * read) falls back to Dev, never to a blank page.
 */
export interface SolutionDetailProps {
    project: SolutionProject;
    onBack: () => void;
    currentUserId: string | null;
    initialStage?: StageName | null;
}
