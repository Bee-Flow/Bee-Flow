/**
 * One card per Solution: what is in it, whether it is healthy, whether it ran
 * today, and whether the Blueprint it came from has moved on.
 *
 * ── This module authorises NOTHING ─────────────────────────────────────────
 *
 * It is handed the project rows the caller may already see — the output of
 * projectStore.listUserProjects, which is owner + shares — and never widens
 * that set, never re-reads it, and never takes an id from a request. Everything
 * below is a tally over ids that were authorised before this was called. That
 * is the whole security argument, and it lives here rather than being spread
 * over four store calls: pass this function an id nobody checked and it will
 * cheerfully count it.
 *
 * ── null is not zero, and the difference is the point ──────────────────────
 *
 * The overview is the screen where a Solution looks fine. So every number it
 * shows has to be able to say "I could not find out":
 *
 *   counts.apps === null      the app store could not be read
 *   counts.apps === 0         the store answered, and there are no apps
 *   runs === null             the run tally failed; NOT "nothing ran today"
 *   completeness === null     nobody checked; NOT "nothing wrong"
 *   update === null           we cannot tell; NOT "up to date"
 *
 * Each gap is also NAMED in the row's `unavailable`, and `complete` says
 * whether the card is whole — the same convention GET /:id/resources and
 * GET /:id/graph already keep, applied per project and per field. A client that
 * renders a null as a 0 or a green tick is the bug this shape exists to make
 * obvious.
 *
 * ── Why the counts come from the registry and not from `list` ──────────────
 *
 * projects/membership.js grew a `countIn(projectIds) → Map` hook for this: one
 * query per KIND for the entire overview, instead of one query per kind per
 * project that reads whole rows to throw all but their number away. A kind
 * without a `countIn` is not counted at all rather than being counted the slow
 * way — see the registry header for why knowledge bases and approvals are the
 * two that have none.
 *
 * ── Completeness is injected, and absent by default ────────────────────────
 *
 * Aggregating one project's findings means building its whole graph: six store
 * reads, plus every app's full definition, plus a document count per knowledge
 * base. Doing that for every card on every visit is a page load that scales
 * with how much work a team has done, which is exactly backwards.
 *
 * So the caller passes `completenessFor(projectId)` if it wants it, and this
 * module runs it for at most `completenessBudget` projects with a small
 * concurrency, in the order the projects arrived (newest first, which is the
 * order the cards render). Every project past the budget — and every one whose
 * check threw — gets `completeness: null` and says so. Not computing it is a
 * REPORTED gap, never a clean bill of health.
 */

'use strict';

const membership = require('./membership');
const log = require('../telemetry/log');

/** How many Solutions get their findings aggregated in one request. */
const COMPLETENESS_BUDGET = 24;
/** How many of those run at once. Each one is a fan-out of its own. */
const COMPLETENESS_CONCURRENCY = 4;
/** The deployment statuses that hold a stage: running, or waiting for an approval. */
const BUSY_DEPLOYMENT_STATUSES = Object.freeze(['awaiting_approval', 'queued', 'approved', 'preparing', 'committing', 'converging', 'compensating']);

/** Midnight UTC of the day `now` falls in. */
function startOfDayUtc(now = new Date()) {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

/**
 * Run `fn` over `items`, at most `width` at a time, preserving order.
 *
 * A plain Promise.all over twenty projects would open twenty graph builds at
 * once and each of those is itself six parallel store reads.
 */
async function mapLimited(items, width, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker));
    return out;
}

/**
 * Tally every countable kind across the whole list, one query per kind.
 *
 * A kind whose query rejects is `null` for EVERY project rather than 0 for
 * every project: the read failed for all of them, and none of them may claim
 * to be empty because of it.
 *
 * @returns {Promise<{ bySection: Map<string, Map<string, number>|null>, failed: string[] }>}
 */
async function countMembers(projectIds) {
    const kinds = membership.countableKinds();
    const bySection = new Map();
    const failed = [];
    await Promise.all(kinds.map(async (kind) => {
        try {
            const counts = await kind.countIn(projectIds);
            bySection.set(kind.section, counts instanceof Map ? counts : new Map(Object.entries(counts || {})));
        } catch (err) {
            log.warn(`[Projects] summary: could not count ${kind.section}:`, err.message);
            bySection.set(kind.section, null);
            failed.push(kind.section);
        }
    }));
    return { bySection, failed };
}

/**
 * Is there a newer Blueprint than what this Solution has been brought to?
 *
 * Three unknowns, and all three answer `null` rather than "no":
 *
 *   - the project was not installed from a Blueprint at all;
 *   - it was, but the Blueprint is not in `readable` — deleted, or belonging to
 *     an organisation this reader is not in. A missing Blueprint must never
 *     read as "up to date", and it must not confirm the existence of one this
 *     reader may not see either, which is why `readable` is the org-scoped
 *     listing rather than a lookup by id;
 *   - it was, but nothing recorded which version it was installed at.
 */
function updateStatusFor(project, readable, installedVersions) {
    const blueprintId = project.installedFromBlueprintId || null;
    if (!blueprintId) return null;

    const blueprint = readable ? readable.get(blueprintId) : undefined;
    const installedVersion = installedVersions ? installedVersions.get(project.id) : undefined;
    if (!blueprint || !Number.isFinite(installedVersion)) {
        return { blueprintId, available: null, installedVersion: installedVersion ?? null, latestVersion: null };
    }

    const { isNewer } = require('./packaging/upgrade');
    const latestVersion = blueprint.version;
    return {
        blueprintId,
        name: blueprint.name,
        installedVersion,
        latestVersion,
        available: isNewer({ installedVersion, blueprintVersion: latestVersion }),
    };
}

/**
 * The stages of these Solutions, one query over solution_stages with the latest
 * deployment of each stage joined in: `Map(solutionId → [{ stage, projectId,
 * currentReleaseSeq, lastDeploymentStatus, pending }])`, UAT first. Counts and
 * statuses only. `pending` = a deployment is running or waits for an approval.
 * A Solution without stages has no entry.
 *
 * @param {string[]} solutionIds  ALREADY-AUTHORISED ids
 * @param {{ query?: (sql: string, params: any[]) => Promise<any> }} [io]  replaceable for a test
 * @returns {Promise<Map<string, Array<{ stage: string, projectId: string, currentReleaseSeq: number|null,
 *   lastDeploymentStatus: string|null, pending: boolean }>>>}
 */
async function stagesForSolutions(solutionIds, io = {}) {
    const ids = (Array.isArray(solutionIds) ? solutionIds : []).filter(id => typeof id === 'string' && id);
    const out = new Map();
    if (!ids.length) return out;
    const query = io.query || ((sql, params) => require('../db').run(sql, params));
    const res = await query(
        `SELECT s.solution_id, s.stage, s.project_id, s.current_release_seq, d.status AS last_status
           FROM solution_stages s
           LEFT JOIN LATERAL (
               SELECT status FROM solution_deployments
                WHERE stage_project_id = s.project_id
                ORDER BY created_at DESC, id DESC LIMIT 1
           ) d ON TRUE
          WHERE s.solution_id = ANY($1::text[])
          ORDER BY s.solution_id, CASE s.stage WHEN 'uat' THEN 0 ELSE 1 END`,
        [ids],
    );
    for (const row of (Array.isArray(res) ? res : (res && res.rows) || [])) {
        const list = out.get(row.solution_id) || [];
        list.push({
            stage: row.stage,
            projectId: row.project_id,
            currentReleaseSeq: Number.isInteger(row.current_release_seq) ? row.current_release_seq : null,
            lastDeploymentStatus: row.last_status || null,
            pending: BUSY_DEPLOYMENT_STATUSES.includes(row.last_status),
        });
        out.set(row.solution_id, list);
    }
    return out;
}

const STAGE_NAME_SUFFIX = /\s+\((?:UAT|Production)\)$/;

/**
 * The stage rows a person can reach whose Dev Solution is NOT in `visibleIds`:
 * a stage-only operator has no Dev role, so without this list they would have no
 * entry point to the stage they run. `stageProjects` is the project listing
 * (listUserProjects with `kind: 'solution', onlyStages: true`), which is the
 * authorisation; the Solution is named after its stage (the stage project is
 * "<Solution> (UAT)"), so no Dev row is read.
 *
 * @param {object[]} stageProjects
 * @param {Set<string>|string[]} visibleIds  the Dev Solutions the person already sees
 * @returns {Array<{ solutionId: string, solutionName: string, stage: string, projectId: string, role: string }>}
 */
function operatedStagesOf(stageProjects, visibleIds) {
    const visible = visibleIds instanceof Set ? visibleIds : new Set(visibleIds || []);
    const out = [];
    for (const p of Array.isArray(stageProjects) ? stageProjects : []) {
        if (!p || typeof p.id !== 'string' || !p.stageOf || (p.stage !== 'uat' && p.stage !== 'prd')) continue;
        if (visible.has(p.stageOf)) continue;
        out.push({
            solutionId: p.stageOf,
            solutionName: String(p.name || '').replace(STAGE_NAME_SUFFIX, ''),
            stage: p.stage,
            projectId: p.id,
            role: p.permission || 'viewer',
        });
    }
    return out;
}

/**
 * Build the overview.
 *
 * @param {object[]} projects  ALREADY-AUTHORISED rows (listUserProjects shape).
 * @param {object}   [options]
 * @param {object}   [options.viewer]            `{ userId, organizationId }`, for the
 *   Blueprint catalogue read. Without it no update status is computed at all
 *   and every installed Solution reports `available: null`.
 * @param {Function} [options.completenessFor]   `(projectId) => aggregate`, injected
 *   by the route. Absent = not checked, which is reported, not assumed clean.
 * @param {object}   [options.io]                replaceable readers (a test's doubles): `countMembers(ids)`,
 *   `runCounts(ids, { sinceTs })`, `blueprints({ userId, organizationId })`, `installedVersions(ids)`.
 *   Absent = the real stores.
 * @param {Function} [options.stagesFor]         `(solutionIds) => Map(solutionId → stages)`
 *   (see stagesForSolutions). Absent = the cards carry no `stages` key at all;
 *   present but failing = `stages: null` and 'stages' in `unavailable`.
 * @param {Date}     [options.now]
 * @param {Date}     [options.since]             start of "today" for the run tally.
 * @param {number}   [options.completenessBudget]
 */
async function summarizeProjects(projects, {
    viewer = null, completenessFor = null, now = new Date(), since = null,
    completenessBudget = COMPLETENESS_BUDGET, stagesFor = null, io = {},
} = {}) {
    const rows = Array.isArray(projects) ? projects.filter(p => p && typeof p.id === 'string') : [];
    const ids = rows.map(p => p.id);
    const sinceTs = since || startOfDayUtc(now);

    const [members, runs, readable, installedVersions, stagesBySolution] = await Promise.all([
        (io.countMembers || countMembers)(ids),
        (async () => {
            try {
                return await (io.runCounts || ((i, o) => require('../stores/automationStore').getRunCountsForProjects(i, o)))(ids, { sinceTs });
            } catch (err) {
                log.warn('[Projects] summary: could not count runs:', err.message);
                return null;      // null = unreadable, distinct from an empty Map
            }
        })(),
        (async () => {
            if (!viewer?.userId) return null;
            try {
                const list = await (io.blueprints || ((q) => require('../stores/blueprintStore').listBlueprintsFor(q)))({
                    userId: viewer.userId, organizationId: viewer.organizationId || null,
                });
                return new Map((list || []).map(b => [b.id, b]));
            } catch (err) {
                log.warn('[Projects] summary: could not read the Blueprint catalogue:', err.message);
                return null;
            }
        })(),
        (async () => {
            try {
                return await (io.installedVersions || ((i) => require('../stores/blueprintStore').listInstalledVersions(i)))(ids);
            } catch (err) {
                log.warn('[Projects] summary: could not read install stamps:', err.message);
                return null;
            }
        })(),
        (async () => {
            if (typeof stagesFor !== 'function') return undefined;
            try {
                return await stagesFor(ids);
            } catch (err) {
                log.warn('[Projects] summary: could not read the stages:', err.message);
                return null;
            }
        })(),
    ]);

    // Only the head of the list is checked, and only when the caller asked for
    // checking at all. Everything else is honestly `null`.
    const checkable = completenessFor ? rows.slice(0, Math.max(0, completenessBudget)) : [];
    const checked = await mapLimited(checkable, COMPLETENESS_CONCURRENCY, async (project) => {
        try {
            const result = await completenessFor(project.id);
            const findings = Array.isArray(result?.findings) ? result.findings : [];
            return {
                // `blocked` and `complete` are the aggregator's own verdicts and
                // are copied, never recomputed — a second opinion about whether
                // a Solution may publish is a second opinion that can differ.
                blocked: result?.blocked !== false,
                complete: result?.complete === true,
                findings: findings.length,
                errors: findings.filter(f => f?.severity === 'error').length,
                warnings: findings.filter(f => f?.severity === 'warning').length,
                unavailable: Array.isArray(result?.unavailable) ? result.unavailable : [],
            };
        } catch (err) {
            log.warn(`[Projects] summary: could not check ${project.id}:`, err.message);
            return null;
        }
    });
    const completenessById = new Map(checkable.map((p, i) => [p.id, checked[i]]));

    const out = rows.map((project) => {
        const unavailable = [...members.failed];

        const counts = {};
        for (const [section, map] of members.bySection) {
            counts[section] = map ? (map.get(project.id) || 0) : null;
        }
        // Knowledge bases are the one membership that is an array on the PROJECT
        // row rather than a column on theirs, so the count is already in hand —
        // and it is a count of LINKS, which is what the project asserts. A link
        // to a base that has since been deleted still counts as a link; the
        // Content tab is where that is resolved.
        counts.knowledgeBases = Array.isArray(project.knowledgeBaseIds) ? project.knowledgeBaseIds.length : null;
        if (counts.knowledgeBases === null) unavailable.push('knowledgeBases');

        const runCount = runs ? (runs.get(project.id) || { total: 0, failed: 0 }) : null;
        if (!runs) unavailable.push('runs');

        const completeness = completenessById.get(project.id) || null;
        if (!completeness) unavailable.push('completeness');

        const update = updateStatusFor(project, readable, installedVersions);
        if (update && update.available === null) unavailable.push('update');

        // UAT / PRD of this Solution. A failed read is null (not "no stages") and named.
        if (stagesBySolution === null) unavailable.push('stages');

        return {
            id: project.id,
            name: project.name,
            description: project.description || '',
            icon: project.icon || null,
            color: project.color || null,
            ownerId: project.ownerId,
            organizationId: project.organizationId || null,
            permission: project.permission || 'viewer',
            updatedAt: project.updatedAt || null,
            createdAt: project.createdAt || null,
            // The three tabs of the overview are read off these two fields plus
            // the caller's own id: mine = owner, installed = came from a
            // Blueprint, and the catalogue is the Blueprint list itself.
            installedFromBlueprintId: project.installedFromBlueprintId || null,
            counts,
            runs: runCount && { today: runCount.total, failed: runCount.failed },
            completeness,
            update,
            ...(stagesBySolution === undefined ? {} : { stages: stagesBySolution ? (stagesBySolution.get(project.id) || []) : null }),
            unavailable,
            complete: unavailable.length === 0,
        };
    });

    return {
        projects: out,
        // The gaps that hit every card at once, so a client can say "run counts
        // are unavailable" once instead of on twenty cards.
        unavailable: [
            ...members.failed,
            ...(runs ? [] : ['runs']),
            ...(installedVersions ? [] : ['installedVersions']),
            ...(viewer?.userId && !readable ? ['blueprints'] : []),
            ...(stagesBySolution === null ? ['stages'] : []),
        ],
        checkedCount: checkable.length,
        completenessBudget,
    };
}

module.exports = {
    summarizeProjects,
    stagesForSolutions,
    operatedStagesOf,
    countMembers,
    updateStatusFor,
    startOfDayUtc,
    mapLimited,
    COMPLETENESS_BUDGET,
};
