import { Boxes, Download, GitBranch, History, LayoutDashboard, Package, ShieldCheck, Upload, Users } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ProjectAudienceCapsule from './ProjectAudienceCapsule';
import ProjectFlowTab from './ProjectFlowTab';
import ProjectOverviewTab from './ProjectOverviewTab';
import SolutionAccessDialog from './SolutionAccessDialog';
import SolutionContentTable from './SolutionContentTable';
import SolutionControlPanel, { isBlocking } from './SolutionControlPanel';
import SolutionExportDialog from './SolutionExportDialog';
import SolutionInstallsTab, { installsBadge } from './SolutionInstallsTab';
import SolutionVersionsTab from './SolutionVersionsTab';
import UpgradeDialog, { UpdateBanner, updateAvailability } from './upgradeClient';
import useProjectStream from '../../../../hooks/useProjectStream';
import { useTranslation } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { formatRelative } from '../../../projects/relativeTime';
import StudioSectionHeader, { OBJHEAD_FOLD, PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';

/**
 * One Solution, opened in the builder.
 *
 * Split out of SolutionsStudio.jsx, which now owns only the gallery: the detail
 * view is the half that carries the header, five fetches and the publish gate,
 * and the two halves share nothing but the project row you clicked.
 */

// Automation runs use their OWN feed kinds. The bare `run.*` names belong to
// CHAT runs keyed on a conversation id — reusing them would spin an indicator
// on a thread that is not running.
const AUTOMATION_RUN_KINDS = new Set([
    'automation.run.started', 'automation.run.finished', 'automation.run.failed',
]);

// Kinds that change what the Solution HOLDS, so counts and lists refetch.
// Filing a notebook, document or meeting in or out is announced as
// `content.moved_in` / `content.moved_out` (server projects/itemFiling), not as
// `resource_added` / `resource_removed`, so both pairs are listed.
const CONTENT_KINDS = new Set([
    'approval.requested', 'approval.decided', 'resource_added', 'resource_removed',
    'content.moved_in', 'content.moved_out',
]);

/**
 * Kinds that mean a new version of a Blueprint exists.
 *
 * THE EVENT IS A POKE, NEVER THE ANSWER. Its payload is not read for a version
 * number and not read for a Blueprint id: it only triggers the two scoped reads
 * — the gallery listing and this project's release history — and those decide
 * what, if anything, the screen may claim. Trusting the payload would let an
 * event about a Blueprint this reader is not allowed to see put a version number
 * on their screen, which is the one thing the banner must not do.
 *
 * De afzender staat in routes/projects/packaging.js (`announcePublication`),
 * direct na een geslaagde publicatie. Die schrijft ALLEBEI de helften: een
 * `project_activity`-regel voor de pollende fallback van de hook, en het event
 * zelf voor de live stroom. Op een verbinding die nooit SSE krijgt arriveert dit
 * dus op de volgende poll in plaats van live — de eerlijke helft van de belofte,
 * geen gat. En het event draagt bewust geen Blueprint-id en geen versienummer,
 * om precies de reden hierboven.
 */
const RELEASE_KINDS = new Set(['blueprint.published']);

/**
 * Eén losse lees van dit project, opnieuw op te vragen.
 *
 * `status` reist mee omdat "kon niet gelezen worden" en "er is niets" op de
 * Versies- en Installaties-tab twee verschillende antwoorden zijn — zie
 * releaseModel.js. Los van useRemote omdat die geen tweede lees kent, en deze
 * twee moeten opnieuw zodra er gepubliceerd wordt.
 */
function useProjectRead(projectId, path) {
    const [state, setState] = useState({ status: 'loading', data: null });
    const refetch = useCallback(async () => {
        if (!projectId) return;
        try {
            const res = await authFetch(`${API_BASE}/api/projects/${projectId}${path}`);
            const body = await res.json().catch(() => null);
            setState({ status: res.ok ? 'ok' : 'error', data: res.ok ? body : null });
        } catch {
            setState({ status: 'error', data: null });
        }
    }, [projectId, path]);
    return [state, refetch];
}

/** Automation runs in flight, keyed by runId. */
function reduceAutomationRuns(prev, kind, event) {
    const runId = event?.payload?.runId || event?.targetId;
    if (!runId) return prev;
    if (kind === 'automation.run.started') {
        return { ...prev, [runId]: { runId, automationTitle: event.payload?.automationTitle || '' } };
    }
    const next = { ...prev };
    delete next[runId];
    return next;
}

// Where each member kind opens. The Solution page is a directory, not a second
// viewer — same mapping the projects page uses.
const OPEN_PATH = {
    notebook: (id) => `/app/studio/documents/notebook/${id}`,
    app: (id) => `/app/apps/${id}`,
    automation: (id) => `/app/routines/${id}`,
    webpage: (id) => `/app/studio/webpages/${id}`,
    approval: (id) => `/app/studio/approvals/${id}`,
};

/**
 * Overview's activity rows, without the member directory. The full formatter
 * (actor names, target names) needs the directory the project page loads for
 * its Members tab; here a readable action beats loading all of that.
 */
function humanizeActivity(item) {
    const text = String(item.action || '').replace(/[._]/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Everything the detail view fetches, plus the live-feed wiring. */
function useSolutionData(projectId) {
    const [resources, setResources] = useState(null);
    const [resourcesLoading, setResourcesLoading] = useState(false);
    const [activity, setActivity] = useState([]);
    const [graph, setGraph] = useState(null);
    const [graphLoading, setGraphLoading] = useState(false);
    const [completeness, setCompleteness] = useState(null);
    const [completenessLoading, setCompletenessLoading] = useState(false);
    const [completenessError, setCompletenessError] = useState(false);
    const [members, setMembers] = useState(null);
    const [blueprints, setBlueprints] = useState(null);
    const [runs, setRuns] = useState({});
    const [releases, fetchReleases] = useProjectRead(projectId, '/package/releases');
    const [installs, fetchInstalls] = useProjectRead(projectId, '/package/installs');

    const fetchResources = useCallback(async () => {
        if (!projectId) return;
        setResourcesLoading(true);
        try {
            const res = await authFetch(`${API_BASE}/api/projects/${projectId}/resources`);
            // null-vs-[] survives untouched: null = a store could not be
            // reached, and must not render as "you have none".
            if (res.ok) setResources(await res.json());
        } catch { /* keep the previous view rather than blanking it */ } finally {
            setResourcesLoading(false);
        }
    }, [projectId]);

    const fetchActivity = useCallback(async () => {
        if (!projectId) return;
        try {
            const res = await authFetch(`${API_BASE}/api/projects/${projectId}/activity?limit=20`);
            if (!res.ok) return;
            const data = await res.json();
            setActivity(Array.isArray(data) ? data : (data.items || []));
        } catch { /* the stream will re-trigger this */ }
    }, [projectId]);

    const fetchGraph = useCallback(async () => {
        if (!projectId) return;
        setGraphLoading(true);
        try {
            const res = await authFetch(`${API_BASE}/api/projects/${projectId}/graph`);
            if (res.ok) setGraph(await res.json());
        } catch { /* keep the previous view */ } finally {
            setGraphLoading(false);
        }
    }, [projectId]);

    /**
     * The checks, and the verdict the publish button reads.
     *
     * A failure DROPS the previous answer instead of keeping it. Everywhere
     * else on this screen a stale view is the kinder choice; here it is the
     * dangerous one — a "nothing blocking" from two minutes ago would leave the
     * publish button live while the server can no longer confirm anything.
     */
    const fetchCompleteness = useCallback(async () => {
        if (!projectId) return;
        setCompletenessLoading(true);
        try {
            const res = await authFetch(`${API_BASE}/api/projects/${projectId}/completeness`);
            const body = await res.json().catch(() => null);
            if (!res.ok || !body || typeof body.blocked !== 'boolean') {
                setCompleteness(null);
                setCompletenessError(true);
                return;
            }
            setCompleteness(body);
            setCompletenessError(false);
        } catch {
            setCompleteness(null);
            setCompletenessError(true);
        } finally {
            setCompletenessLoading(false);
        }
    }, [projectId]);

    const fetchMembers = useCallback(async () => {
        if (!projectId) return;
        try {
            const res = await authFetch(`${API_BASE}/api/projects/${projectId}/members`);
            if (!res.ok) { setMembers(null); return; }
            const body = await res.json();
            // Unknown stays unknown: the capsule renders nothing rather than
            // the narrower of the two possible audiences.
            setMembers(Array.isArray(body?.members) ? body.members : null);
        } catch { setMembers(null); }
    }, [projectId]);

    const fetchBlueprints = useCallback(async () => {
        try {
            const res = await authFetch(`${API_BASE}/api/projects/package/blueprints`);
            if (!res.ok) { setBlueprints(null); return; }
            const body = await res.json();
            setBlueprints(Array.isArray(body?.blueprints) ? body.blueprints : null);
        } catch { setBlueprints(null); }
    }, []);

    useProjectStream({
        projectId,
        enabled: !!projectId,
        onEvent: useCallback((kind, event) => {
            if (AUTOMATION_RUN_KINDS.has(kind)) {
                setRuns(prev => reduceAutomationRuns(prev, kind, event));
            }
            if (CONTENT_KINDS.has(kind)) {
                fetchResources();
                fetchActivity();
                // Filing something in or out changes which edges are internal —
                // the difference between a dependency a Blueprint carries and
                // one the installer has to supply.
                fetchGraph();
                // …and it changes what there is to check, so the publish
                // verdict is re-asked rather than inherited.
                fetchCompleteness();
            }
            if (RELEASE_KINDS.has(kind)) {
                // Allebei ORG-GESCOOPTE lezen. De galerijlijst beslist opnieuw
                // of deze lezer bij die Blueprint mag — de banner leest zijn
                // versie daaruit en nooit uit het event.
                fetchBlueprints();
                fetchReleases();
            }
        }, [fetchResources, fetchActivity, fetchGraph, fetchCompleteness, fetchBlueprints, fetchReleases]),
    });

    return {
        resources, resourcesLoading, activity, graph, graphLoading,
        completeness, completenessLoading, completenessError, members, blueprints, runs,
        releases, installs,
        fetchResources, fetchActivity, fetchGraph, fetchCompleteness, fetchMembers, fetchBlueprints,
        fetchReleases, fetchInstalls,
    };
}

/**
 * The tab strip.
 *
 * The redesign names four tabs — Content · Check n · Versions · Installs n — and
 * both of the last two now have a data model behind them: `project_releases`
 * holds one immutable row per publication (blueprintStore.publishRelease) and
 * `projects.installed_from_blueprint_id` records where an installed Solution
 * came from. Until they existed, a Versions tab could only have shown a number
 * somebody made up and an Installs badge could only have counted zero, which is
 * why they were held back rather than faked.
 *
 * Flow and Overview stay alongside them rather than being displaced: Flow is the
 * wiring and what this Solution depends on outside itself, Overview its counts,
 * live runs and recent activity. Both are pinned by their own tests, and the
 * grouped Content table replaces neither — it shows dependency pills, not the
 * external list, and shows no activity at all.
 */
const SUB_TABS = [
    { id: 'content', labelKey: 'solutions.tab_content', fallback: 'Content', icon: Boxes },
    { id: 'control', labelKey: 'solutions.tab_control', fallback: 'Check', icon: ShieldCheck },
    { id: 'versions', labelKey: 'solutions.tab_versions', fallback: 'Versions', icon: History },
    { id: 'installs', labelKey: 'solutions.tab_installs', fallback: 'Installs', icon: Download },
    { id: 'flow', labelKey: 'solutions.tab_flow', fallback: 'Flow', icon: GitBranch },
    { id: 'overview', labelKey: 'solutions.tab_overview', fallback: 'Overview', icon: LayoutDashboard },
];

/**
 * The version chip, or nothing.
 *
 * `project_blueprints.version` is bumped per (solution_key, created_by), so two
 * owners who both export produce two independent series and "the version of
 * this Solution" has no single answer. The chip is therefore shown only when
 * ONE person's series exists, and it says Blueprint — which is what the number
 * actually counts — rather than claiming to be the Solution's own version.
 * Nothing is shown when there is no Blueprint yet: an invented "v1.0" would be
 * a release nobody made.
 */
export function blueprintVersionFor(blueprints, projectId) {
    if (!Array.isArray(blueprints) || !projectId) return null;
    const mine = blueprints.filter(b => b?.solutionKey === `sol_${projectId}`);
    if (mine.length === 0) return null;
    if (new Set(mine.map(b => b.createdBy)).size > 1) return null;
    const highest = mine.reduce((max, b) => Math.max(max, Number(b.version) || 0), 0);
    return highest > 0 ? highest : null;
}

/** The Check tab's badge: how many findings, and whether any of them block. */
export function controlBadge(completeness) {
    if (!completeness || !Array.isArray(completeness.findings)) return { count: undefined };
    const findings = completeness.findings;
    if (findings.length === 0) return { count: undefined };
    return { count: findings.length, tone: findings.some(isBlocking) ? 'error' : 'warning' };
}

export default function SolutionDetail({ project, onBack, currentUserId }) {
    const { t } = useTranslation();
    const [tab, setTab] = useState('content');
    const [dialog, setDialog] = useState(null);          // null | 'export' | 'publish' | 'upgrade' | 'access'
    const [name, setName] = useState(project.name);
    const data = useSolutionData(project.id);
    const {
        fetchResources, fetchActivity, fetchGraph, fetchCompleteness, fetchMembers, fetchBlueprints,
        fetchReleases, fetchInstalls,
    } = data;
    // The resources listing carries the caller's authoritative role; the list
    // row's permission covers the gap until it loads.
    const role = data.resources?.role || project.permission || 'viewer';
    const canEdit = role === 'owner' || role === 'editor';
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
        fetchCompleteness();
        fetchMembers();
        fetchBlueprints();
        fetchInstalls();
    }, [fetchResources, fetchCompleteness, fetchMembers, fetchBlueprints, fetchInstalls]);

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

    const tabs = SUB_TABS.map(tabDef => ({
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
                onRename={canEdit ? rename : undefined}
                statusChip={version ? t('solutions.blueprint_version', 'Blueprint v{version}').replace('{version}', String(version)) : null}
                tabs={tabs}
                activeTab={tab}
                onTab={setTab}
                onBack={onBack}
                backLabel={t('solutions.back', 'All Solutions')}
                capsule={<ProjectAudienceCapsule members={data.members} />}
                primary={
                    <button
                        onClick={() => setDialog('publish')}
                        disabled={!isOwner || publishBlocked}
                        data-testid="solution-publish"
                        title={publishBlocked
                            ? t('solutions.publish_blocked', 'Not while there are things to fix — or while the checks could not be run.')
                            : undefined}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium disabled:opacity-50"
                        style={PRIMARY_ACTION_STYLE}
                    >
                        <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                        <span className={OBJHEAD_FOLD.action}>{t('solutions.publish', 'Publish')}</span>
                    </button>
                }
                extras={
                    <>
                        <button
                            onClick={() => setDialog('export')}
                            data-testid="solution-export"
                            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] border"
                            style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                        >
                            <Package className="w-3.5 h-3.5" aria-hidden="true" />
                            <span className={OBJHEAD_FOLD.action}>{t('solutions.export', 'Export')}</span>
                        </button>
                        {/* Who can open this Solution. A Solution is not a
                            project workspace, so its members are managed here
                            rather than on /app/projects. */}
                        <button
                            onClick={() => setDialog('access')}
                            data-testid="solution-manage-access"
                            aria-label={t('solutions.manage_access', 'Manage access')}
                            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] border border-[var(--border-default)] text-[var(--text-secondary)]"
                        >
                            <Users className="w-3.5 h-3.5" aria-hidden="true" />
                            <span className={OBJHEAD_FOLD.action}>{t('solutions.manage_access', 'Manage access')}</span>
                        </button>
                    </>
                }
            />

            <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="max-w-3xl mx-auto px-6 py-5 space-y-5">
                    {/* Boven elke tab, want "er is een nieuwere versie" gaat over
                        de Oplossing en niet over het tabblad dat toevallig open
                        staat. Alleen de eigenaar kan hem toepassen — dezelfde
                        rol die de route eist — dus alleen die krijgt de knop. */}
                    <UpdateBanner
                        availability={availability}
                        onOpen={isOwner ? () => setDialog('upgrade') : undefined}
                    />
                    {tab === 'content' && (
                        <SolutionContentTable
                            projectId={project.id}
                            resources={data.resources}
                            loading={data.resourcesLoading}
                            role={role}
                            currentUserId={currentUserId}
                            graph={data.graph}
                            completeness={data.completeness}
                            onOpen={(kind, item) => OPEN_PATH[kind] && window.location.assign(OPEN_PATH[kind](item.id))}
                            onRemove={removeResource}
                            onAdded={() => { fetchResources(); fetchGraph(); fetchCompleteness(); }}
                        />
                    )}
                    {tab === 'control' && (
                        <SolutionControlPanel
                            completeness={data.completeness}
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

            {/* The audience capsule reads the member list, so it is re-read
                when the dialog closes. Leaving the Solution from the panel
                ends access to all of it: back to the overview, which
                re-reads the list without it. */}
            <SolutionAccessDialog
                open={dialog === 'access'}
                onClose={() => { setDialog(null); fetchMembers(); }}
                onLeft={() => { setDialog(null); onBack(); }}
                projectId={project.id}
                projectName={name}
                role={role}
                currentUserId={currentUserId || null}
            />

            <SolutionExportDialog
                open={dialog === 'export' || dialog === 'publish'}
                onClose={() => { setDialog(null); fetchBlueprints(); fetchReleases(); }}
                projectId={project.id}
                projectName={name}
                role={role}
                mode={dialog === 'publish' ? 'publish' : 'export'}
                completeness={data.completeness}
            />

            {/* `blueprintId` komt uit `availability`, en dat veld is alleen
                gevuld als de Blueprint in de org-gescoopte lijst gevonden is —
                er valt hier dus geen plan op te vragen voor een id dat de scope
                niet passeerde. De server controleert het daarna nog een keer:
                de aanroep stuurt het id, nooit een manifest. */}
            <UpgradeDialog
                open={dialog === 'upgrade'}
                onClose={() => setDialog(null)}
                projectId={project.id}
                blueprintId={availability.blueprintId}
                latestVersion={availability.latestVersion}
                onDone={() => {
                    fetchResources();
                    fetchGraph();
                    fetchCompleteness();
                }}
            />
        </div>
    );
}

