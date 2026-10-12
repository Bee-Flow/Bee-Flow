import React, { useCallback, useEffect, useState } from 'react';
import { operatedStagesOf } from './pipeline/stagesApi';
import SolutionDetail from './SolutionDetail';
import { readSummary } from './solutionOverviewModel';
import SolutionsOverview from './SolutionsOverview';
import useRemote from './useRemote';
import { API_BASE, authFetch } from '../../../../utils/helpers';

/**
 * Studio → Solutions: the builder's bundles.
 *
 * A Solution is the thing a builder packages: the automations, apps, webpages and
 * approvals that work together, how they are wired (Flow), and the Blueprint
 * you package it into. It is stored in the same table as the collaborative
 * project workspaces (so ids, Blueprint keys and shares keep working), but it
 * is a separate concept: its row carries `kind: 'solution'`, the summary this
 * screen reads lists only Solutions (and rows from before the split nobody has
 * classified yet), and /app/projects lists none of them. Builders live here,
 * next to Automations, Apps and Webpages, because a Solution is built out of
 * exactly those.
 *
 * This file owns only the seam: one read, and the choice between the overview
 * and one Solution's detail. The overview itself is SolutionsOverview and the
 * tabs are its business.
 *
 * ── Why /summary and not /api/projects ─────────────────────────────────────
 *
 * The cards say more than a name: what each Solution holds, whether its checks
 * found anything, whether it ran today, whether the Blueprint it came from has
 * moved on. GET /api/projects/summary answers all of that in one request, and —
 * the part that matters — answers `null` for anything it could not read, so the
 * screen can tell "none" from "could not find out". A plain listing would have
 * meant a fan-out per card and no way to say the second thing.
 *
 * A FAILED READ IS NOT AN EMPTY WORKSPACE. `status` is carried beside the rows
 * for exactly that reason: every empty state downstream is reachable only from
 * `status: 'ok'`.
 */

const NOTHING_READ = { status: 'error', rows: [], unavailable: ['all'], hasMore: false };

/**
 * Which row the detail view renders: the one the overview listed, the one asked
 * for by id, or a placeholder that at least carries the id.
 *
 * The placeholder is the last resort rather than the first: a Solution nobody
 * could name still opens, and its own tabs report their own failures.
 */
function activeProject(activeId, listed, fetched, operated) {
    if (!activeId) return null;
    return listed
        || (Array.isArray(fetched) ? fetched.find(p => p && p.id === activeId) : null)
        // A stage-only operator cannot read the Dev row, but the summary named it.
        || { id: activeId, name: operated?.find(o => o.solutionId === activeId)?.solutionName || '…' };
}

/**
 * `studio/solutions/new` is the Studio's "+ New → Solution" entry, not the id of
 * a Solution (F16): it opens the overview with the create form ready.
 */
const CREATE_SEGMENT = 'new';
const idFromRoute = (id) => (id && id !== CREATE_SEGMENT ? id : null);

export default function SolutionsStudio({ user, initialSolutionId = null, onNavigate }) {
    const [summary, setSummary] = useState({ status: 'loading', rows: [], unavailable: [], hasMore: false });
    const [activeId, setActiveId] = useState(idFromRoute(initialSolutionId));
    // The stage a stage-only operator asked for from the overview; a deep link
    // carries its own `?stage=`, which SolutionDetail reads itself.
    const [stageIntent, setStageIntent] = useState(null);

    const fetchSummary = useCallback(async () => {
        try {
            const res = await authFetch(`${API_BASE}/api/projects/summary`);
            const body = await res.json().catch(() => null);
            // The route's own 500 path carries the same shape with an empty
            // list, so a client that ignored the status would render a clean
            // overview. The status is not ignored here.
            if (!res.ok) { setSummary(NOTHING_READ); return; }
            setSummary({ status: 'ok', ...readSummary(body), operatedStages: operatedStagesOf(body?.operatedStages) });
        } catch {
            setSummary(NOTHING_READ);
        }
    }, []);
    useEffect(() => { fetchSummary(); }, [fetchSummary]);

    // A deep link arriving while mounted (sidebar navigation) still lands.
    useEffect(() => { setActiveId(idFromRoute(initialSolutionId)); }, [initialSolutionId]);

    const open = (p) => {
        setStageIntent(null);
        setActiveId(p.id);
        onNavigate?.(`studio/solutions/${p.id}`);
    };
    const openStage = (entry) => {
        setStageIntent(entry.stage);
        setActiveId(entry.solutionId);
        onNavigate?.(`studio/solutions/${entry.solutionId}`);
    };
    const back = () => {
        setStageIntent(null);
        setActiveId(null);
        onNavigate?.('studio/solutions');
        fetchSummary();
    };

    // A DEEP LINK CAN NAME A SOLUTION THE OVERVIEW DID NOT LIST. /summary is
    // capped, so on a workspace with more Solutions than the cap the row for
    // the one being opened may simply not be in hand — and the header would sit
    // on "…" forever. `?ids=` can only INTERSECT the caller's own list, so
    // asking for one by id reaches nothing listUserProjects had not already
    // allowed; it is a narrowing of the same read, not a second door.
    const listed = activeId ? summary.rows.find(p => p.id === activeId) : null;
    const wanted = activeId && summary.status === 'ok' && !listed ? activeId : null;
    const byId = useRemote(
        wanted ? `${API_BASE}/api/projects/summary?ids=${encodeURIComponent(wanted)}&checks=0` : null,
        !!wanted,
    );

    const active = activeProject(activeId, listed, byId.data?.projects, summary.operatedStages);

    return active
        ? <SolutionDetail key={active.id} project={active} onBack={back} currentUserId={user?.id || null} initialStage={stageIntent} />
        : (
            <SolutionsOverview
                summary={summary}
                onOpen={open}
                onOpenStage={openStage}
                onCreated={open}
                onInstalled={(id) => open({ id })}
                onRetry={() => { setSummary({ status: 'loading', rows: [], unavailable: [], hasMore: false }); fetchSummary(); }}
                focusCreate={initialSolutionId === CREATE_SEGMENT}
            />
        );
}
