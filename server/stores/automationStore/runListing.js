// @typecheck
/**
 * runListing.js — the reads behind the Runs tab's rows (handoff 5).
 *
 * The run LIST itself stays in runs.js (listRunsScoped); this module holds
 * what decorates a page of it and the search clause its WHERE builder uses:
 *
 *   buildRunSearch             the `q` filter as SQL (parameterised, bounded)
 *   getJourneyStepStatuses     the step rows of every leg of N journeys, as
 *                              status-only projections (no input/output JSON)
 *   getVersionDefinitions      the definition each (automation, version) ran
 *   getPendingApprovalIdsForRuns   the open approval a waiting leg waits on
 */

const { initDB, getAll } = require('./core');
const { fromJsonb } = require('./rowMappers');

const SEARCH_MAX = 100;
// A trigger payload larger than this is not searched: a whole inbound e-mail
// with attachments would make every keystroke a full JSON walk.
const SEARCH_PAYLOAD_MAX_BYTES = 64 * 1024;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** ILIKE-escape: the term is matched literally, never as a pattern. */
function likeTerm(term) {
    return `%${String(term).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The run-list search as one SQL clause over `r` (the journey head), `j` (its
 * newest leg, JOURNEY_LATERAL) and nothing else.
 *
 *   - A run link (anything carrying a run id) finds that run: exact, not fuzzy.
 *   - Otherwise a case-insensitive substring over: the run's summary, the
 *     outcome sentence (which carries the step label and a file name), the
 *     name of whoever started it or filled in its form, and, when `payload`
 *     is true, every STRING VALUE of the trigger payload (keys are not
 *     searched). The org-wide log passes payload:false: its rows deliberately
 *     never carry a colleague's payload, and a search over it would be a way
 *     to read it back one guess at a time.
 *
 * @param {string} q
 * @param {number} startIdx  the first $n this clause may use
 * @param {{ payload?: boolean }} [opts]
 * @returns {{ clause: string, params: any[] } | null}  null for an empty term
 */
function buildRunSearch(q, startIdx, { payload = true } = {}) {
    const term = String(q ?? '').replace(/\s+/g, ' ').trim().slice(0, SEARCH_MAX);
    if (!term) return null;
    const p = `$${startIdx}`;
    const id = term.match(UUID_RE);
    if (id) {
        return { clause: `(r.id = ${p} OR r.root_run_id = ${p} OR j.id = ${p})`, params: [id[0].toLowerCase()] };
    }
    const parts = [
        `COALESCE(j.summary, r.summary) ILIKE ${p}`,
        `(COALESCE(j.outcome_json, r.outcome_json) ->> 'text') ILIKE ${p}`,
        `EXISTS (SELECT 1 FROM users su
                  WHERE su.id IN (r.started_by_user_id, r.submitted_by_user_id)
                    AND (su."displayName" ILIKE ${p} OR su.username ILIKE ${p}))`,
    ];
    if (payload) {
        parts.push(`(r.trigger_payload IS NOT NULL
                     AND octet_length(r.trigger_payload::text) <= ${SEARCH_PAYLOAD_MAX_BYTES}
                     AND EXISTS (SELECT 1 FROM jsonb_path_query(r.trigger_payload::jsonb, 'lax $.**') pv
                                  WHERE jsonb_typeof(pv) = 'string' AND (pv #>> '{}') ILIKE ${p}))`);
    }
    return { clause: `(${parts.join(' OR ')})`, params: [likeTerm(term)] };
}

/**
 * Status-only step rows for every leg of the given journeys, keyed by the
 * journey's root run id. Oldest first within a journey, attempts ascending, so
 * a later attempt overwrites an earlier one when folded.
 *
 * @param {string[]} rootIds
 * @returns {Promise<Map<string, Array<{ stepId: string, parentStepId: string|null, stepType: string|null, status: string, attempts: number }>>>}
 */
async function getJourneyStepStatuses(rootIds, { query = null } = {}) {
    const read = query || getAll;
    const ids = [...new Set((Array.isArray(rootIds) ? rootIds : []).filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    if (!query) await initDB();
    const rows = await read(
        `SELECT COALESCE(r.root_run_id, r.id) AS root_id, s.step_id, s.parent_step_id, s.step_type, s.status, s.attempts
           FROM automation_run_steps s
           JOIN automation_runs r ON r.id = s.run_id
          WHERE COALESCE(r.root_run_id, r.id) = ANY($1)
          ORDER BY root_id, r.started_at NULLS LAST, s.started_at NULLS LAST, s.step_id, s.attempts`,
        [ids],
    );
    for (const r of rows) {
        if (!out.has(r.root_id)) out.set(r.root_id, []);
        out.get(r.root_id).push({
            stepId: r.step_id, parentStepId: r.parent_step_id ?? null, stepType: r.step_type ?? null,
            status: r.status, attempts: r.attempts ?? 1,
        });
    }
    return out;
}

/**
 * The saved definition of each (automation, version) pair, keyed `${id}@${version}`.
 * Pairs whose snapshot is missing are simply absent.
 *
 * @param {Array<{ automationId: string, version: number }>} pairs
 * @returns {Promise<Map<string, any>>}
 */
async function getVersionDefinitions(pairs, { query = null } = {}) {
    const read = query || getAll;
    const seen = new Set();
    const ids = [];
    const versions = [];
    for (const p of Array.isArray(pairs) ? pairs : []) {
        const v = Number(p?.version);
        if (!p?.automationId || !Number.isInteger(v)) continue;
        const key = `${p.automationId}@${v}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ids.push(String(p.automationId));
        versions.push(v);
    }
    const out = new Map();
    if (!ids.length) return out;
    if (!query) await initDB();
    const rows = await read(
        `SELECT DISTINCT ON (v.automation_id, v.version) v.automation_id, v.version, v.definition_json
           FROM automation_versions v
           JOIN unnest($1::text[], $2::int[]) AS want(automation_id, version)
             ON want.automation_id = v.automation_id AND want.version = v.version
          ORDER BY v.automation_id, v.version, v.saved_at DESC`,
        [ids, versions],
    );
    for (const r of rows) {
        const def = typeof r.definition_json === 'string' ? fromJsonb(safeJson(r.definition_json)) : fromJsonb(r.definition_json);
        if (def) out.set(`${r.automation_id}@${r.version}`, def);
    }
    return out;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

/**
 * The PENDING approval each of these runs waits on, keyed by run id.
 * @param {string[]} runIds
 * @returns {Promise<Map<string, string>>}
 */
async function getPendingApprovalIdsForRuns(runIds, { query = null } = {}) {
    const read = query || getAll;
    const ids = [...new Set((Array.isArray(runIds) ? runIds : []).filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    if (!query) await initDB();
    const rows = await read(
        `SELECT DISTINCT ON (run_id) id, run_id
           FROM automation_approvals
          WHERE run_id = ANY($1) AND status = 'pending'
          ORDER BY run_id, created_at DESC`,
        [ids],
    );
    for (const r of rows) out.set(r.run_id, r.id);
    return out;
}

module.exports = {
    buildRunSearch,
    getJourneyStepStatuses,
    getVersionDefinitions,
    getPendingApprovalIdsForRuns,
    SEARCH_MAX,
};
