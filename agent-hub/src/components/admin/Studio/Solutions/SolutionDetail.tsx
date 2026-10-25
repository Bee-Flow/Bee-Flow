import { useCallback, useEffect, useMemo, useState } from 'react';
import { effectiveStage, readStateOf, type PipelineReadState } from './pipeline/pipelineModel';
import PipelineTab from './pipeline/PipelineTab';
import StageSettingsTab from './pipeline/settings/StageSettingsTab';
import VariablesDeclarations from './pipeline/settings/VariablesDeclarations';
import StageHistory from './pipeline/StageHistory';
import StageRail from './pipeline/StageRail';
import { getPipeline, stageFromSearch, type PipelineStage, type Pipeline, type StageName, type StageKey } from '../../../../api/stagesApi';
import StageStatus from './pipeline/StageStatus';
import { useStageLabel } from './pipeline/StageSwitcher';
import Notice from './Notice';
import ProjectAudienceCapsule from './ProjectAudienceCapsule';
import ProjectFlowTab from './ProjectFlowTab';
import ProjectOverviewTab from './ProjectOverviewTab';
import SolutionContentTable from './SolutionContentTable';
import SolutionControlPanel from './SolutionControlPanel';
import { blueprintVersionFor, controlBadge, humanizeActivity, OPEN_PATH, STAGE_TABS, SUB_TABS, useSolutionData } from './solutionDetailData';
import SolutionDetailDialogs, { type DialogName } from './SolutionDetailDialogs';
import type { SolutionRole } from './SolutionAccessDialog';
import type { SolutionItem } from './solutionSections';
import { HeaderExtras, PublishButton } from './SolutionDetailParts';
import SolutionInstallsTab, { installsBadge } from './SolutionInstallsTab';
import SolutionVersionsTab from './SolutionVersionsTab';
import { UpdateBanner, updateAvailability } from './upgradeClient';
import { useTranslation } from '../../../../hooks/useTranslation';
import { API_BASE } from '../../../../utils/helpers';
import { formatRelative } from '../../../projects/relativeTime';
import StudioSectionHeader from '../../../shared/StudioSectionHeader';
import type { SolutionProject, SolutionDetailViewProps, SolutionDetailProps } from './SolutionDetail.types';
import { logger } from '../../../../utils/logger';
import { mutate, errorBody, RefusedError } from '../../../../api/mutate';
export type { SolutionProject } from './SolutionDetail.types';

;

function SolutionDetailView({
    project, onBack, currentUserId, dataId, stage, stageRow, pipeline, pipelineState, onSelectStage, initialTab,
    onReloadPipeline, pipelineTick, onOpenStageSettings,
}: SolutionDetailViewProps) {
    const { t } = useTranslation();
    const stageLabel = useStageLabel();
    const isStage = stage !== 'dev';
    // Unknown is not empty: a read that failed (5xx, network) or was refused for
    // the licence keeps the tab, so it can say so; only "not a Solution" and
    // "no access" mean there is nothing to show.
    const showPipelineTab = !!pipeline?.dev || pipelineState === 'unreadable' || pipelineState === 'no_licence';
    const tabList = isStage ? STAGE_TABS : SUB_TABS.filter(tabDef => tabDef.id !== 'pipeline' || showPipelineTab);
    const [tab, setTab] = useState(() => {
        const wanted = initialTab && tabList.some(tabDef => tabDef.id === initialTab) ? initialTab : null;
        return wanted || (isStage ? 'status' : 'content');
    });
    const [dialog, setDialog] = useState<DialogName>(null);          // null | 'export' | 'publish' | 'upgrade' | 'access'
    const [name, setName] = useState(project.name);
    const data = useSolutionData(dataId);
    const {
        fetchResources, fetchActivity, fetchGraph, fetchCompleteness, fetchMembers, fetchBlueprints,
        fetchReleases, fetchInstalls,
    } = data;
    // The resources listing carries the caller's authoritative role; the list
    // row's permission covers the gap until it loads.
    const role = (data.resources?.role || (isStage ? stageRow?.role : project.permission) || 'viewer') as SolutionRole;
    // A stage is read-only for everyone: its parts are changed in Dev and deployed.
    const canEdit = !isStage && (role === 'owner' || role === 'editor');
    const isOwner = role === 'owner';

    // The server's name is the truth; the local copy only exists so a rename
    // paints instantly and can be rolled back when the server refuses. Same
    // shape, and the same lint exemption, as StudioSectionHeader's own draft.
    useEffect(() => { setName(project.name); }, [project.name]);

    // The header needs all five the moment it paints: the audience capsule, the
    // version chip, the Check badge, the Installs badge and — the one that
    // matters — the publish verdict, which is not a property of whichever tab
    // happens to be open. `fetchBlueprints` does double duty here: it is the
    // ORG-SCOPED gallery listing the update banner resolves its Blueprint
    // through, so the banner cannot promise a version before the scope is known.
    useEffect(() => {
        fetchResources();
        if (isStage) return;
        // The checks, the audience, the Blueprint gallery and the install count
        // are Dev's: every one of those routes answers 404 for a stage id.
        fetchCompleteness();
        fetchMembers();
        fetchBlueprints();
        fetchInstalls();
    }, [isStage, fetchResources, fetchCompleteness, fetchMembers, fetchBlueprints, fetchInstalls]);

    useEffect(() => {
        if (tab === 'overview') fetchActivity();
        if (tab === 'content' || tab === 'flow') fetchGraph();
        if (tab === 'versions') fetchReleases();
    }, [tab, fetchActivity, fetchGraph, fetchReleases]);

    // A refused or failed removal is said out loud: the listing stays truthful
    // (the row is still there), but a Remove button that does nothing, silently,
    // is not an answer.
    const [removeError, setRemoveError] = useState<string | null>(null);
    const removeResource = async (kind: string, item: { id: string }) => {
        setRemoveError(null);
        try {
            try {
                await mutate(`${API_BASE}/api/projects/${project.id}/resources`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind, id: item.id, attach: false }),
            });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const body = errorBody(err) ?? null;
                setRemoveError(body?.error || t('solutions.remove_failed', 'That could not be removed from the Solution.'));
                return;
            }
            fetchResources();
            fetchGraph();
            fetchCompleteness();
        } catch {
            setRemoveError(t('solutions.remove_failed', 'That could not be removed from the Solution.'));
        }
    };

    const rename = async (next: string) => {
        setName(next);
        try {
            await mutate(`${API_BASE}/api/projects/${project.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: next }),
            });
        } catch { setName(project.name); }   // the server refused (or was unreachable); say so by reverting
    };

    const version = useMemo(
        () => blueprintVersionFor(data.blueprints, project.id),
        [data.blueprints, project.id],
    );
    const badge = controlBadge(data.completeness);
    const installs = installsBadge(data.installs);

    /**
     * May the banner promise something?
     *
     * The Blueprint is looked up in `data.blueprints` — the ORG-SCOPED list from
     * GET /package/blueprints. If it is not in there, the answer is `unknown` and no
     * update appears. `installedVersion` comes from the summary row; if that is not
     * there, there is nothing to compare against and the answer is also `unknown` —
     * never “updated”.
     */
    const availability = useMemo(() => updateAvailability({
        installedFromBlueprintId: project.installedFromBlueprintId,
        installedVersion: project.update?.installedVersion,
        blueprints: data.blueprints,
    }), [project.installedFromBlueprintId, project.update?.installedVersion, data.blueprints]);

    const tabs = tabList.map(tabDef => ({
        id: tabDef.id,
        label: t(tabDef.labelKey, tabDef.fallback),
        icon: tabDef.icon,
        ...(tabDef.id === 'control' ? badge : {}),
        ...(tabDef.id === 'installs' ? installs : {}),
    }));

    // THE publish gate. Not `findings.length > 0`: a 500, a network failure and
    // "not loaded yet" all leave `blocked` undefined, and every one of those
    // has to keep the button shut.
    const publishBlocked = data.completeness?.blocked !== false;

    return (
        <div className="h-full flex flex-col min-h-0">
            <StudioSectionHeader
                kind="solution"
                title={name}
                // A stage is named by its Solution: renaming is a Dev action.
                onRename={canEdit && !isStage ? rename : undefined}
                statusChip={isStage
                    ? (stageRow?.currentRelease?.seq != null
                        ? t('solution_stages.chip_stage_release', '{stage} · Release {seq}', { stage: stageLabel(stage), seq: stageRow.currentRelease.seq })
                        : stageLabel(stage))
                    : (version ? t('solutions.blueprint_version', 'Blueprint v{version}').replace('{version}', String(version)) : null)}
                tabs={tabs}
                activeTab={tab}
                onTab={setTab}
                onBack={onBack}
                backLabel={t('solutions.back', 'All Solutions')}
                capsule={isStage ? undefined : <ProjectAudienceCapsule members={data.members} />}
                primary={isStage ? undefined : (
                    <PublishButton
                        onClick={() => setDialog('publish')}
                        disabled={!isOwner || publishBlocked}
                        blocked={publishBlocked}
                    />
                )}
                extras={isStage ? undefined : (
                    <HeaderExtras onExport={() => setDialog('export')} onAccess={() => setDialog('access')} />
                )}
            />

            {/* Dev → UAT → Production under every tab, with the one next step.
                The Pipeline tab carries its own buttons, a stage view has none. */}
            <StageRail
                solutionId={project.id}
                solutionName={name}
                pipeline={pipeline}
                readState={pipelineState}
                owner={!isStage && isOwner}
                active={stage}
                onSelect={onSelectStage}
                onReload={onReloadPipeline}
                onOpenSettings={onOpenStageSettings}
                showAction={!isStage && tab !== 'pipeline'}
                poll={tab !== 'pipeline'}
            />

            <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="max-w-5xl mx-auto px-4 md:px-6 py-5 space-y-6">
                    {/* Above every tab, because “there is a newer version” concerns the Solution
                        and not the tab that happens to be open. Only the owner can apply it —
                        the same role the route requires — so only that person gets the button. */}
                    {!isStage && (
                        <UpdateBanner
                            availability={availability}
                            onOpen={isOwner ? () => setDialog('upgrade') : undefined}
                        />
                    )}
                    {isStage && tab === 'status' && (
                        <StageStatus solutionId={project.id} stage={stage} row={stageRow} refreshKey={pipelineTick} />
                    )}
                    {isStage && tab === 'history' && (
                        <StageHistory
                            solutionId={project.id}
                            stage={stage}
                            canAct={role === 'owner'}
                            refreshKey={pipelineTick}
                            onChanged={onReloadPipeline}
                        />
                    )}
                    {isStage && tab === 'settings' && (
                        <StageSettingsTab
                            solutionId={project.id}
                            solutionName={name}
                            stage={stage}
                            stageRow={stageRow}
                            currentUserId={currentUserId}
                            onChanged={onReloadPipeline}
                        />
                    )}
                    {!isStage && tab === 'pipeline' && (
                        <PipelineTab
                            solutionId={project.id}
                            solutionName={name}
                            pipeline={pipeline}
                            readState={pipelineState}
                            owner={isOwner}
                            onReload={onReloadPipeline}
                            onOpenSettings={onOpenStageSettings}
                            onOpenChecks={() => setTab('control')}
                        />
                    )}
                    {!isStage && tab === 'pipeline' && pipeline?.dev && (
                        <VariablesDeclarations solutionId={project.id} canEdit={canEdit} />
                    )}
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
                            onRemove={isStage ? undefined : removeResource}
                            onAdded={() => { fetchResources(); fetchGraph(); if (!isStage) fetchCompleteness(); }}
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
                            onOpenTab={() => setTab('content')}
                            formatActivity={humanizeActivity}
                            formatRelative={formatRelative}
                        />
                    )}
                </div>
            </div>

            <SolutionDetailDialogs
                dialog={dialog}
                setDialog={setDialog}
                project={project}
                name={name}
                role={role}
                currentUserId={currentUserId}
                completeness={data.completeness}
                availability={availability}
                onBack={onBack}
                refresh={{ fetchMembers, fetchBlueprints, fetchReleases, fetchResources, fetchGraph, fetchCompleteness }}
            />
        </div>
    );
}


/**
 * `?stage=` and `?tab=` follow the screen via replaceState, so the Studio
 * router (which owns the path) never sees a change and nothing remounts.
 */
function mirrorToUrl(stage: string, tab: string | null) {
    try {
        const url = new URL(window.location.href);
        if (stage === 'dev') url.searchParams.delete('stage'); else url.searchParams.set('stage', stage);
        if (tab) url.searchParams.set('tab', tab); else url.searchParams.delete('tab');
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (err) { logger.debug('a URL that cannot be written only costs a deep link', err); }
}

export default function SolutionDetail({ project, onBack, currentUserId, initialStage = null }: SolutionDetailProps) {
    const [read, setRead] = useState<{ status: 'loading' | 'ok' | 'error'; data: Pipeline | null; state: PipelineReadState }>({ status: 'loading', data: null, state: 'ok' });
    const [wanted, setWanted] = useState<{ stage: StageName; tab: string | null }>(() => {
        const params = new URLSearchParams(window.location.search);
        return { stage: initialStage || stageFromSearch(window.location.search), tab: params.get('tab') };
    });

    // `reload` only asks; the read itself sits in the effect so a late answer
    // for an earlier Solution or an earlier ask can never overwrite a newer one.
    const [asked, setAsked] = useState(0);
    const reload = useCallback(() => setAsked(n => n + 1), []);
    useEffect(() => {
        let alive = true;
        (async () => {
            const res = await getPipeline(project.id);
            if (!alive) return;
            setRead(res.ok ? { status: 'ok', data: res.data, state: 'ok' } : { status: 'error', data: null, state: readStateOf(res) });
        })();
        return () => { alive = false; };
    }, [project.id, asked]);

    const stages = read.data?.stages || [];
    const hasDev = !!read.data?.dev;
    const stage = effectiveStage(wanted.stage, { status: read.status, stages, hasDev });
    const stageRow = stage === 'dev' ? undefined : stages.find((s) => s.stage === stage);

    const choose = useCallback((next: StageName, tab: string | null = null) => {
        setWanted({ stage: next, tab });
        mirrorToUrl(next, tab);
    }, []);

    // A deep link to a stage cannot name the stage project until the pipeline is read.
    if (stage !== 'dev' && !stageRow) {
        return <div className="h-full flex items-center justify-center text-[var(--text-tertiary)]" data-testid="solution-stage-loading" />;
    }

    return (
        <SolutionDetailView
            key={`${stageRow ? stageRow.projectId : project.id}:${wanted.tab || ''}`}
            project={project}
            onBack={onBack}
            currentUserId={currentUserId}
            dataId={stageRow ? stageRow.projectId : project.id}
            stage={stage}
            stageRow={stageRow}
            pipeline={read.data}
            pipelineState={read.state}
            onSelectStage={(next) => choose(next)}
            initialTab={wanted.tab}
            onReloadPipeline={reload}
            pipelineTick={asked}
            onOpenStageSettings={(next) => choose(next, 'settings')}
        />
    );
}
