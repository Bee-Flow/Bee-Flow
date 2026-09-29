/**
 * Knowledge bases in a Solution — the one member kind with no `project_id`.
 *
 * ── Why this kind is shaped differently ─────────────────────────────────────
 *
 * Every other member carries a nullable `project_id` on its own row. A
 * knowledge base does not: the link has always lived on the PROJECT, in
 * `projects.knowledge_base_ids` (JSONB), because a project's bases are what its
 * chats search and that list is read on every turn. Inverting it now would mean
 * two places that can disagree about which bases a project has, and the one
 * that would lose is the one retrieval reads.
 *
 * So this module is an ADAPTER: it gives the registry the same
 * `list / setProject` contract every other kind offers, on top of the array
 * that already exists. `stores/knowledgeBases.js` is only ever READ from here.
 *
 * Three consequences fall out of that, and each is load-bearing.
 *
 * 1. THERE IS NOTHING TO DETACH. Deleting a project deletes the row the link
 *    lives on; the base itself is untouched, in another table, still owned by
 *    whoever made it. So the registry entry declares `detaches: false` and no
 *    `clearProject` — not because a base is a record like an approval, but
 *    because the reference dies with the project by construction. The registry
 *    header's "true for every RESOURCE" is about resources whose link is on
 *    their own row, which is every other kind.
 *
 * 2. ATTACHING IS A READ GRANT, SO IT NEEDS THE REQUEST. Project chat searches
 *    the project's bases with no further check — `core/localKBIngest` performs
 *    no tenant filtering of its own and documents that its access boundary IS
 *    the id list, on the assumption that whoever supplied the ids authorised
 *    them. This is that upstream. A project editor naming any kb id would
 *    otherwise be able to read a base they have no access to, through the chat
 *    window. Hence `setProject` takes the request context and refuses outright
 *    when it cannot resolve who is asking: unknown must never become allowed.
 *
 *    DETACHING needs no such check. Taking an id out of a project's own array
 *    reveals nothing, and a member must always be able to remove a base the
 *    project should not have — including one they cannot themselves read.
 *
 * 3. THE WRITE IS COMPARE-AND-SWAP, LIKE `PUT /:id`. The column is replaced
 *    whole, so a blind read-modify-write here would delete a base a colleague
 *    added a second earlier and report success — the exact bug
 *    `projects.version` was added to stop. A conflict is RE-APPLIED against the
 *    fresh row (adding one id and removing one id are both idempotent, so
 *    re-running is safe) and, if it keeps losing, raised as a 409 rather than
 *    guessed at.
 */

'use strict';

/**
 * Caps so a single request cannot turn into thousands of sequential round
 * trips. Shared with the project routes on purpose: `PUT /api/projects/:id`
 * and this adapter write the same column, and two different ceilings would
 * mean one path could store a list the other refuses to accept.
 */
const MAX_KB_IDS = 50;

function httpError(status, message, code) {
    const err = new Error(message);
    err.status = status;
    if (code) err.code = code;
    return err;
}

/**
 * Validate that the linker may actually READ every KB they are attaching, and
 * that each one belongs to the project's organisation.
 *
 * Moved here from routes/projects.js unchanged, so the whole-array replace on
 * `PUT /api/projects/:id` and the single-id move on `PUT /:id/resources` apply
 * ONE rule. Its history is the reason it is worth keeping in one piece: the
 * check used to be "the row exists" plus a string compare on organization_id,
 * which let three different things through —
 *
 *   - another member's UNPUBLISHED draft KB (is_published was never consulted)
 *   - a shared_groups-restricted KB the linker is not a member of
 *   - literally any KB, whenever either org id was empty — the guard was
 *     written `if (projectOrganizationId && kb.organization_id && ...)`, and
 *     projects.organization_id defaults to '' rather than NULL
 *
 * `canUserAccessKB`, reached through `partitionAccessibleKBIds`, is the
 * codebase's documented single source of truth for KB read access — the same
 * function the list filter and the direct-chat KB picker use, so the paths
 * cannot drift.
 */
async function validateKnowledgeBaseIds(req, ids, projectOrganizationId) {
    if (!Array.isArray(ids) || ids.length === 0) return { ok: true, invalid: [] };
    if (ids.length > MAX_KB_IDS) return { ok: false, invalid: [], tooMany: true };

    const kbStore = require('../stores/knowledgeBases');
    const { partitionAccessibleKBIds } = require('../support/kbAccess');

    // Read access, via the shared request-shaped wrapper. Unknown ids count as
    // denied, so a guessed UUID cannot slip through.
    const { denied } = await partitionAccessibleKBIds(req, ids);
    const invalid = new Set(denied);

    // Cross-tenant guard. An empty org id on either side means "unresolved",
    // which is NOT the same as "matches" — only equally org-less pairs match.
    const projOrg = projectOrganizationId || '';
    for (const kbId of ids) {
        if (invalid.has(kbId)) continue;
        try {
            const kb = await kbStore.getKB(kbId);
            if (!kb || (kb.organization_id || '') !== projOrg) invalid.add(kbId);
        } catch (_) {
            invalid.add(kbId);
        }
    }
    return { ok: invalid.size === 0, invalid: [...invalid] };
}

function storedIds(project) {
    const ids = Array.isArray(project?.knowledgeBaseIds) ? project.knowledgeBaseIds : [];
    return ids.filter(id => typeof id === 'string' && id);
}

/**
 * The knowledge bases filed into one project.
 *
 * A base whose row cannot be READ is not silently skipped: `getKB` is allowed
 * to throw straight through to the caller, so the resources route answers
 * `null` for this section and the page says "could not load this" instead of
 * "this project has no knowledge bases". A base that is genuinely GONE (the row
 * resolves to nothing) is a different fact and is simply absent — that is a
 * deletion, not a failure to look.
 *
 * The projection is deliberately narrow. A member of the project may see WHICH
 * bases the project searches; `tenant_id`, `shared_groups`, `is_published` and
 * the document counts are the base's own governance and belong to the Knowledge
 * screens that enforce it.
 */
async function listProjectKnowledgeBases(projectId) {
    if (!projectId) return [];
    const projectStore = require('../stores/projectStore');
    const kbStore = require('../stores/knowledgeBases');

    const project = await projectStore.getProject(projectId);
    if (!project) return [];

    const out = [];
    for (const id of storedIds(project)) {
        const kb = await kbStore.getKB(id);      // may throw — see above
        if (!kb) continue;
        out.push({
            id: kb.id,
            name: kb.name,
            description: kb.description || '',
            icon: kb.icon || null,
            categoryId: kb.category_id || null,
            projectId,
        });
    }
    return out;
}

/**
 * Add a base to this project, or take it out.
 *
 * @param {string} kbId
 * @param {string} userId       the caller, for the audit trail the route writes
 * @param {string|null} projectId  the TARGET — null means "take it out"
 * @param {{req?: object, projectId?: string}} [ctx]
 *        `ctx.projectId` is the project being edited, and it is required in
 *        BOTH directions: unlike every other kind, the link is not on the
 *        resource, so "remove" has to say remove from WHERE. `ctx.req` is the
 *        request the access check is made against.
 * @returns {Promise<boolean>} false when the move was refused — the route turns
 *          that into "not found, or not yours to move".
 */
async function setKnowledgeBaseProject(kbId, userId, projectId, ctx = {}) {
    const target = ctx.projectId;
    if (!kbId || !target) return false;

    const projectStore = require('../stores/projectStore');
    const attach = !!projectId;

    if (attach) {
        // Refused rather than assumed: a caller that cannot be resolved is not
        // a caller with access. See the header.
        if (!ctx.req) return false;
        const project = await projectStore.getProject(target);
        if (!project) return false;
        const check = await validateKnowledgeBaseIds(ctx.req, [kbId], project.organizationId);
        if (!check.ok) return false;
    }

    // Compare-and-swap, retried against a fresh read. Both operations are
    // idempotent — "make sure this id is in the list" and "make sure it is
    // not" — so re-applying after somebody else's write is safe and keeps
    // their change instead of overwriting it.
    for (let attempt = 0; attempt < 3; attempt++) {
        const project = await projectStore.getProject(target);
        if (!project) return false;

        const current = storedIds(project);
        const next = attach
            ? (current.includes(kbId) ? current : [...current, kbId])
            : current.filter(id => id !== kbId);

        // Already in the state the caller asked for. Reporting success is the
        // truth, and writing anyway would bump the version under an editor who
        // changed nothing.
        if (next.length === current.length && next.every((id, i) => id === current[i])) return true;

        // Only when the list GROWS. A cap that also refused removals would trap
        // a project that is already over it — imported, or capped downwards
        // later — in the exact state it is being asked to leave.
        if (next.length > current.length && next.length > MAX_KB_IDS) {
            throw httpError(400, `At most ${MAX_KB_IDS} knowledge bases per project`, 'too_many_knowledge_bases');
        }

        // No readable version means no compare-and-swap, and a whole-array
        // replace without one silently deletes whatever a colleague just added.
        // Refuse instead of writing blind.
        if (!Number.isFinite(Number(project.version))) {
            throw httpError(409, 'This project could not be updated safely — reload and try again.', 'no_version');
        }

        const result = await projectStore.updateProject(
            target, { knowledgeBaseIds: next }, { expectedVersion: Number(project.version) },
        );
        if (!result) return false;                 // the project went away underneath us
        if (result.conflict) continue;             // somebody else wrote: re-read and re-apply
        return true;
    }

    throw httpError(409, 'Someone else changed this project at the same time. Try again.', 'conflict');
}

module.exports = {
    MAX_KB_IDS,
    validateKnowledgeBaseIds,
    listProjectKnowledgeBases,
    setKnowledgeBaseProject,
};
