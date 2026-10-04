import { Activity, Boxes, Download, GitBranch, History, LayoutDashboard, Rocket, Settings, ShieldCheck } from 'lucide-react';
import { useCallback, useState } from 'react';
import { isBlocking } from './SolutionControlPanel';
import useProjectStream from '../../../../hooks/useProjectStream';
import { API_BASE, authFetch } from '../../../../utils/helpers';

/**
 * The data side of the Solution detail screen: the fetches, the live feed and
 * the tab definitions. Split out of SolutionDetail.jsx so that file keeps only
 * the screen itself.
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
export const OPEN_PATH = {
    notebook: (id) => `/app/studio/documents/notebook/${id}`,
    app: (id) => `/app/apps/${id}`,
    automation: (id) => `/app/automations/${id}`,
    webpage: (id) => `/app/studio/webpages/${id}`,
    approval: (id) => `/app/studio/approvals/${id}`,
};

/**
 * Overview's activity rows, without the member directory. The full formatter
 * (actor names, target names) needs the directory the project page loads for
 * its Members tab; here a readable action beats loading all of that.
 */
export function humanizeActivity(item) {
    const text = String(item.action || '').replace(/[._]/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Everything the detail view fetches, plus the live-feed wiring. */
export function useSolutionData(projectId) {
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
export const SUB_TABS = [
    { id: 'content', labelKey: 'solutions.tab_content', fallback: 'Content', icon: Boxes },
    // Only for Dev, and only while the pipeline read says the caller has a Dev
    // role or could not be read (see `showPipelineTab`); a Solution that cannot
    // have stages has no such tab.
    { id: 'pipeline', labelKey: 'solution_stages.title', fallback: 'Pipeline', icon: Rocket },
    { id: 'control', labelKey: 'solutions.tab_control', fallback: 'Check', icon: ShieldCheck },
    { id: 'versions', labelKey: 'solutions.tab_versions', fallback: 'Versions', icon: History },
    { id: 'installs', labelKey: 'solutions.tab_installs', fallback: 'Installs', icon: Download },
    { id: 'flow', labelKey: 'solutions.tab_flow', fallback: 'Flow', icon: GitBranch },
    { id: 'overview', labelKey: 'solutions.tab_overview', fallback: 'Overview', icon: LayoutDashboard },
];

/**
 * A UAT or Production stage has its own, shorter strip: what runs there now,
 * the locked content, how it is wired (Settings) and what was deployed.
 */
export const STAGE_TABS = [
    { id: 'status', labelKey: 'solution_stages.tab_status', fallback: 'Status', icon: Activity },
    { id: 'content', labelKey: 'solutions.tab_content', fallback: 'Content', icon: Boxes },
    { id: 'settings', labelKey: 'stage_settings.tab', fallback: 'Settings', icon: Settings },
    { id: 'flow', labelKey: 'solutions.tab_flow', fallback: 'Flow', icon: GitBranch },
    { id: 'history', labelKey: 'solution_stages.tab_history', fallback: 'History', icon: History },
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
