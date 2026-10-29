// @typecheck
const { initDB, getOne, getAll } = require('./core');
const { JOURNEY_LATERAL, JOURNEY_HEAD_ONLY, ORG_SCOPE_JOIN, buildRunFilterWhere } = require('./runsFilter');

/**
 * Facet counts for the executions filter chips, over the SAME filtered set as
 * the list (minus the dimension being counted is NOT excluded here — the counts
 * reflect the active filter, n8n-style). Returns
 * { status, triggerKind, automationId, errorClass } maps of value→count, plus
 * `automations`: the per-automation rollup the Studio "Now running · last 24
 * hours" strip is drawn from.
 *
 * The rollup rides along in the SAME scan rather than in a second query: the
 * four maps above already visit every matching row, so the extra columns cost
 * three values per row and no additional pass. It is CAPPED (most recently
 * active first) with `automationsTotal` beside it, so a busy organisation
 * hands back a strip-sized list and an honest total instead of a thousand
 * entries nothing will draw.
 */
const RUN_FACET_AUTOMATIONS_CAP = 40;

async function getRunFacetsScoped(scope, filters = {}) {
    await initDB();
    const where = buildRunFilterWhere(scope, filters, 1);
    const rows = await getAll(
        `SELECT COALESCE(j.status, r.status) AS status, r.trigger_kind, r.automation_id,
                COALESCE(j.error_class, r.error_class) AS error_class,
                a.title AS automation_title, a.kind AS automation_kind,
                r.started_at
           FROM automation_runs r
           JOIN automations a ON a.id = r.automation_id${where.joinUsers ? ORG_SCOPE_JOIN : ''}${JOURNEY_LATERAL}
          WHERE ${where.clause}`,
        where.params,
    );
    const facets = { status: {}, triggerKind: {}, automationId: {}, errorClass: {} };
    /**
     * @param {string} bucket
     */
    const bump = (bucket, /** @type {string | number | null} */ key) => { if (key == null) return; facets[bucket][key] = (facets[bucket][key] || 0) + 1; };
    const byAutomation = new Map();
    for (const r of rows) {
        bump('status', r.status);
        bump('triggerKind', r.trigger_kind);
        bump('automationId', r.automation_id);
        bump('errorClass', r.error_class);
        if (r.automation_id == null) continue;
        let roll = byAutomation.get(r.automation_id);
        if (!roll) {
            roll = {
                automationId: r.automation_id,
                title: r.automation_title || null,
                kind: r.automation_kind || 'automation',
                total: 0,
                status: {},
                lastRunAt: null,
                lastErrorAt: null,
                // The error CLASS, never the free-text message. The strip is a
                // one-line-per-automation summary and, in the org scope, a summary
                // of somebody ELSE's run: a class ('HttpError', 'Timeout') says
                // what broke, a message can quote a customer.
                lastErrorClass: null,
            };
            byAutomation.set(r.automation_id, roll);
        }
        roll.total += 1;
        if (r.status != null) roll.status[r.status] = (roll.status[r.status] || 0) + 1;
        const at = r.started_at ? new Date(r.started_at).toISOString() : null;
        if (at && (!roll.lastRunAt || at > roll.lastRunAt)) roll.lastRunAt = at;
        if (r.status === 'error' && at && (!roll.lastErrorAt || at > roll.lastErrorAt)) {
            roll.lastErrorAt = at;
            roll.lastErrorClass = r.error_class || null;
        }
    }
    const automations = [...byAutomation.values()]
        .sort((x, y) => String(y.lastRunAt || '').localeCompare(String(x.lastRunAt || '')));
    facets.automationsTotal = automations.length;
    facets.automations = automations.slice(0, RUN_FACET_AUTOMATIONS_CAP);
    return facets;
}

/** The unchanged user-scoped facets — every pre-existing caller's entry point. */
async function getRunFacetsForUser(userId, filters = {}) {
    return getRunFacetsScoped({ user: { userId } }, filters);
}

/** One automation's facets (handoff 5): scoped like listRunsForAutomation. */
async function getRunFacetsForAutomation(automationId, filters = {}) {
    return getRunFacetsScoped({ automation: { automationId } }, filters);
}

/** The ORGANISATION-wide facets (Track H2). Same shape, proven org scope. */
async function getRunFacetsForOrg(orgId, filters = {}) {
    return getRunFacetsScoped({ org: { orgId } }, filters);
}

/**
 * How many runs the caller started in a window — the Studio rail's "Runs n".
 *
 * Deliberately the CALLER's own runs and nothing else: the rail row it feeds
 * opens a section whose default scope is "my runs", and a number counted over
 * a wider set than the list it labels is the whole reason routes/studio/
 * counts.js insists that every key is counted with its own list's scoping.
 *
 * Journey heads only, exactly like the list — a form that pauses and continues
 * is ONE run in the table and must be one here too.
 */
async function getRunCountForUserSince(userId, sinceTs, { mode = 'live' } = {}) {
    await initDB();
    const where = buildRunFilterWhere({ user: { userId } }, { sinceTs, mode }, 1);
    const row = await getOne(
        `SELECT COUNT(*)::int AS n
           FROM automation_runs r
           JOIN automations a ON a.id = r.automation_id${JOURNEY_LATERAL}
          WHERE ${where.clause}`,
        where.params,
    );
    return Number(row?.n) || 0;
}

/**
 * The last few outcomes of each of the caller's OWN automations, newest first.
 *
 * Studio Home's "Needs attention" asks one question of this: is an automation
 * failing over and over? Nothing in the schema answers that today and the
 * three columns that look like they do are all something else —
 * `automation_event_subscriptions.consecutive_failures` counts a TRIGGER's
 * polling failures, `automations.attempts` is the scheduler's retry counter for
 * a stale lock, and `automations.last_status` is one run. A streak has to come
 * from automation_runs.
 *
 * WHAT COMES BACK IS RUNS, NOT A VERDICT, and deliberately: "three failures in
 * a row" is a rule, and a rule that lives in SQL cannot be unit-tested in a
 * container with no Postgres. So this returns the window and
 * routes/studio/attentionChecks.js counts the streak as a pure function over
 * plain objects. The window is per automation (`ROW_NUMBER`), so one busy automation
 * cannot crowd another one out of the answer.
 *
 * Scoping and journey semantics are buildRunFilterWhere's, exactly as
 * getRunCountForUserSince uses them, so this cannot drift from the runs list:
 * the caller's own runs, journey HEADS only (a form that paused and continued
 * is one run, not two), the journey's EFFECTIVE status (a head that handed off
 * as 'success' but whose last leg errored reads as an error), and live mode
 * only — a test run that fails is somebody trying something out.
 *
 * @param {string} userId
 * @param {{ perAutomation?: number, sinceTs?: string|null }} [opts]
 *   perAutomation: window size per automation; sinceTs: ISO lower bound on started_at
 * @returns {Promise<Array<{automationId, title, status}>>} newest first per automation
 */
async function getRecentRunStatusesForUser(userId, { perAutomation = 10, sinceTs = null } = {}) {
    await initDB();
    if (!userId) return [];
    const window = Math.min(Math.max(parseInt(perAutomation, 10) || 10, 1), 50);
    const where = buildRunFilterWhere({ user: { userId } }, { sinceTs, mode: 'live', kind: 'automation' }, 1);
    const params = [...where.params, window];
    const rows = await getAll(
        `SELECT automation_id, title, status FROM (
             SELECT r.automation_id, a.title, COALESCE(j.status, r.status) AS status,
                    ROW_NUMBER() OVER (PARTITION BY r.automation_id
                                       ORDER BY r.started_at DESC NULLS LAST, r.id DESC) AS rn
               FROM automation_runs r
               JOIN automations a ON a.id = r.automation_id${JOURNEY_LATERAL}
              WHERE ${where.clause}
         ) t
         WHERE rn <= $${params.length}
         ORDER BY automation_id, rn`,
        params,
    );
    return (rows || []).map(r => ({
        automationId: r.automation_id,
        title: r.title || null,
        status: r.status || null,
    }));
}

/**
 * "12 runs today, 1 failed" for a whole list of Solutions, in ONE query.
 *
 * ── Why this is not getRunFacetsForUser with a projectId ────────────────────
 *
 * That function is scoped to `r.user_id`, and deliberately: the executions
 * table is MY runs. A Solution's card is a different question — a project is a
 * shared workspace, its Content tab already lists every member's automations under
 * one project role, and a tally that counted only the reader's own runs would
 * say "0 today" on a Solution that ran forty times this morning. So this counts
 * every run of every automation filed into the project.
 *
 * That widening is bounded by the CALLER, not by this query: it counts exactly
 * the project ids it is handed, and the only caller hands it the ids the reader
 * already has a role on. Passing an id nobody checked would leak a tally — the
 * ids are the authorisation, so they are resolved before this is called and
 * never taken from a request.
 *
 * `failed` is the journey's EFFECTIVE status, like every other read here: a run
 * that failed and was continued by a child run reads by what the last leg did,
 * not by the head's stale handoff row.
 *
 * A project with no runs is simply ABSENT from the result — the caller turns a
 * missing key into 0, and a failed read into "unknown". Those must not be the
 * same value, which is why this rejects rather than returning an empty map.
 */
async function getRunCountsForProjects(projectIds, { sinceTs = null } = {}) {
    await initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
    if (!ids.length) return new Map();

    const params = [ids];
    let since = '';
    if (sinceTs) { params.push(sinceTs); since = ` AND r.started_at >= $${params.length}`; }

    const rows = await getAll(
        `SELECT a.project_id,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE COALESCE(j.status, r.status) = 'error')::int AS failed
           FROM automation_runs r
           JOIN automations a ON a.id = r.automation_id${JOURNEY_LATERAL}
          WHERE a.project_id = ANY($1) AND ${JOURNEY_HEAD_ONLY}${since}
          GROUP BY a.project_id`,
        params,
    );
    return new Map((rows || []).map(r => [r.project_id, {
        total: Number(r.total) || 0,
        failed: Number(r.failed) || 0,
    }]));
}

module.exports = { RUN_FACET_AUTOMATIONS_CAP, getRunFacetsForUser, getRunFacetsForAutomation, getRunFacetsForOrg, getRunCountForUserSince, getRecentRunStatusesForUser, getRunCountsForProjects };
