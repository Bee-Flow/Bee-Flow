// @typecheck
/**
 * runs.js — automationStore aggregate (§WS5, extracted verbatim).
 */

const crypto = require('crypto');
const { initDB, run, getOne, getAll, pool } = require('./core');
const { rowToRun, rowToRunStep, fromJsonb } = require('./rowMappers');
const { buildUpdate } = require('../lib/sqlBuilder');
const { redactForPersistence, safeOutputKeysForTool } = require('../../automation/runLogRedaction');
const { truncatePayload } = require('../../automation/payloadTruncation');
const { persistableOutput } = require('./runFullOutputs');
const log = require('../../telemetry/log');

// ── Runs ───────────────────────────────────────────────

/**
 * `rootRunId` names the JOURNEY this run belongs to (see the
 * automation-run-root-2026-08 migration). Omit it and the run is its own root,
 * which is right for every fresh trigger and for a retry. Only a run that
 * CONTINUES a paused one passes its parent's root, and that is what collapses a
 * multi-page form's child runs into a single row in the history.
 */
async function createRun({ automationId, version, userId, triggerKind, triggerPayload = null, mode = 'live', parentRunId = null, rootRunId = null, rootStepId = null, isTest = false, startedByUserId = null, callerAgentId = null, callerConversationId = null }) {
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
                                      is_test, started_by_user_id, caller_agent_id, caller_conversation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',NOW(),$8,COALESCE($9,$1),$10,$11,$12,$13,$14)`,
        [id, automationId, version, userId, triggerKind, triggerPayload ? JSON.stringify(triggerPayload) : null, mode, parentRunId, rootRunId, rootStepId || null,
            !!isTest, startedByUserId || null, callerAgentId || null, callerConversationId || null],
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
 * @param {object} r  automation_runs row joined to its automation
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

/**
 * The ORG-scoped row (Track H2) — an EXPLICIT ALLOW-LIST, not rowToRun minus a
 * field, and that distinction is the whole reason this function exists.
 *
 * rowToRun maps `triggerPayload`: the data a run STARTED with. For your own
 * runs that is yours — it is the form you filled in, the mail that arrived. In
 * an organisation-wide list it is a COLLEAGUE'S: every submission of every
 * published form, every inbound e-mail body, name, address and attachment
 * reference in the organisation, shipped to the browser of anyone holding
 * manage_automations — for a table that renders none of it. It also carries
 * `awaitingStepExpiresAt`, `cancelRequested` and the rest of the runner's
 * plumbing, which the list has no use for either.
 *
 * So this builds the row from the fields the executions table actually reads
 * (ExecutionsTable.jsx + runLanguage.js), one by one. Removing keys from
 * rowToRun instead would work exactly once: the next column somebody adds to
 * automation_runs would start travelling the day it is added, and nothing
 * would say so. CLAUDE.md draws the same line for outbound payloads; the
 * reasoning is identical when the "outside" is another person's data.
 *
 * `mine` is the viewer's own ownership of the run, computed here and checked
 * FOR TRUE by the client. The raw `userId` deliberately does NOT travel: the
 * list shows what ran, not who ran it, and an owner id is one join away from a
 * name the screen never asked for.
 *
 * WHAT IS ON THE LIST BY DECISION, not by accident: `summary` and `error`.
 * They are a run's own free text and can quote whatever the run touched, so
 * including them in an organisation-wide read is a real choice and is made
 * here rather than left implicit. It follows GET /approvals?scope=org, which
 * hands an org admin the approval `prompt` under the same shape of check, and
 * it is what the surface is FOR: an admin who can see that something broke but
 * not what broke cannot act on it. Two things keep it bounded — the
 * permission, and the fact that the strip above the table (nowRunning.js)
 * summarises by error CLASS only, so the free text appears in the log rather
 * than in the glance. If a later stage wants the tighter reading, the change
 * is to drop these two fields from THIS list and leave the class behind; the
 * run itself stays reachable by its owner either way.
 */
function rowToOrgRunRow(r, viewerUserId = null) {
    const full = rowToRunWithAutomation(r);
    return {
        id: full.id,
        journeyRunId: full.journeyRunId ?? null,
        automationId: full.automationId,
        automationTitle: full.automationTitle,
        automationKind: full.automationKind,
        automationIcon: full.automationIcon,
        automationTriggerType: full.automationTriggerType,
        rootStepId: full.rootStepId,
        rootTriggerLabel: full.rootTriggerLabel,
        triggerKind: full.triggerKind,
        mode: full.mode,
        status: full.status,
        startedAt: full.startedAt,
        finishedAt: full.finishedAt,
        durationMs: full.durationMs,
        summary: full.summary ?? null,
        error: full.error ?? null,
        errorClass: full.errorClass ?? null,
        handledErrorCount: full.handledErrorCount ?? 0,
        // Handoff 5: which version ran, whether it was a test, and the outcome
        // with its data-derived params (folder, file name, values) left out.
        version: full.version ?? null,
        isTest: !!full.isTest,
        outcome: require('../../automation/runOutcome').outcomeForOrgRow(full.outcome),
        // Ownership, not identity. Only ever true for a real match: a null
        // viewer (or a null owner) is "not mine", never "probably fine".
        mine: !!(viewerUserId && full.userId && String(full.userId) === String(viewerUserId)),
    };
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
    } catch { /* fall through */ }
    return null;
}

/**
 * The JOURNEY join: for a run row `r`, the newest run that shares its root.
 *
 * A routine that pauses on a form or an approval is continued by a CHILD run
 * (see the automation-run-root-2026-08 migration), so the row a person thinks
 * of as "the run" is really a chain of them. `r` stays the head — it owns the
 * start time, and therefore the keyset cursor — while `j` carries the outcome:
 * the status, summary and error belong to whichever leg ran last.
 *
 * COALESCE on both sides so rows written before the column existed still match
 * themselves and behave exactly as they did.
 */
const JOURNEY_LATERAL = `
    LEFT JOIN LATERAL (
        SELECT l.id, l.status, l.finished_at, l.summary, l.error, l.error_class, l.handled_error_count, l.outcome_json
          FROM automation_runs l
         WHERE COALESCE(l.root_run_id, l.id) = COALESCE(r.root_run_id, r.id)
         ORDER BY l.started_at DESC NULLS LAST, l.id DESC
         LIMIT 1
    ) j ON TRUE`;

// Only journey heads are listed; the continuations fold into them.
const JOURNEY_HEAD_ONLY = '(r.root_run_id IS NULL OR r.root_run_id = r.id)';

/**
 * The ORGANISATION scope's join and predicate (Track H2).
 *
 * `COALESCE(a.organization_id, u."organizationId")`, exactly as
 * stores/automationStore/forms.js does it, and for exactly the same reason:
 * `automations.organization_id` has only been written since the create/import
 * routes started stamping it (routes/automation/crud.js), so every routine
 * that predates that change still has it NULL. A query narrowed to
 * `a.organization_id = $1` drops all of those without a word — an org-wide
 * runs list that silently loses the organisation's OLDEST routines, which is
 * the "0 that is not a 0" this codebase keeps finding. Any new org-wide read
 * over `automations` copies this JOIN rather than simplifying it.
 */
// LEFT, and the word is load-bearing. This join exists ONLY to reach
// `u."organizationId"` for the COALESCE below — `u` appears nowhere else in
// either query. As an INNER join it also silently decided WHICH runs the
// organisation is allowed to see: a routine whose owner no longer has a users
// row (deleted account, a tenant cleaned up, a seed that never wrote one) fell
// out of the org log entirely, even when `a.organization_id` was filled in and
// matched. Runs vanishing from an audit log is the one thing an audit log may
// not do, and nothing said it had happened.
//
// LEFT keeps the row and lets the COALESCE decide: the automation's own
// organisation when it has one, the owner's when it does not. A row with
// neither yields NULL, which never equals the asked org — so an orphan with no
// determinable organisation is still excluded, but by the WHERE that says so
// rather than by a join nobody read as a filter.
const ORG_SCOPE_JOIN = ' LEFT JOIN users u ON u.id = a.user_id';
const ORG_SCOPE_WHERE = 'COALESCE(a.organization_id, u."organizationId") = $$';

// Shared WHERE builder for the executions list + facets so the filter chips and
// the rows always agree. Returns { clause, params, nextIdx, joinUsers } starting
// at $startIdx. Filters: status/triggerKind (string or array), automationId,
// kind, since/until (ISO strings on started_at).
//
// SCOPE IS THE FIRST ARGUMENT AND IT IS AN OBJECT, not a user id, because there
// are now two of them and they must never be confused for one another:
//
//   { user: { userId } }  — MY runs. What /_runs/recent and /_runs/facets have
//                           always answered, and still the only thing they do.
//   { org:  { orgId } }   — every run of every routine filed under one
//                           organisation. Reachable ONLY through the endpoints
//                           that prove a manage_automations permission first
//                           (routes/automation/runs.js).
//
// Anything else — no scope, both scopes, a null id — is `FALSE`: a filter that
// scopes to nobody returns nothing rather than everything. That is the same
// fail-closed default buildApprovalWhere takes, and it is deliberate: the org
// branch is one missing null-check away from being an org-less "match every
// run in the database", so the builder refuses rather than guesses.
//
// `joinUsers` tells the caller whether its FROM clause needs the users join the
// org predicate reads. It is NOT unconditional: the user scope reads only
// automation_runs.user_id, and an extra join there would also drop a run whose
// owner row has since been deleted out of that owner's own list.
//
// Both callers join JOURNEY_LATERAL, so the status predicate reads the
// journey's EFFECTIVE status. Filtering on `r.status` instead would hide a
// finished journey behind its head's stale 'success' handoff row, and make the
// chips disagree with the rows they filter.
function buildRunFilterWhere(scope, filters = {}, startIdx = 1) {
    const params = [];
    const clauses = [];
    let i = startIdx;
    const add = (sql, val) => { clauses.push(sql.replace('$$', `$${i}`)); params.push(val); i++; };

    const userId = scope && scope.user ? scope.user.userId : null;
    const orgId = scope && scope.org ? scope.org.orgId : null;
    // Handoff 5 (sharing): ONE routine's runs, whoever owned it when they ran.
    // The route proves the caller's role on that routine first
    // (automation/access.js); a run-only caller adds `startedByUserId`.
    const automationScopeId = scope && scope.automation ? scope.automation.automationId : null;
    let joinUsers = false;
    if (userId && !orgId && !automationScopeId) {
        add('r.user_id = $$', userId);
    } else if (orgId && !userId && !automationScopeId) {
        add(ORG_SCOPE_WHERE, orgId);
        joinUsers = true;
    } else if (automationScopeId && !userId && !orgId) {
        add('r.automation_id = $$', automationScopeId);
    } else {
        // No scope proven (or two at once, which is a caller bug): match nothing.
        clauses.push('FALSE');
    }
    clauses.push(JOURNEY_HEAD_ONLY);
    // Handoff 5: a routine in the trash is gone from every list, and so are
    // its runs (kept only for a restore). The one-routine scope is reached
    // through getAutomation, which already answers 404 for a trashed one.
    if ((userId || orgId) && !automationScopeId && !(userId && orgId)) clauses.push('a.deleted_at IS NULL');
    // Everything below NARROWS. Each clause is ANDed onto the scope above, so a
    // filter can only ever shrink what the caller was already allowed to see —
    // `automationId` in particular is a filter, never an alternative scope.
    const arr = (v) => (Array.isArray(v) ? v : [v]).filter(x => x != null && x !== '');
    if (filters.status != null && arr(filters.status).length) add('COALESCE(j.status, r.status) = ANY($$)', arr(filters.status));
    if (filters.triggerKind != null && arr(filters.triggerKind).length) add('r.trigger_kind = ANY($$)', arr(filters.triggerKind));
    if (filters.mode != null && arr(filters.mode).length) add('r.mode = ANY($$)', arr(filters.mode));
    if (filters.automationId) add('r.automation_id = $$', filters.automationId);
    if (filters.kind) add('a.kind = $$', filters.kind);
    if (filters.sinceTs) add('r.started_at >= $$', filters.sinceTs);
    if (filters.untilTs) add('r.started_at < $$', filters.untilTs);
    // "My runs": the ones this person started, or submitted the form for.
    if (filters.startedByUserId) add('$$::text IN (r.started_by_user_id, r.submitted_by_user_id)', filters.startedByUserId);
    // Handoff 5 Runs tab: "started by" (a person), test runs in or out, and the
    // search box (runListing.buildRunSearch; the org log never searches payloads).
    if (filters.startedBy) add('$$::text IN (r.started_by_user_id, r.submitted_by_user_id)', filters.startedBy);
    if (filters.tests === 'exclude') clauses.push('r.is_test = FALSE');
    if (filters.tests === 'only') clauses.push('r.is_test = TRUE');
    if (filters.q) {
        const search = require('./runListing').buildRunSearch(filters.q, i, { payload: !orgId });
        if (search) { clauses.push(search.clause); params.push(...search.params); i += search.params.length; }
    }
    return { clause: clauses.join(' AND '), params, nextIdx: i, joinUsers };
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
 * @param {object} scope
 * @param {object} [filters]
 * @param {(row: object) => object} [project]
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
 * One routine's runs (handoff 5 sharing): scoped by the routine, not by who
 * owned it at run time, so a routine handed to a new owner keeps its history.
 * Only for a caller whose role on the routine was checked; pass
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
 * Facet counts for the executions filter chips, over the SAME filtered set as
 * the list (minus the dimension being counted is NOT excluded here — the counts
 * reflect the active filter, n8n-style). Returns
 * { status, triggerKind, automationId, errorClass } maps of value→count, plus
 * `automations`: the per-routine rollup the Studio "Now running · last 24
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
    const bump = (bucket, key) => { if (key == null) return; facets[bucket][key] = (facets[bucket][key] || 0) + 1; };
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
                // one-line-per-routine summary and, in the org scope, a summary
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

/** One routine's facets (handoff 5): scoped like listRunsForAutomation. */
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
 * The last few outcomes of each of the caller's OWN routines, newest first.
 *
 * Studio Home's "Needs attention" asks one question of this: is a routine
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
 * plain objects. The window is per routine (`ROW_NUMBER`), so one busy routine
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
 * @param {object} [opts]
 * @param {number} [opts.perAutomation=10]  window size per routine
 * @param {string|null} [opts.sinceTs]      ISO lower bound on started_at
 * @returns {Promise<Array<{automationId, title, status}>>} newest first per routine
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
 * shared workspace, its Content tab already lists every member's routines under
 * one project role, and a tally that counted only the reader's own runs would
 * say "0 today" on a Solution that ran forty times this morning. So this counts
 * every run of every routine filed into the project.
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
 * "● Running" dot in the routine list sidebar and the concurrent-run
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
    // The run's warnings (automation-run-warnings-2026-10), a list of short
    // sentences. Serialised here like outcome.
    warnings: 'warnings_json',
};

async function updateRun(id, updates) {
    await initDB();
    let write = (updates && updates.outcome !== undefined)
        ? { ...updates, outcome: updates.outcome == null ? null : JSON.stringify(updates.outcome) }
        : updates;
    if (write && write.warnings !== undefined) {
        write = { ...write, warnings: Array.isArray(write.warnings) && write.warnings.length ? JSON.stringify(write.warnings) : null };
    }
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

async function recordRunStep({ runId, stepId, parentStepId = null, stepType, attempts = 1, status, startedAt, finishedAt, input, output, error, errorClass = null, branchIndex = null, piiSummary = null, secretValues = [], toolName = null, toolsWithheld = null, errorInfo = null }) {
    await initDB();
    if (!runId || !stepId) {
        // Defensive: NOT NULL columns; skip rather than crash the whole run.
        log.warn(`[AutomationStore] recordRunStep called with null runId/stepId — skipping (runId=${runId}, stepId=${stepId})`);
        return;
    }
    // WS5.2 — this is the single persistence chokepoint for step payloads:
    // redact secrets BEFORE truncation so the truncation head sample is
    // already clean, then cap payload size. In-memory runState stays raw.
    // An OUTPUT over the cap keeps a full copy beside the row (BFSF-435,
    // runFullOutputs.persistableOutput): a resume rebuilds runState from these
    // rows, and the sentinel alone left the step as a silent hole.
    // Exempt known public-identifier fields for this tool (e.g. a Nextcloud
    // Talk room `token`) from the key-name redaction — they're not credentials
    // and downstream steps need them. Secret shapes/values are still masked.
    const allowKeys = safeOutputKeysForTool(toolName);
    const redact = (v) => redactForPersistence(v, { secretValues, allowKeys }).value;
    // NUL bytes can't live in jsonb/text columns — Postgres rejects them with
    // "unsupported Unicode escape sequence" and aborts the whole run record.
    // A single NUL in extracted tool output (e.g. a CID-font PDF) would
    // otherwise kill the run here, so scrub it at this persistence chokepoint.
    // Strip real NUL characters from the RAW value (string leaves, walked
    // recursively) BEFORE JSON.stringify — NOT via a post-hoc regex on the
    // already-stringified JSON. A regex against the stringified form (the
    // old approach) corrupted the JSON whenever a string value contained a
    // literal backslash immediately followed by the 6-char text 'u0000':
    // JSON.stringify escapes that backslash to two backslashes, so matching
    // one backslash + 'u0000' stripped the wrong span and left a dangling
    // unescaped backslash before the closing quote, failing the jsonb insert.
    const NUL = String.fromCharCode(0);
    const stripNulDeep = (v) => {
        if (typeof v === 'string') return v.indexOf(NUL) === -1 ? v : v.split(NUL).join('');
        if (Array.isArray(v)) return v.map(stripNulDeep);
        if (v && typeof v === 'object') {
            const out = {};
            for (const k of Object.keys(v)) out[k] = stripNulDeep(v[k]);
            return out;
        }
        return v;
    };
    const inputJson = input != null ? JSON.stringify(stripNulDeep(truncatePayload(redact(input)).value)) : null;
    const outputValue = output != null
        ? await persistableOutput({ value: redact(output), ref: { runId, stepId, attempts }, clean: stripNulDeep })
        : null;
    const outputJson = outputValue != null ? JSON.stringify(stripNulDeep(outputValue)) : null;
    const errorText = error ? redact(String(error)).replace(/\u0000/g, '') : null;
    // parent_step_id is set on INSERT only (deliberately absent from the
    // conflict-update list): a step's nesting parent is fixed by the graph
    // shape at dispatch time and never changes across attempt upserts.
    // pii_summary is aggregate metadata (category/group COUNTS — see
    // safety.buildPiiSummary), never detected values, so it needs neither
    // redaction nor truncation. Its own column keeps it clear of the 256 KB
    // output truncation and out of the bindable output namespace.
    const piiJson = piiSummary != null ? JSON.stringify(piiSummary) : null;
    // Handoff 5: tools an agent step was not given, and the structured error
    // ({ code, settingKey, fixes }). toolsWithheld is metadata: no redaction
    // pass. errorInfo is NOT: its `technical` is the raw message and its
    // params quote the step's settings, so it gets the same pass as `error`.
    const withheldJson = toolsWithheld != null ? JSON.stringify(toolsWithheld) : null;
    const errorInfoJson = errorInfo != null ? JSON.stringify(stripNulDeep(redact(errorInfo))) : null;
    await run(
        `INSERT INTO automation_run_steps (run_id, step_id, parent_step_id, step_type, attempts, status, started_at, finished_at, input_json, output_json, error, error_class, branch_index, pii_summary, tools_withheld, error_info)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (run_id, step_id, attempts) DO UPDATE SET
            status = EXCLUDED.status,
            finished_at = EXCLUDED.finished_at,
            -- COALESCE, not a plain overwrite: the engine pre-inserts a
            -- 'running' row with no input so the form's progress trail has
            -- something to read, and that null must not erase the real input
            -- the completing upsert wrote (or, in the other order, be written
            -- over it). Every step of every run went input-less for a day
            -- because this line was missing.
            input_json = COALESCE(EXCLUDED.input_json, automation_run_steps.input_json),
            output_json = EXCLUDED.output_json,
            error = EXCLUDED.error,
            error_class = EXCLUDED.error_class,
            branch_index = EXCLUDED.branch_index,
            pii_summary = EXCLUDED.pii_summary,
            -- COALESCE like input_json: a later upsert that does not know
            -- about these (runDag flipping a row to handled_error) must not
            -- erase what the step recorded.
            tools_withheld = COALESCE(EXCLUDED.tools_withheld, automation_run_steps.tools_withheld),
            error_info = COALESCE(EXCLUDED.error_info, automation_run_steps.error_info)`,
        [
            runId, stepId, parentStepId || null, stepType, attempts, status,
            startedAt || null, finishedAt || null,
            inputJson,
            outputJson,
            errorText,
            errorClass || null,
            branchIndex,
            piiJson,
            withheldJson,
            errorInfoJson,
        ],
    );
}

async function getRunSteps(runId) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM automation_run_steps WHERE run_id = $1 ORDER BY started_at NULLS LAST, step_id, attempts',
        [runId],
    );
    return rows.map(rowToRunStep);
}

/**
 * Every leg of one journey, oldest first — the run itself plus anything that
 * continued it after a form or approval pause. Pass any leg's id; the root is
 * resolved from it.
 */
async function getRunsInChain(runId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM automation_runs
          WHERE COALESCE(root_run_id, id) = (SELECT COALESCE(root_run_id, id) FROM automation_runs WHERE id = $1)
          ORDER BY started_at ASC NULLS FIRST, id ASC`,
        [runId],
    );
    return rows.map(rowToRun);
}

/**
 * The journey's step rows as ONE timeline.
 *
 * A leg only records the steps it dispatched LIVE — everything before its
 * resume boundary is replayed, not re-recorded — so reading a single leg shows
 * holes where the earlier pages ran. Concatenating oldest-leg-first fills them,
 * and when the same step_id appears twice (the paused step is re-recorded on
 * the leg that answered it) the LATER leg wins. Same precedence resumeFromStep
 * uses when it rebuilds runState from the ancestor chain.
 */
async function getRunStepsForChain(runId) {
    await initDB();
    const rows = await getAll(
        `SELECT s.* FROM automation_run_steps s
           JOIN automation_runs r ON r.id = s.run_id
          WHERE COALESCE(r.root_run_id, r.id) = (SELECT COALESCE(root_run_id, id) FROM automation_runs WHERE id = $1)
          ORDER BY r.started_at ASC NULLS FIRST, r.id ASC, s.started_at NULLS LAST, s.step_id, s.attempts`,
        [runId],
    );
    const byStep = new Map();
    for (const row of rows) byStep.set(`${row.step_id}#${row.attempts}`, row);
    return [...byStep.values()].map(rowToRunStep);
}

/**
 * The NEWEST leg of `runId`'s journey — the one carrying its current state,
 * whether that is running, paused or terminal. For a run that was never paused
 * this is the run itself.
 *
 * This is what a public form's poll must read: a resume hands off to a child
 * run, so the run the form SESSION points at may already be a finished handoff
 * while the work continues elsewhere.
 */
async function getLatestRunInChain(runId) {
    await initDB();
    const row = await getOne(
        `SELECT * FROM automation_runs
          WHERE COALESCE(root_run_id, id) = (SELECT COALESCE(root_run_id, id) FROM automation_runs WHERE id = $1)
          ORDER BY started_at DESC NULLS LAST, id DESC
          LIMIT 1`,
        [runId],
    );
    return rowToRun(row);
}

/**
 * Step rows for SEVERAL runs in one query — the replay seeding's loader
 * (BFSF-359).
 *
 * runPartial rebuilds a step's upstream from the last REPLAY_RUN_WINDOW runs.
 * Doing that with getRunSteps() is N+1, and `SELECT *` drags ten runs' worth of
 * input_json across the wire so the seeding can read six columns — on an
 * API-heavy routine that is most of the "several seconds" a single ▶ Execute
 * costs.
 *
 * NOT a drop-in replacement for getRunSteps: the projection omits input_json
 * and pii_json, so `input` and the PII summary come back undefined. It exists
 * for the replay seeding, which reads status/output/error/errorClass only.
 * Anything that needs the full row must keep using getRunSteps.
 *
 * Ordering matches getRunSteps within each run (attempts ASC last), because the
 * seeding relies on a later attempt overwriting an earlier one.
 */
async function getRunStepsForRuns(runIds) {
    await initDB();
    const ids = (Array.isArray(runIds) ? runIds : []).filter(Boolean);
    if (!ids.length) return [];
    const rows = await getAll(
        `SELECT run_id, step_id, parent_step_id, step_type, attempts, status,
                started_at, finished_at, output_json, error, error_class, branch_index
           FROM automation_run_steps
          WHERE run_id = ANY($1)
          ORDER BY run_id, started_at NULLS LAST, step_id, attempts`,
        [ids],
    );
    return rows.map(rowToRunStep);
}

module.exports = { createRun, getRun, getRunsForAutomation, getRecentRunsForUser, listRunsForUser, listRunsForOrg, listRunsForAutomation, getRunFacetsForUser, getRunFacetsForOrg, getRunFacetsForAutomation, getRunCountForUserSince, getRecentRunStatusesForUser, getRunCountsForProjects, touchRunHeartbeat, getActiveRunsForUser, updateRun, requestCancelRun, recordRunStep, getRunSteps, getRunStepsForRuns, getRunsInChain, getRunStepsForChain, getLatestRunInChain, getRunTokenMap, saveRunTokenMap, encodeRunCursor, decodeRunCursor, buildRunFilterWhere, rowToOrgRunRow, RUN_FACET_AUTOMATIONS_CAP };
