// @typecheck

/**
 * The JOURNEY join: for a run row `r`, the newest run that shares its root.
 *
 * An automation that pauses on a form or an approval is continued by a CHILD run
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
 * routes started stamping it (routes/automation/crud.js), so every automation
 * that predates that change still has it NULL. A query narrowed to
 * `a.organization_id = $1` drops all of those without a word — an org-wide
 * runs list that silently loses the organisation's OLDEST automations, which is
 * the "0 that is not a 0" this codebase keeps finding. Any new org-wide read
 * over `automations` copies this JOIN rather than simplifying it.
 */
// LEFT, and the word is load-bearing. This join exists ONLY to reach
// `u."organizationId"` for the COALESCE below — `u` appears nowhere else in
// either query. As an INNER join it also silently decided WHICH runs the
// organisation is allowed to see: an automation whose owner no longer has a users
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
//   { org:  { orgId } }   — every run of every automation filed under one
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
/**
 * @param {number} [startIdx]
 */
function buildRunFilterWhere(scope, filters = {}, startIdx = 1) {
    const params = [];
    /** @type {string[]} */
    const clauses = [];
    let i = startIdx;
    /**
     * @param {string} sql
     */
    const add = (sql, val) => { clauses.push(sql.replace('$$', `$${i}`)); params.push(val); i++; };

    const userId = scope && scope.user ? scope.user.userId : null;
    const orgId = scope && scope.org ? scope.org.orgId : null;
    // Handoff 5 (sharing): ONE automation's runs, whoever owned it when they ran.
    // The route proves the caller's role on that automation first
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
    // Handoff 5: an automation in the trash is gone from every list, and so are
    // its runs (kept only for a restore). The one-automation scope is reached
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
        const search = require('./runListing').buildRunSearch(filters.q, i, { payload: !orgId, viewerUserId: filters.viewerUserId || userId || null });
        if (search) { clauses.push(search.clause); params.push(...search.params); i += search.params.length; }
    }
    return { clause: clauses.join(' AND '), params, nextIdx: i, joinUsers };
}

module.exports = { JOURNEY_LATERAL, JOURNEY_HEAD_ONLY, ORG_SCOPE_JOIN, buildRunFilterWhere };
