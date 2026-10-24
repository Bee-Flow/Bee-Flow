// @typecheck
/**
 * runs.js — automationStore aggregate (§WS5, extracted verbatim).
 */

const crypto = require('crypto');
const { initDB, run, getOne, getAll, pool } = require('./core');
const { rowToRun, fromJsonb } = require('./rowMappers');
const { buildUpdate } = require('../lib/sqlBuilder');
const { projectOrgRun } = require('./orgRunRow');
const { JOURNEY_LATERAL, ORG_SCOPE_JOIN, buildRunFilterWhere } = require('./runsFilter');
const { RUN_FACET_AUTOMATIONS_CAP, getRunFacetsForUser, getRunFacetsForAutomation, getRunFacetsForOrg, getRunCountForUserSince, getRecentRunStatusesForUser, getRunCountsForProjects } = require('./runsStats');
const { recordRunStep, recordRunStepWith, getRunSteps, getRunsInChain, getRunStepsForChain, getLatestRunInChain, getRunStepsForRuns } = require('./runsSteps');
const { bestEffort } = require('../../utils/bestEffort');

// ── Runs ───────────────────────────────────────────────

/**
 * `rootRunId` names the JOURNEY this run belongs to (see the
 * automation-run-root-2026-08 migration). Omit it and the run is its own root,
 * which is right for every fresh trigger and for a retry. Only a run that
 * CONTINUES a paused one passes its parent's root, and that is what collapses a
 * multi-page form's child runs into a single row in the history.
 */
async function createRun({ automationId, version, userId, triggerKind, triggerPayload = null, mode = 'live', parentRunId = null, rootRunId = null, rootStepId = null, isTest = false, startedByUserId = null, callerAgentId = null, callerConversationId = null, connectionsMode = null }) {
    await initDB();
    const id = crypto.randomUUID();
    // `rootStepId` — the trigger node this run entered through (NULL = the
    // primary trigger). Persisted so a resume after a pause re-enters the SAME
    // entry point; see automation-multi-trigger-2026-09.
    // `isTest` / `startedByUserId` / `callerAgent*` — handoff 5
    // (automation-handoff5-2026-09): a Test-button run of the working copy,
    // who pressed the button, and which agent conversation started the run.
    await run(
        `INSERT INTO automation_runs (id, automation_id, version, user_id, trigger_kind, trigger_payload, mode, status, started_at, parent_run_id, root_run_id, root_step_id,
                                      is_test, started_by_user_id, caller_agent_id, caller_conversation_id, connections_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',NOW(),$8,COALESCE($9,$1),$10,$11,$12,$13,$14,$15)`,
        [id, automationId, version, userId, triggerKind, triggerPayload ? JSON.stringify(triggerPayload) : null, mode, parentRunId, rootRunId, rootStepId || null,
            !!isTest, startedByUserId || null, callerAgentId || null, callerConversationId || null,
            connectionsMode === 'caller' ? 'caller' : null],
    );
    return getRun(id);
}

/**
 * Mark a run as cancel-requested. The runner reads this flag between steps
 * and short-circuits with status='cancelled'. Returns the updated row, or
 * null if no row matched.
 */
async function requestCancelRun(runId) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE automation_runs
            SET cancel_requested = TRUE
          WHERE id = $1
            AND status IN ('queued', 'running')
          RETURNING *`,
        [runId],
    );
    return rowToRun(rows[0]);
}

async function getRun(id) {
    await initDB();
    const r = await getOne('SELECT * FROM automation_runs WHERE id = $1', [id]);
    return rowToRun(r);
}

async function getRunsForAutomation(automationId, { limit = 50 } = {}) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM automation_runs WHERE automation_id = $1 ORDER BY started_at DESC NULLS LAST LIMIT $2',
        [automationId, limit],
    );
    return rows.map(rowToRun);
}

// Map a run row (joined to its automation) to the FE shape used by the
// executions table: the base run + the automation's title/kind/icon/trigger so
// the table can show a Name column and badge Steps vs Automations.
/**
 * @param {any} r  automation_runs row joined to its automation
 * @returns {Record<string, any>}  the run shape plus automation fields and, for a journey, journeyRunId
 */
function rowToRunWithAutomation(r) {
    const base = {
        ...rowToRun(r),
        automationTitle: r.automation_title || null,
        automationKind: r.automation_kind || 'automation',
        automationIcon: r.automation_icon || null,
        automationTriggerType: r.automation_trigger_type || null,
        rootTriggerLabel: r.root_trigger_label || null,
    };
    // A journey's head row is finished the moment it hands off to the run that
    // continues it, so reporting the head's own status would tell a visitor's
    // half-answered form "Finished — Resumed from the form — see child run …".
    // The outcome shown is the newest leg's; `journeyRunId` is the leg that
    // Stop/Approve must actually act on, which is not the row's own id.
    if (!r.journey_run_id) return base;
    return {
        ...base,
        journeyRunId: r.journey_run_id,
        status: r.journey_status || base.status,
        finishedAt: r.journey_finished_at ? new Date(r.journey_finished_at).toISOString() : null,
        durationMs: r.journey_duration_ms != null ? Number(r.journey_duration_ms) : null,
        summary: r.journey_summary ?? null,
        error: r.journey_error ?? null,
        errorClass: r.journey_error_class ?? null,
        handledErrorCount: r.journey_handled_error_count ?? 0,
        // Handoff 5: the sentence belongs to the leg that ran last, too.
        outcome: r.journey_outcome_json !== undefined ? (fromJsonb(r.journey_outcome_json) ?? null) : base.outcome,
    };
}

/** The org-scoped row: an explicit allow-list, see orgRunRow.js. */
function rowToOrgRunRow(r, viewerUserId = null) {
    return projectOrgRun(rowToRunWithAutomation(r), viewerUserId);
}

// Encode/decode an opaque keyset cursor — (started_at, id) of the last row on
// the page. Base64url JSON keeps it tamper-evident-ish and URL-safe; a bad
// cursor decodes to null so the caller falls back to page 1 (never a 500).
function encodeRunCursor(row) {
    if (!row || !row.started_at) return null;
    // Prefer the FULL-microsecond-precision string the query selects as
    // `started_at_cursor`. node-postgres parses timestamptz into a JS Date
    // (millisecond precision), so encoding from `row.started_at` alone drops
    // the µs — and then the keyset `(started_at,id) < (cursor)` comparison
    // skips rows that share a millisecond but differ in microseconds. With the
    // full-precision string the boundary is exact.
    const s = row.started_at_cursor || new Date(row.started_at).toISOString();
    const payload = { s, i: row.id };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
function decodeRunCursor(cursor) {
    if (!cursor || typeof cursor !== 'string') return null;
    try {
        const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (o && o.s && o.i) return { startedAt: o.s, id: o.i };
    } catch (err) { bestEffort('stores/automationStore/runs:decodeRunCursor', err); /* fall through */ }
    return null;
}

/**
 * Cross-automation / scoped run list, newest-first, with keyset (cursor)
 * pagination + server-side filters. Powers the n8n-style executions table for
 * the global view, a single automation, and a single Step (the Step's runs are
 * just automation_runs with automation_id = the block id).
 *
 * `scope` is buildRunFilterWhere's — `{ user: { userId } }` or
 * `{ org: { orgId } }`, and nothing else gets a row back.
 *
 * Returns { runs, nextCursor }. JOINs automations for title/kind/icon/trigger.
 *
 * `project` is the row mapper, and it is a PARAMETER because the two scopes
 * hand back different fields on purpose — see rowToOrgRunRow.
 *
 * @param {any} scope
 * @param {any} [filters]
 * @param {(row: any) => any} [project]
 */
async function listRunsScoped(scope, filters = {}, project = rowToRunWithAutomation) {
    await initDB();
    const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 50, 1), 100);
    const where = buildRunFilterWhere(scope, filters, 1);
    const params = [...where.params];
    let clause = where.clause;
    let idx = where.nextIdx;

    // Keyset: rows strictly older than the cursor in (started_at DESC, id DESC).
    const cur = decodeRunCursor(filters.cursor);
    if (cur) {
        clause += ` AND (r.started_at, r.id) < ($${idx}, $${idx + 1})`;
        params.push(cur.startedAt, cur.id);
        idx += 2;
    }

    const rows = await getAll(
        `SELECT r.*, a.title AS automation_title, a.kind AS automation_kind,
                a.icon AS automation_icon, a.trigger_type AS automation_trigger_type,
                -- The ADDITIONAL trigger a multi-trigger run entered through, by
                -- its node label (falling back to its event or kind). NULL for
                -- primary-trigger runs and legacy rows; read off the CURRENT
                -- definition — a renamed trigger reads by its new name, a
                -- removed one shows nothing rather than a stale label.
                (SELECT COALESCE(NULLIF(t->>'label', ''), t->'appEvent'->>'event', t->>'kind')
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.definition_json->'triggers') = 'array'
                                                  THEN a.definition_json->'triggers' ELSE '[]'::jsonb END) t
                  WHERE r.root_step_id IS NOT NULL AND t->>'id' = r.root_step_id
                  LIMIT 1) AS root_trigger_label,
                -- Full-µs-precision ISO string for the keyset cursor (r.* is
                -- parsed to a ms-precision JS Date by node-postgres).
                to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at_cursor,
                -- The journey's outcome, which is the LAST leg's, not the head's.
                j.id AS journey_run_id, j.status AS journey_status,
                j.finished_at AS journey_finished_at, j.summary AS journey_summary,
                j.error AS journey_error, j.error_class AS journey_error_class,
                j.handled_error_count AS journey_handled_error_count,
                j.outcome_json AS journey_outcome_json,
                -- Wall clock from the first submission to the last leg's finish.
                -- NULL while the journey is still going, so the table shows its
                -- "…" rather than the head leg's own few milliseconds.
                CASE WHEN j.finished_at IS NULL OR r.started_at IS NULL THEN NULL
                     ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (j.finished_at - r.started_at)) * 1000))
                END AS journey_duration_ms
           FROM automation_runs r
           JOIN automations a ON a.id = r.automation_id${where.joinUsers ? ORG_SCOPE_JOIN : ''}${JOURNEY_LATERAL}
          WHERE ${clause}
          ORDER BY r.started_at DESC NULLS LAST, r.id DESC
          LIMIT $${idx}`,
        [...params, limit + 1],
    );

    let nextCursor = null;
    if (rows.length > limit) {
        const last = rows[limit - 1];
        rows.length = limit; // drop the probe row
        nextCursor = encodeRunCursor(last);
    }
    return { runs: rows.map(project), nextCursor };
}

/** The unchanged user-scoped list — every pre-existing caller's entry point. */
async function listRunsForUser(userId, filters = {}) {
    return listRunsScoped({ user: { userId } }, filters);
}

/**
 * The ORGANISATION-wide list (Track H2). Same query, same journey folding,
 * same narrowing filters — a DIFFERENT projection, and that is the point.
 *
 * `viewerUserId` is only used to stamp `mine` per row; it never widens or
 * narrows the result. Pass the caller so the UI can tell which rows it may
 * open (every per-run route — GET /runs/:id, retry, cancel — is still scoped
 * to the run's own owner and 403s for anybody else).
 */
async function listRunsForOrg(orgId, filters = {}, { viewerUserId = null } = {}) {
    return listRunsScoped({ org: { orgId } }, filters, (row) => rowToOrgRunRow(row, viewerUserId));
}

/**
 * One automation's runs (handoff 5 sharing): scoped by the automation, not by who
 * owned it at run time, so an automation handed to a new owner keeps its history.
 * Only for a caller whose role on the automation was checked; pass
 * `filters.startedByUserId` for a run-only caller.
 */
async function listRunsForAutomation(automationId, filters = {}) {
    return listRunsScoped({ automation: { automationId } }, filters);
}

/**
 * Cross-automation recent runs for one user (back-compat wrapper around
 * listRunsForUser — keep the old { runs:[...] }-shape callers working).
 */
async function getRecentRunsForUser(userId, { limit = 50 } = {}) {
    const { runs } = await listRunsForUser(userId, { limit });
    return runs;
}

/**
 * Stamp last_heartbeat_at so the stuck-run reaper sees the run as alive and the
 * SSE heartbeat has a persisted counterpart. Best-effort; never throws.
 */
async function touchRunHeartbeat(runId) {
    if (!runId) return false;
    try {
        await initDB();
        const { rowCount } = await run(
            `UPDATE automation_runs SET last_heartbeat_at = NOW()
              WHERE id = $1 AND status = 'running'`,
            [runId],
        );
        return rowCount > 0;
    } catch (_) { return false; }
}

/**
 * Active (running / paused-on-a-human) runs for a user. Powers the
 * "● Running" dot in the automation list sidebar and the concurrent-run
 * guard. Joins to automations so the caller can match by automationId
 * without a second round-trip.
 */
async function getActiveRunsForUser(userId) {
    await initDB();
    const rows = await getAll(
        `SELECT r.id, r.automation_id, r.status, r.started_at, r.trigger_kind
           FROM automation_runs r
          WHERE r.user_id = $1
            AND r.status IN ('queued', 'running', 'awaiting_approval', 'awaiting_form')
          ORDER BY r.started_at DESC NULLS LAST`,
        [userId],
    );
    return rows.map(r => ({
        runId: r.id,
        automationId: r.automation_id,
        status: r.status,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        triggerKind: r.trigger_kind || null,
    }));
}

const RUN_COLUMNS = {
    status: 'status', startedAt: 'started_at', finishedAt: 'finished_at',
    durationMs: 'duration_ms', error: 'error', summary: 'summary',
    // Phase 2 approval flow
    awaitingStepId: 'awaiting_step_id',
    approvalToken: 'approval_token',
    // §27a — optional deadline on the awaiting_approval state.
    awaitingStepExpiresAt: 'awaiting_step_expires_at',
    // §25 — typed error class so the activity dashboard can filter
    // by error category without parsing the free-text message.
    errorClass: 'error_class',
    // §WS4 — count of step failures absorbed by on_error branches.
    handledErrorCount: 'handled_error_count',
    // FRM-08 — the signed-in person who submitted a form (the public form
    // route writes it the moment the run exists).
    submittedByUserId: 'submitted_by_user_id',
    // Handoff 5: the structured one-sentence outcome ({ code, params, text }).
    // Serialised here, so a caller passes the object.
    outcome: 'outcome_json',
};

async function updateRun(id, updates) {
    await initDB();
    const write = (updates && updates.outcome !== undefined)
        ? { ...updates, outcome: updates.outcome == null ? null : JSON.stringify(updates.outcome) }
        : updates;
    const built = buildUpdate({
        table: 'automation_runs',
        updates: write,
        columnMap: RUN_COLUMNS,
        where: [{ col: 'id', value: id }],
        quoteCols: true,
    });
    if (!built) return false;
    const { rowCount } = await run(built.sql, built.params);
    return rowCount > 0;
}

/**
 * Read the run-scoped PII token vault (`{ '[person_1]': 'Jan de Vries', … }`).
 *
 * Deliberately NOT part of rowToRun(): run rows go straight to the client and
 * this map holds real personal data. Only the runner reads it — to reseed the
 * vault when a run resumes from an approval pause, is retried, or is replayed
 * partially in another process, so placeholders minted by the first process
 * still resolve.
 */
async function getRunTokenMap(runId) {
    await initDB();
    if (!runId) return null;
    const r = await getOne('SELECT pii_token_map FROM automation_runs WHERE id = $1', [runId]);
    const m = r ? fromJsonb(r.pii_token_map) : null;
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : null;
}

/**
 * Write-through of the token vault. Called fire-and-forget after any step that
 * minted tokens, and awaited at the two hand-off points (approval pause, run
 * finish) — after those the run may continue in a different process.
 */
async function saveRunTokenMap(runId, tokenMap) {
    await initDB();
    if (!runId) return false;
    const payload = (tokenMap && Object.keys(tokenMap).length) ? JSON.stringify(tokenMap) : null;
    const { rowCount } = await run('UPDATE automation_runs SET pii_token_map = $1 WHERE id = $2', [payload, runId]);
    return rowCount > 0;
}

module.exports = { createRun, getRun, getRunsForAutomation, getRecentRunsForUser, listRunsForUser, listRunsForOrg, listRunsForAutomation, getRunFacetsForUser, getRunFacetsForOrg, getRunFacetsForAutomation, getRunCountForUserSince, getRecentRunStatusesForUser, getRunCountsForProjects, touchRunHeartbeat, getActiveRunsForUser, updateRun, requestCancelRun, recordRunStep, recordRunStepWith, getRunSteps, getRunStepsForRuns, getRunsInChain, getRunStepsForChain, getLatestRunInChain, getRunTokenMap, saveRunTokenMap, encodeRunCursor, decodeRunCursor, buildRunFilterWhere, rowToOrgRunRow, RUN_FACET_AUTOMATIONS_CAP };
