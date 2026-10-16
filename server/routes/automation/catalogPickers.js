'use strict';

/**
 * Builder catalog: the pickers of GET /catalog that depend on who is asking
 * (datatables, knowledge bases, agents), plus the two static option lists.
 * Extracted from catalog.js. A datatable or knowledge-base outage degrades
 * to an empty list; an agent outage is reported beside the list.
 */

const log = require('../../telemetry/log');

// What a knowledge_write node can do about a near-duplicate,
// declared once so the editor's dropdown and the runner cannot
// drift. The order is the order the dropdown offers them.
const KNOWLEDGE_WRITE_STRATEGIES = [
    { value: 'skip', label: 'Keep what is there', blurb: 'If the base already holds nearly the same text, leave it alone.' },
    { value: 'merge', label: 'Merge into one', blurb: 'Combine the two into a single, richer document.' },
    { value: 'replace', label: 'Replace it', blurb: 'Overwrite the near-identical document with this one.' },
    { value: 'add', label: 'Add it anyway', blurb: 'Store it as its own document, even if a similar one exists.' },
];

// What a datatable node can do, declared once so the editor's
// dropdown and the AI builder's prompt cannot drift.
const DATATABLE_OPS = [
    { op: 'find_rows', label: 'Find rows', blurb: 'Look rows up. Nothing is changed.', writes: false },
    { op: 'count_rows', label: 'Count rows', blurb: 'How many rows match — the real total, not one page of them.', writes: false },
    { op: 'add_row', label: 'Add a row', blurb: 'Always adds a new row, even if a matching one exists.', writes: true },
    { op: 'save_row', label: 'Add or update a row', blurb: 'Updates the row that matches, or adds it if there is not one yet.', writes: true },
    { op: 'update_rows', label: 'Update rows that match', blurb: 'Changes every row that matches. Needs at least one condition.', writes: true },
    { op: 'delete_rows', label: 'Delete rows that match', blurb: 'Removes every row that matches. Needs at least one condition.', writes: true },
];

/** The tables THIS caller may use. */
async function loadDatatables(req, userId) {
    // The tables THIS caller may use, already filtered by the same grade
    // resolver the runner uses. The canvas has nowhere to hang a permission
    // check, so availability has to arrive pre-filtered — exactly as `apps`
    // does. One shape carries the columns too, so the editor can offer a
    // column picker without a second round trip.
    let datatables = [];
    try {
        const { resolveDatatablePrincipal } = require('../../auth/datatableAccess');
        const { buildDatatableCatalogForUser } = require('../../automation/builderDatatableCatalog');
        // The org comes from `users`, not from the session — this picker was
        // empty for every member whose login shape omits organizationId,
        // and the catch below swallowed the fact that it never even looked.
        // The list itself is built by the same module the AI builder
        // reads its "Datatables you may use" block from, so the picker
        // and the prompt cannot offer two different sets of tables.
        const principal = await resolveDatatablePrincipal(req);
        datatables = await buildDatatableCatalogForUser(userId, { principal });
    } catch (e) {
        // A datatable outage must not take the whole catalog down; the
        // picker renders its empty state and every other node still works.
        log.warn('[automation/catalog] datatables unavailable:', e.message);
    }
    return datatables;
}

/** The knowledge bases this caller may write to. */
async function loadKnowledgeBases(req, userId) {
    /**
     * The knowledge bases this caller may WRITE to — the `knowledge_write`
     * node's picker (K10).
     *
     * Pre-filtered for the same reason the datatables are: the canvas has
     * nowhere to hang a permission check, so an id must not be offerable
     * unless it is allowed. And the predicate is the WRITE one
     * (`canUserManageKB`), not the read one: a person can read a dozen
     * bases they must not add documents to, and offering those would put an
     * id in the definition that the save check then refuses — the picker
     * teaching the author to build something invalid.
     *
     * `canWrite` rather than a filtered list, so a base the author can see
     * but not write to is shown DISABLED with the reason, the way the
     * datatable picker already does it. A picker that silently omits what
     * you were looking for reads as a bug.
     */
    let knowledgeBases = [];
    try {
        const { resolveUserOrgIds, hasPermission, resolveUserGroups } = require('../../auth');
        // `userId` is the handler's own, from req.session.user — reaching
        // for req.user here would have been undefined, and an undefined
        // userId makes canUserManageKB's owner test silently false for
        // every base somebody owns.
        // Never null: `canUserManageKB` reads a null `orgIds` as super-admin
        // and returns true for every base there is.
        const resolved = await resolveUserOrgIds(req);
        const orgIds = resolved instanceof Set ? resolved : new Set(Array.isArray(resolved) ? resolved : []);
        const canManage = await hasPermission(userId, 'manage_knowledge').catch(() => false);
        // resolveUserGroups takes a USER ID, not the request — the KB routes
        // wrap it for exactly this reason (routes/knowledgeBases/shared.js).
        // Called with `req` it resolved to [], so filterByGroupAccess dropped
        // every group-restricted base out of the picker, including ones the
        // author manages and the save-time gate would have allowed.
        const userGroups = await resolveUserGroups(userId).catch(() => []);
        // isOrgAdmin, like routes/knowledgeBases/list.js: without it an org
        // admin is shown fewer bases here than in the Knowledge Studio, and
        // the ones missing are exactly the unpublished ones they manage.
        let isOrgAdmin = false;
        try { isOrgAdmin = await require('../../support/kbAccess').resolveIsOrgAdmin(req); } catch (_) { isOrgAdmin = false; }
        knowledgeBases = await require('../../automation/builderPickerCatalog')
            .listKnowledgeBasePicker({ userId, orgIds, userGroups, canManage, isOrgAdmin });
    } catch (e) {
        // Same posture as the datatables above: the picker renders its
        // empty state and every other node still works.
        log.warn('[automation/catalog] knowledge bases unavailable:', e.message);
    }
    return knowledgeBases;
}

/** The agents an ai_step may use, with `agentsError` set when the read failed. */
async function loadAgents(req, userId) {
    /**
     * The agents an ai_step may hand its thinking to (R2).
     *
     * ── A FAILED READ IS NOT "NO AGENTS" ────────────────────────
     * This is the ONE list in this response that does not fail to an empty
     * array. Datatables and knowledge bases can: an empty picker there
     * reads as "nothing linked yet", which is a normal state of a normal
     * workspace. An empty AGENT picker is not — every workspace that got
     * as far as building an automation has agents — so an empty list on a
     * failed read would tell the author their agents are gone and send
     * them looking in the wrong place. `agentsError` carries the failure
     * instead, and the editor says "could not check" rather than "none".
     *
     * ── WHAT IS IN IT, AND WHY IT IS BOTH LISTS ─────────────────
     * The author's OWN agents (including the ones still on draft) plus the
     * published agents their org and groups show them. Own-first, because
     * `agentPickerRows` dedupes first-wins and the own row carries the
     * concept state of an agent that appears in both.
     *
     * A row that cannot be used still ships, with the reason — see the
     * header of automation/agentPickerRows.js for why that is safe here
     * and deliberately not safe in the validator.
     */
    // The list itself is built by automation/builderPickerCatalog.js, the same
    // function the AI builder reads its "Agents you may use" block from. The
    // principal is the one this request already resolved (and cached on req).
    const agentRead = await (async () => {
        try {
            const { resolveDatatablePrincipal } = require('../../auth/datatableAccess');
            // The HOME organisation from the user row — `principal.organizationId`,
            // not `principal.orgId` (see buildAgentPickerForUser).
            return await require('../../automation/builderPickerCatalog')
                .buildAgentPickerForUser(userId, { principal: await resolveDatatablePrincipal(req) });
        } catch (e) {
            log.warn('[automation/catalog] agents unavailable:', e.message);
            return { agents: [], agentsError: e.message || 'agent list unavailable' };
        }
    })();
    return agentRead;
}

module.exports = { KNOWLEDGE_WRITE_STRATEGIES, DATATABLE_OPS, loadDatatables, loadKnowledgeBases, loadAgents };
