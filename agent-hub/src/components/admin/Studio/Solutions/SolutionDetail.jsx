import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { effectiveStage, readStateOf } from './pipeline/pipelineModel';
import PipelineTab from './pipeline/PipelineTab';
import StageSettingsTab from './pipeline/settings/StageSettingsTab';
import VariablesDeclarations from './pipeline/settings/VariablesDeclarations';
import StageHistory from './pipeline/StageHistory';
import StageRail from './pipeline/StageRail';
import { getPipeline, stageFromSearch } from './pipeline/stagesApi';
import StageStatus from './pipeline/StageStatus';
import { useStageLabel } from './pipeline/StageSwitcher';
import ProjectAudienceCapsule from './ProjectAudienceCapsule';
import ProjectFlowTab from './ProjectFlowTab';
import ProjectOverviewTab from './ProjectOverviewTab';
import SolutionContentTable from './SolutionContentTable';
import SolutionControlPanel from './SolutionControlPanel';
import { blueprintVersionFor, controlBadge, humanizeActivity, OPEN_PATH, STAGE_TABS, SUB_TABS, useSolutionData } from './solutionDetailData';
import SolutionDetailDialogs from './SolutionDetailDialogs';
import { HeaderExtras, PublishButton } from './SolutionDetailParts';
import SolutionInstallsTab, { installsBadge } from './SolutionInstallsTab';
import SolutionVersionsTab from './SolutionVersionsTab';
import { UpdateBanner, updateAvailability } from './upgradeClient';
import { useTranslation } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { formatRelative } from '../../../projects/relativeTime';
import StudioSectionHeader from '../../../shared/StudioSectionHeader';

export { blueprintVersionFor, controlBadge };

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
function SolutionDetailView({
    project, onBack, currentUserId, dataId, stage, stageRow, pipeline, pipelineState, onSelectStage, initialTab,
    onReloadPipeline, pipelineTick, onOpenStageSettings,
}) {
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
    const [dialog, setDialog] = useState(null);          // null | 'export' | 'publish' | 'upgrade' | 'access'
    const [name, setName] = useState(project.name);
    const data = useSolutionData(dataId);
    const {
        fetchResources, fetchActivity, fetchGraph, fetchCompleteness, fetchMembers, fetchBlueprints,
        fetchReleases, fetchInstalls,
    } = data;
    // The resources listing carries the caller's authoritative role; the list
    // row's permission covers the gap until it loads.
    const role = data.resources?.role || (isStage ? stageRow?.role : project.permission) || 'viewer';
    // A stage is read-only for everyone: its parts are changed in Dev and deployed.
    const canEdit = !isStage && (role === 'owner' || role === 'editor');
    const isOwner = role === 'owner';

    // The server's name is the truth; the local copy only exists so a rename
    // paints instantly and can be rolled back when the server refuses. Same
    // shape, and the same lint exemption, as StudioSectionHeader's own draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

    const removeResource = async (kind, item) => {
        try {
            await authFetch(`${API_BASE}/api/projects/${project.id}/resources`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind, id: item.id, attach: false }),
            });
            fetchResources();
            fetchGraph();
            fetchCompleteness();
        } catch { /* the listing still shows it, which is the truth */ }
    };

    const rename = async (next) => {
        setName(next);
        try {
            const res = await authFetch(`${API_BASE}/api/projects/${project.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: next }),
            });
            if (!res.ok) setName(project.name);      // the server refused; say so by reverting
        } catch { setName(project.name); }
    };

    const version = useMemo(
        () => blueprintVersionFor(data.blueprints, project.id),
        [data.blueprints, project.id],
    );
    const badge = controlBadge(data.completeness);
    const installs = installsBadge(data.installs);

    /**
     * Mag de banner iets beloven?
     *
     * De Blueprint wordt opgezocht in `data.blueprints` — de ORG-GESCOOPTE
     * lijst van GET /package/blueprints. Staat hij daar niet in, dan is het
     * antwoord `unknown` en verschijnt er geen update. `installedVersion` komt
     * uit de summary-rij; is die er niet, dan is er niets om tegen te
     * vergelijken en is het antwoord óók `unknown` — nooit "bijgewerkt".
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
                    {/* Boven elke tab, want "er is een nieuwere versie" gaat over
                        de Oplossing en niet over het tabblad dat toevallig open
                        staat. Alleen de eigenaar kan hem toepassen — dezelfde
                        rol die de route eist — dus alleen die krijgt de knop. */}
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
                            onOpen={(kind, item) => OPEN_PATH[kind] && window.location.assign(OPEN_PATH[kind](item.id))}
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
                            activity={data.activity}
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
function mirrorToUrl(stage, tab) {
    try {
        const url = new URL(window.location.href);
        if (stage === 'dev') url.searchParams.delete('stage'); else url.searchParams.set('stage', stage);
        if (tab) url.searchParams.set('tab', tab); else url.searchParams.delete('tab');
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch { /* a URL that cannot be written only costs a deep link */ }
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
export default function SolutionDetail({ project, onBack, currentUserId, initialStage = null }) {
    const [read, setRead] = useState({ status: 'loading', data: null, state: 'ok' });
    const [wanted, setWanted] = useState(() => {
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
    const stageRow = stage === 'dev' ? undefined : stages.find(s => s.stage === stage);

    const choose = useCallback((next, tab = null) => {
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
