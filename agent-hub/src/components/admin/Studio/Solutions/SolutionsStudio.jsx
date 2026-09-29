import React, { useCallback, useEffect, useState } from 'react';
import SolutionDetail from './SolutionDetail';
import { readSummary } from './solutionOverviewModel';
import SolutionsOverview from './SolutionsOverview';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import useRemote from '../../../projects/useRemote';

/**
 * Studio → Solutions: the BUILDER's view of a project.
 *
 * A Solution is not a new entity — it is a project, seen as the thing it
 * bundles: the routines, apps, webpages and approvals that work together, how
 * they are wired (Flow), and the Blueprint you package it into. The
 * collaboration side of the same project — chats, members, memory — stays on
 * /app/projects, which is where people who USE the solution live. Builders
 * live here, next to Automations, Apps and Webpages, because a Solution is
 * built out of exactly those.
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
function activeProject(activeId, listed, fetched) {
    if (!activeId) return null;
    return listed
        || (Array.isArray(fetched) ? fetched.find(p => p && p.id === activeId) : null)
        || { id: activeId, name: '…' };
}

export default function SolutionsStudio({ user, initialSolutionId = null, onNavigate }) {
    const [summary, setSummary] = useState({ status: 'loading', rows: [], unavailable: [], hasMore: false });
    const [activeId, setActiveId] = useState(initialSolutionId || null);

    const fetchSummary = useCallback(async () => {
        try {
            const res = await authFetch(`${API_BASE}/api/projects/summary`);
            const body = await res.json().catch(() => null);
            // The route's own 500 path carries the same shape with an empty
            // list, so a client that ignored the status would render a clean
            // overview. The status is not ignored here.
            if (!res.ok) { setSummary(NOTHING_READ); return; }
            setSummary({ status: 'ok', ...readSummary(body) });
        } catch {
            setSummary(NOTHING_READ);
        }
    }, []);
    useEffect(() => { fetchSummary(); }, [fetchSummary]);

    // A deep link arriving while mounted (sidebar navigation) still lands.
    useEffect(() => { setActiveId(initialSolutionId || null); }, [initialSolutionId]);

    const open = (p) => {
        setActiveId(p.id);
        onNavigate?.(`studio/solutions/${p.id}`);
    };
    const back = () => {
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

    const active = activeProject(activeId, listed, byId.data?.projects);

    return active
        ? <SolutionDetail project={active} onBack={back} currentUserId={user?.id || null} />
        : (
            <SolutionsOverview
                summary={summary}
                onOpen={open}
                onCreated={open}
                onInstalled={(id) => open({ id })}
            />
        );
}
