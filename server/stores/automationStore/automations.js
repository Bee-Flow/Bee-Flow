// @typecheck
/**
 * automations.js — automationStore aggregate (§WS5, extracted verbatim).
 */

const crypto = require('crypto');
const { initDB, run, getOne, getAll, getClient, pool } = require('./core');
const { rowToAutomation, safeParse } = require('./rowMappers');
const { buildUpdate } = require('../lib/sqlBuilder');
const { planVersionWrite } = require('../../automation/diffSummary');
// Handoff 5: every read carries pendingChanges, trashed rows are excluded, and
// a working-copy write never moves the live copy (see lifecycle.js).
const { AUTOMATION_SELECT, LIVE_INVARIANT_SQL, stripLiveFollowingFields } = require('./lifecycle');

/**
 * The managed-write guard (stores/lib/managedParts.js): an automation filed into a
 * Solution stage project is changed in Dev and deployed, so only the
 * allow-listed keys move without a deploy's `managedWrite` capability.
 * Required lazily: the guard reaches projectStore, which this aggregate must
 * not load at require time. `override` is a test's own instance.
 */
function guardOf(override) {
    return override || require('../lib/managedParts');
}

/** `updates` without the keys whose value is `undefined` (nothing to write). */
function suppliedOf(updates) {
    const out = {};
    for (const [k, v] of Object.entries(updates || {})) if (v !== undefined) out[k] = v;
    return out;
}

async function createAutomation({ userId, organizationId = null, title, description = '', definition, triggerType, scheduleCron = null, scheduleTz = 'Europe/Amsterdam', nextRunAt = null, createdFromChatId = null, versionMeta = null }) {
    await initDB();
    const id = crypto.randomUUID();
    // Layers are inline (definition.layers) since the inline-layers
    // migration — every new row is a plain automation; the `kind` column's
    // default covers it (kept for legacy rows converted from standalone
    // layers).
    await run(
        `INSERT INTO automations (id, user_id, organization_id, title, description, definition_json,
            version, is_active, is_draft, needs_first_run_confirm, trigger_type, schedule_cron, schedule_tz, next_run_at, created_from_chat_id)
         VALUES ($1,$2,$3,$4,$5,$6,1,FALSE,TRUE,TRUE,$7,$8,$9,$10,$11)`,
        [id, userId, organizationId, title, description, JSON.stringify(definition || {}),
            triggerType, scheduleCron, scheduleTz, nextRunAt, createdFromChatId],
    );
    // Seed the v1 version snapshot so run history can render the flow exactly
    // as it was at run time, even for runs that fire before the first edit
    // (updateAutomation only inserts a version row on subsequent changes).
    // Handoff 5: v1 says how the automation came to be ("Created", "Created from
    // template ...", "Copied from ..."), as codes the UI translates plus text.
    const v1 = versionMeta || {};
    const v1Json = v1.descriptionJson != null ? v1.descriptionJson : [{ code: 'created', params: {} }];
    await run(
        `INSERT INTO automation_versions (id, automation_id, version, definition_json, saved_by_user_id, change_summary,
                                          name, description, description_json)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (automation_id, version) DO NOTHING`,
        [crypto.randomUUID(), id, JSON.stringify(definition || {}), userId, 'Created',
            typeof v1.name === 'string' && v1.name.trim() ? v1.name.trim() : null,
            v1.description || 'Created', JSON.stringify(v1Json)],
    );
    return getAutomation(id);
}

/**
 * One automation, or null. An automation in the TRASH is null too, unless the caller
 * asks for it (`includeDeleted`) — the trash and restore routes are the only
 * ones that do, so nothing can run, schedule or open a deleted automation.
 */
async function getAutomation(id, { includeDeleted = false } = {}) {
    await initDB();
    const r = await getOne(
        `${AUTOMATION_SELECT} WHERE a.id = $1${includeDeleted ? '' : ' AND a.deleted_at IS NULL'}`,
        [id],
    );
    return rowToAutomation(r);
}

async function getAutomationsForUser(userId) {
    await initDB();
    // Layers live in their own library — keep them out of the main list.
    const rows = await getAll(
        `${AUTOMATION_SELECT} WHERE a.user_id = $1 AND a.kind = 'automation' AND a.deleted_at IS NULL ORDER BY a.updated_at DESC`,
        [userId],
    );
    return rows.map(rowToAutomation);
}

/**
 * Automations filed into a project.
 *
 * The column this reads has existed since migrations/automation-project-id-2026-07.js
 * but that migration was never registered and nothing ever read the column —
 * the whole integration was written and then abandoned. This is the read side
 * it was missing.
 */
/**
 * Automations filed into a project.
 *
 * `kinds` defaults to the top-level automations alone, which is what the
 * project's Content list means by "the automations in here" — a reusable Step
 * (kind 'block') or a sub-flow (kind 'layer') is a building material, not
 * something a member files.
 *
 * The dependency graph and the packager ask for ALL kinds, and must: a
 * `call_block` pointing at a block that IS in this project would otherwise be
 * reported as an external dependency the Solution cannot carry, purely because
 * the query that found the project's automations could not see it.
 */
async function getAutomationsForProject(projectId, { kinds = ['automation'] } = {}) {
    await initDB();
    if (!projectId) return [];
    const wanted = (Array.isArray(kinds) ? kinds : [kinds]).filter(Boolean);
    if (!wanted.length) return [];
    const rows = await getAll(
        `${AUTOMATION_SELECT} WHERE a.project_id = $1 AND a.kind = ANY($2) AND a.deleted_at IS NULL ORDER BY a.updated_at DESC`,
        [projectId, wanted],
    );
    return rows.map(rowToAutomation);
}

/**
 * How many automations each of these projects holds — ONE query for the whole
 * list, keyed by project id.
 *
 * The overview draws a card per Solution and every card carries a tally. Doing
 * that with the listing above would be one round-trip per project per kind, and
 * would read whole rows to throw all but their number away. A project that
 * appears in no row is genuinely EMPTY, which is why the caller distinguishes a
 * missing key (0) from a failed read (the whole call rejects) rather than
 * folding both into a zero.
 */
async function countAutomationsForProject(projectIds, { kinds = ['automation'] } = {}) {
    await initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
    const wanted = (Array.isArray(kinds) ? kinds : [kinds]).filter(Boolean);
    if (!ids.length || !wanted.length) return new Map();
    const rows = await getAll(
        `SELECT project_id, COUNT(*)::int AS n FROM automations
          WHERE project_id = ANY($1) AND kind = ANY($2) AND deleted_at IS NULL GROUP BY project_id`,
        [ids, wanted],
    );
    return new Map(rows.map(r => [r.project_id, Number(r.n) || 0]));
}

/**
 * Detach every automation from a deleted project.
 *
 * project_id is a SOFT reference (no FK) exactly so that deleting a project
 * never deletes its members' automations. The original migration's header
 * promised this function and called it by name; it was never written, so
 * deleting a project left automations pointing at a project that no longer
 * existed — invisible in the project list and unfindable in the standalone one.
 */
async function clearProjectFromAutomations(projectId) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE automations SET project_id = NULL WHERE project_id = $1',
        [projectId],
    );
    return rowCount;
}

async function getDueAutomations() {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM automations
         WHERE is_active = TRUE
           AND is_draft = FALSE
           AND trigger_type = 'schedule'
           AND next_run_at IS NOT NULL
           AND next_run_at <= NOW()
           AND (last_status IS NULL OR last_status != 'running')
         ORDER BY next_run_at ASC LIMIT 20`,
    );
    return rows.map(rowToAutomation);
}

/**
 * Atomically claim due schedule-trigger automations for execution.
 *
 * Uses `FOR UPDATE SKIP LOCKED` so concurrent runner instances never claim
 * the same row. The claim sets `last_status='running'`, stamps the
 * instance/start time, and returns the rows so the caller can execute them.
 * Replaces the old read-then-mark pattern that allowed double-execution if
 * a runner crashed between read and mark.
 */
async function claimDueAutomations(instanceId, limit = 20) {
    await initDB();
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const sel = await client.query(
            `SELECT id FROM automations
             WHERE is_active = TRUE
               AND is_draft = FALSE
               AND trigger_type = 'schedule'
               AND next_run_at IS NOT NULL
               AND next_run_at <= NOW()
               AND (last_status IS NULL OR last_status != 'running')
             ORDER BY next_run_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED`,
            [limit],
        );
        if (sel.rows.length === 0) {
            await client.query('COMMIT');
            return [];
        }
        const ids = sel.rows.map(r => r.id);
        const upd = await client.query(
            `UPDATE automations
                SET last_status = 'running',
                    running_instance_id = $1,
                    running_started_at = NOW()
              WHERE id = ANY($2::text[])
              RETURNING *`,
            [instanceId, ids],
        );
        await client.query('COMMIT');
        return upd.rows.map(rowToAutomation);
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Mark an automation row as running for non-scheduled paths (manual run,
 * event trigger). The schedule tick uses claimDueAutomations() instead;
 * this is for paths that already know they want to run a specific row.
 *
 * Returns false if the row was already marked running (i.e. another path
 * is mid-execution) so callers can decide whether to skip or queue.
 */
async function markRunning(id, instanceId) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE automations
            SET last_status = 'running',
                running_instance_id = $1,
                running_started_at = NOW()
          WHERE id = $2
            AND (last_status IS NULL OR last_status != 'running')
          RETURNING id`,
        [instanceId, id],
    );
    return rows.length > 0;
}

/**
 * Clear the running marker on an automation. Called from the runner's
 * finally block so a crash mid-execution leaves running_started_at set
 * for the reaper to find.
 */
async function releaseAutomation(id) {
    await initDB();
    await run(
        `UPDATE automations
            SET running_instance_id = NULL,
                running_started_at = NULL
          WHERE id = $1`,
        [id],
    );
}

/**
 * Push the running marker forward on a row that is legitimately still working.
 *
 * reapStuckAutomations decides "stuck" from running_started_at, and its widest
 * possible window is ~61 minutes (the run_timeout_ms clamp plus the buffer).
 * A `wait` step, though, may sleep far longer than that: execWait extends the
 * runner's IN-PROCESS deadline via ctx.extendRunDeadline and nothing told the
 * database, so the reaper cleared the row mid-sleep, the concurrency guard
 * lapsed, and the scheduler started a SECOND run of the same automation while the
 * first was still sleeping.
 *
 * Guarded on running_instance_id so a row that was already reaped and re-claimed
 * by another instance is NOT resurrected by the old runner's heartbeat — that
 * would hand two live runners the same row.
 */
async function touchAutomationRunning(id, instanceId) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE automations
            SET running_started_at = NOW()
          WHERE id = $1
            AND running_instance_id = $2
            AND last_status = 'running'
          RETURNING id`,
        [id, instanceId],
    );
    return rows.length > 0;
}

/**
 * Reset rows stuck in `running` for longer than `staleAfterMs` (a runner
 * crash, OOM, or process kill leaves them this way). The reset bumps
 * `attempts`; the caller decides what status to leave them in.
 *
 * Returns the rows that were reset so the runner can decide whether to
 * retry now, schedule a backoff, or notify the owner.
 */
async function reapStuckAutomations({ staleAfterMs = 10 * 60_000, maxAttempts = 5, bufferMs = 60_000 } = {}) {
    await initDB();
    // Per-row stale window: max(floor, run_timeout_ms + buffer). A row with
    // a custom 30-min timeout gets a 31-min reaper window; rows with no
    // override fall back to the floor. This keeps short defaults reaping
    // fast while still leaving room for legitimately long automations.
    const { rows } = await pool.query(
        `UPDATE automations
            SET last_status = CASE
                    WHEN attempts + 1 >= $2 THEN 'error'
                    ELSE 'pending'
                END,
                running_instance_id = NULL,
                running_started_at = NULL,
                attempts = attempts + 1
          WHERE last_status = 'running'
            AND (
                -- (a) the ordinary crash: the marker is still set and has
                -- been sitting there past this row's stale window.
                (running_started_at IS NOT NULL
                 AND running_started_at < NOW() - (
                     GREATEST($1::int, COALESCE(run_timeout_ms, 0) + $3::int) * INTERVAL '1 millisecond'
                 ))
                -- (b) the UNREACHABLE one: marker cleared, status stranded on
                -- 'running'. markRunning gates on last_status, not on the
                -- marker, so such a row refuses EVERY future run — and with
                -- running_started_at NULL, clause (a) could never see it, so
                -- nothing ever repaired it. It happens whenever
                -- releaseAutomation runs without a lastStatus write beside it
                -- (a crash between the two, the scheduler's beta-lookup catch,
                -- or an operator clearing a stuck marker by hand). The
                -- NOT EXISTS is what makes it safe: a genuinely running
                -- automation always has a live run row, so the only rows this
                -- reaches are ones with nothing left running at all.
                OR (running_started_at IS NULL
                    AND NOT EXISTS (
                        SELECT 1 FROM automation_runs r
                         WHERE r.automation_id = automations.id
                           AND r.status IN ('running', 'queued')
                    ))
            )
            -- Approval-paused runs are tracked on the automation_runs row,
            -- not the automation row, so they don't appear here. The
            -- automation row should NOT be 'running' while an approval
            -- waits — runner sets last_status='pending' before pausing.
          RETURNING *`,
        [staleAfterMs, maxAttempts, bufferMs],
    );
    return rows.map(rowToAutomation);
}

/**
 * §WS2.2 — Expire approval-paused runs past their deadline. Unlike
 * reapStuckAutomations (which works on the automations row), approval pauses
 * live on automation_runs: a run sits in status='awaiting_approval' with an
 * awaiting_step_expires_at deadline. This flips any run past its deadline to a
 * terminal error so paused runs can't accumulate forever and can no longer be
 * approved after the window. Returns the reaped runs so the caller can emit
 * run.failed lifecycle events.
 */
async function reapExpiredApprovals() {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE automation_runs
            SET status = 'error',
                error_class = 'ApprovalExpired',
                error = COALESCE(error, 'Approval was not granted before the deadline'),
                summary = 'Approval expired — no decision was made before the deadline.',
                finished_at = NOW(),
                duration_ms = COALESCE(duration_ms, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int),
                awaiting_step_id = NULL,
                approval_token = NULL
          WHERE status = 'awaiting_approval'
            AND awaiting_step_expires_at IS NOT NULL
            AND awaiting_step_expires_at < NOW()
          RETURNING id, automation_id, user_id`,
    );
    return rows.map(r => ({ id: r.id, automationId: r.automation_id, userId: r.user_id }));
}

/**
 * Sibling of reapExpiredApprovals for multi-page forms: a run paused at a
 * `form_page` step sits in status='awaiting_form' until the visitor submits
 * the next page. Every such pause carries a deadline (someone is waiting in
 * front of a browser), so unlike approvals there is no "expiry disabled" case
 * — an abandoned tab must not pin a run forever.
 */
async function reapExpiredFormWaits() {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE automation_runs
            SET status = 'error',
                error_class = 'FormExpired',
                error = COALESCE(error, 'The form was not completed before the deadline'),
                summary = 'Form expired — the next page was never submitted.',
                finished_at = NOW(),
                duration_ms = COALESCE(duration_ms, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int),
                awaiting_step_id = NULL
          WHERE status = 'awaiting_form'
            AND awaiting_step_expires_at IS NOT NULL
            AND awaiting_step_expires_at < NOW()
            -- A run whose next page WAS submitted has a child run carrying the
            -- continuation. The route finalises the parent when the resume
            -- lands, but a crash between the two left the parent in
            -- awaiting_form and the reaper then flipped a form the visitor had
            -- completed to a bogus "FormExpired" in the owner's run history.
            -- The child's existence is the durable proof it was submitted.
            AND NOT EXISTS (
                SELECT 1 FROM automation_runs c WHERE c.parent_run_id = automation_runs.id
            )
          RETURNING id, automation_id, user_id`,
    );
    return rows.map(r => ({ id: r.id, automationId: r.automation_id, userId: r.user_id }));
}

/**
 * §WS3.3 — Reap orphaned run rows. A run whose worker pod crashed stays in
 * status='running' forever (the stuck-automations reaper only touches the
 * automations row, not automation_runs), leaking into the active-runs UI /
 * concurrency guard. This finally READS last_heartbeat_at (previously a dead
 * column): a healthy long run heartbeats every 15s so it's never stale; a dead
 * run stops heartbeating and is flipped to error after the window. Falls back to
 * started_at for runs that died before their first heartbeat. Returns reaped runs
 * so the caller can emit run.failed lifecycle events.
 */
async function reapStuckRuns({ staleAfterMs = 6 * 60_000 } = {}) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE automation_runs
            SET status = 'error',
                error_class = COALESCE(error_class, 'RunnerDied'),
                error = COALESCE(error, 'Run stopped heartbeating — the worker crashed or was killed.'),
                summary = COALESCE(summary, 'Run interrupted — the worker stopped responding.'),
                finished_at = NOW(),
                duration_ms = COALESCE(duration_ms, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int)
          WHERE status = 'running'
            AND COALESCE(last_heartbeat_at, started_at) IS NOT NULL
            AND COALESCE(last_heartbeat_at, started_at) < NOW() - ($1::int * INTERVAL '1 millisecond')
          RETURNING id, automation_id, user_id`,
        [staleAfterMs],
    );
    return rows.map(r => ({ id: r.id, automationId: r.automation_id, userId: r.user_id }));
}

/**
 * §WS3.1 — Delete terminal runs older than the cutoff, in one bounded batch.
 * automation_run_steps cascade-delete via their FK. NEVER touches in-flight runs
 * (queued/running/awaiting_approval/awaiting_form). Returns the number of runs deleted so the
 * caller can loop until a batch comes back short. Ordered oldest-first so repeated
 * batches drain the backlog deterministically.
 */
async function deleteRunsOlderThan(cutoffIso, { limit = 5000 } = {}) {
    await initDB();
    const { rowCount } = await pool.query(
        `DELETE FROM automation_runs
          WHERE id IN (
              SELECT id FROM automation_runs
               WHERE status IN ('success', 'error', 'cancelled')
                 AND COALESCE(finished_at, created_at) < $1
               ORDER BY COALESCE(finished_at, created_at) ASC
               LIMIT $2
          )`,
        [cutoffIso, limit],
    );
    return rowCount || 0;
}

/**
 * Reset the attempts counter after a successful run.
 */
async function resetAttempts(id) {
    await initDB();
    await run(`UPDATE automations SET attempts = 0 WHERE id = $1`, [id]);
}

/**
 * Write an automation. A `definition` write is a WORKING-copy save: a structural
 * change bumps the version and snapshots it; on an automation that has a live
 * version it may not move the trigger-derived columns
 * (lifecycle.LIVE_FOLLOWING_FIELDS), those follow the live definition and
 * change on publish.
 *
 * A LAYOUT-ONLY write (node positions, sizes, colours, icons, or nothing that
 * differs at all) updates definition_json and the builder snapshot but creates
 * no version: the next structural save's version carries the positions
 * (automation/diffSummary.js planVersionWrite). Every version row gets a
 * plain-language description (description + description_json).
 *
 * opts.goLive        this write is what should RUN (an approved evolution, a
 *                    package upgrade): the live copy moves with it on an automation
 *                    that is or has been live, and trigger columns are written.
 * opts.versionMeta   { name, description, descriptionJson, isLayoutOnly } for
 *                    the version row this write creates (handoff 5 versions).
 * opts.forceVersion  write a version even for a layout-only change (a restore);
 *                    it is marked is_layout_only then.
 *
 * opts.managedWrite  `{ deploymentId }`: the capability a deploy passes to write
 *                    an automation of a Solution stage beyond the allow-list
 *                    (stores/lib/managedParts.js). Without it such a write
 *                    throws 409 managed_part.
 *
 * Whatever the path, a never-live automation that ends up ACTIVE gets its working
 * copy published in the same transaction (lifecycle.LIVE_INVARIANT_SQL).
 */
async function updateAutomation(id, updates, savedByUserId, opts = {}) {
    await initDB();
    if (!buildAutomationUpdate(updates).built) return false;
    const client = await getClient();
    try {
        return await updateAutomationWith(client, id, updates, savedByUserId, opts);
    } finally {
        client.release();
    }
}

const UPDATE_FIELD_MAP = Object.freeze({
    title: 'title',
    description: 'description',
    icon: 'icon',
    category: 'category',
    definition: 'definition_json',
    isActive: 'is_active',
    isDraft: 'is_draft',
    needsFirstRunConfirm: 'needs_first_run_confirm',
    triggerType: 'trigger_type',
    scheduleCron: 'schedule_cron',
    scheduleTz: 'schedule_tz',
    nextRunAt: 'next_run_at',
    lastRunAt: 'last_run_at',
    lastStatus: 'last_status',
    runTimeoutMs: 'run_timeout_ms',
    // null = standalone (all pre-existing rows); set = filed into a project,
    // where project members can see and run it.
    projectId: 'project_id',
    folderId: 'folder_id',
});

/** The column write for `updates`, and its definition serialised once. */
function buildAutomationUpdate(updates) {
    const write = { ...updates };
    let definitionJson = null;
    if (updates.definition !== undefined) {
        // Never coerce a falsy definition into `{}`. An empty object is
        // truthy, so it reads back as a "present" definition and silently
        // defeats the builder's `def || seed` fallbacks — that is how a
        // automation ended up persisting a trigger-only graph and failing
        // validation forever (BFSF-318). Callers must validate first.
        const v = updates.definition;
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
            throw new Error('definition must be a non-null object');
        }
        definitionJson = JSON.stringify(v);
        write.definition = definitionJson;
    }
    const buildFor = (w) => buildUpdate({
        table: 'automations',
        updates: w,
        columnMap: UPDATE_FIELD_MAP,
        extraSet: ['updated_at = NOW()'],
        quoteCols: true,
    });
    return { write, definitionJson, buildFor, built: buildFor(write) };
}

/**
 * updateAutomation's transaction on a client the caller owns (and releases).
 * Split out so the version rules run against a real Postgres in a test
 * (automations.versions.pg.test.js) without reaching into the module system.
 *
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} client
 */
async function updateAutomationWith(client, id, updates, savedByUserId, {
    goLive = false, versionMeta = null, forceVersion = false, managedWrite = null, managedParts = null,
} = {}) {
    const { write, definitionJson, buildFor, built: initial } = buildAutomationUpdate(updates);
    if (!initial) return false;
    const definitionChanged = definitionJson !== null;
    try {
        await client.query('BEGIN');
        // The pre-update definition decides whether this write is a version
        // at all (layout-only is not) and describes what changed. The live
        // version rides along: it decides which columns this write may move.
        // Locked, so a concurrent publish cannot slip in between.
        const prevRow = await client.query('SELECT definition_json, live_version, project_id FROM automations WHERE id = $1 FOR UPDATE', [id]);
        const locked = prevRow.rows[0];
        const hasLive = locked?.live_version != null;
        if (locked) {
            // On a managed automation only the allow-list moves without a deploy.
            // The values go along, so switching a never-live automation OFF passes
            // while switching it ON (which would publish the working copy) does not.
            // A goLive write also copies the working copy into the live columns
            // (LIVE_INVARIANT_SQL below), a publish whatever keys it carries.
            const guard = guardOf(managedParts);
            const supplied = suppliedOf(updates);
            await guard.assertManagedWrite({
                kind: 'automation', projectId: locked.project_id,
                changedKeys: goLive ? { ...supplied, liveDefinition: true } : supplied,
                managedWrite, client, liveVersion: locked.live_version ?? null,
            });
            // Filing INTO a stage project is a stage write too.
            if (supplied.projectId && supplied.projectId !== locked.project_id) {
                await guard.assertManagedWrite({
                    kind: 'automation', projectId: supplied.projectId, changedKeys: ['projectId'], managedWrite, client,
                });
            }
        }
        let plan = null;
        if (definitionChanged) {
            const pj = prevRow.rows[0]?.definition_json;
            const prevDefinition = typeof pj === 'string' ? safeParse(pj, {}) : (pj || {});
            plan = planVersionWrite(prevDefinition, updates.definition, { versionMeta, forceVersion });
        }
        const built = buildFor(stripLiveFollowingFields(write, { hasLive, goLive }));
        if (!built) {
            // Everything asked for was a live-following column on a live
            // automation: nothing to write, the row stands as it is.
            const same = await client.query(`${AUTOMATION_SELECT} WHERE a.id = $1 AND a.deleted_at IS NULL`, [id]);
            await client.query('COMMIT');
            return rowToAutomation(same.rows[0] || null);
        }
        // Bump the version when the definition changed structurally. Both
        // clauses are verbatim SQL over the stored row, so they continue after
        // the builder's placeholders rather than going through it.
        const params = built.params;
        let idx = params.length + 1;
        const setClauses = [];
        if (definitionChanged) {
            if (plan.createVersion) setClauses.push('version = version + 1');
            // Keep the builder-session snapshot's draft in lock-step with the
            // persisted definition. Visual edits (drag, layer ops, inspector
            // saves) update the row but NOT the snapshot the client rehydrates
            // from on refresh — without this the stale snapshot draft masks the
            // saved definition and the user's changes appear to vanish on
            // reload. Only touch the snapshot when one already exists.
            setClauses.push(`builder_session = CASE WHEN builder_session IS NULL THEN builder_session ELSE jsonb_set(builder_session, '{draft}', $${idx}::jsonb, true) END`);
            params.push(definitionJson);
            idx++;
        }
        params.push(id);
        const upd = await client.query(
            `${built.sql}${setClauses.length ? ', ' + setClauses.join(', ') : ''} WHERE id = $${idx} RETURNING *`,
            params,
        );
        const updatedRow = upd.rows[0];
        if (definitionChanged && updatedRow && plan.createVersion) {
            await client.query(
                `INSERT INTO automation_versions (id, automation_id, version, definition_json, saved_by_user_id, change_summary,
                                                  name, description, description_json, is_layout_only)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 ON CONFLICT (automation_id, version) DO NOTHING`,
                [crypto.randomUUID(), id, updatedRow.version, definitionJson, savedByUserId || updatedRow.user_id, plan.changeSummary,
                    plan.name, plan.description,
                    plan.descriptionJson != null ? JSON.stringify(plan.descriptionJson) : null,
                    plan.isLayoutOnly],
            );
        }
        if (updatedRow) await client.query(LIVE_INVARIANT_SQL, [id, !!goLive]);
        const fresh = updatedRow
            ? (await client.query(`${AUTOMATION_SELECT} WHERE a.id = $1`, [id])).rows[0] || updatedRow
            : updatedRow;
        await client.query('COMMIT');
        return rowToAutomation(fresh);
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    }
}

/**
 * Hard delete. On an automation of a Solution stage only a deploy (`managedWrite`)
 * may; an automation there is retired, never deleted by hand.
 *
 * @param {string} id
 * @param {{ managedWrite?: { deploymentId?: string }|null, managedParts?: any }} [opts]
 */
async function deleteAutomation(id, { managedWrite = null, managedParts = null } = {}) {
    await initDB();
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const deleted = await deleteAutomationWith(client, id, { managedWrite, managedParts });
        await client.query('COMMIT');
        return deleted;
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

/**
 * deleteAutomation on a `{ query }` handle (a transaction's client): the row
 * is locked while the managed-write guard decides, so no filing into a stage
 * or deploy lands between the check and the DELETE. Answers whether a row went.
 *
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }} q
 * @param {string} id
 * @param {{ managedWrite?: { deploymentId?: string }|null, managedParts?: any }} [opts]
 */
async function deleteAutomationWith(q, id, { managedWrite = null, managedParts = null } = {}) {
    const cur = await q.query('SELECT project_id FROM automations WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) return false;
    await guardOf(managedParts).assertManagedWrite({
        kind: 'automation', projectId: cur.rows[0].project_id, changedKeys: ['delete'], managedWrite, client: q,
    });
    const r = await q.query('DELETE FROM automations WHERE id = $1 RETURNING id', [id]);
    return r.rows.length > 0;
}

module.exports = { createAutomation, getAutomation, getAutomationsForUser, getAutomationsForProject, countAutomationsForProject, clearProjectFromAutomations, getDueAutomations, claimDueAutomations, markRunning, releaseAutomation, touchAutomationRunning, reapStuckAutomations, reapExpiredApprovals, reapExpiredFormWaits, reapStuckRuns, deleteRunsOlderThan, resetAttempts, updateAutomation, updateAutomationWith, deleteAutomation, deleteAutomationWith };
