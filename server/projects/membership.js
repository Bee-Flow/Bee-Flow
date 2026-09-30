/**
 * What can live inside a project, and the things each kind must be able to do.
 *
 * A project row is one of two containers (`projects.kind`): a collaborative
 * WORKSPACE (people working together on chats, documents, notebooks, meeting
 * notes and knowledge) or a Studio SOLUTION (the builder's bundle of routines,
 * apps, pages, tables and agents that is exported and installed). A legacy row
 * from before that split has no kind yet and holds everything. Which kinds a
 * container takes is declared per kind below (`containers`).
 *
 * ── Why a registry ──────────────────────────────────────────────────────────
 *
 * Membership is a nullable `project_id` column per table rather than one
 * generic join table, and deliberately so: a join table is many-to-many by
 * default, and both the live feed and packaging depend on an entity belonging
 * to exactly ONE project. The column gives that as a schema invariant, plus the
 * partial indexes every listing already uses.
 *
 * The cost of N columns is N places that must agree — the resources listing,
 * the file-in/file-out switch, and the delete-time detacher. They did not agree
 * before: `automations.project_id` shipped in 2026-07 with its migration
 * unregistered and its detacher unwritten, so the column did not exist and
 * nothing read it. This registry is the single list all three read from, so
 * adding a kind is one entry and forgetting a hook is a test failure rather
 * than a silent hole.
 *
 * ── The rules a kind declares ───────────────────────────────────────────────
 *
 * `list`        — what the project page shows, given `(projectId, viewer)`.
 *                 Most kinds ignore the viewer: project role IS the
 *                 authorization, which is what makes a project a shared
 *                 workspace. Approvals do not — see below.
 * `countIn`     — how many of this kind each project in a LIST holds, as a
 *                 Map(projectId → number). The overview draws a card per
 *                 Solution with a tally on it, and doing that through `list`
 *                 would be one round-trip per project per kind, reading whole
 *                 rows to throw all but their number away. Declared by every
 *                 kind whose membership is a `project_id` COLUMN — the same six
 *                 that are movable and detachable — and by no other, for
 *                 reasons that differ per kind:
 *                   • knowledge bases are an array on the PROJECT row, so the
 *                     count is already in hand wherever the project is;
 *                   • approvals are viewer-scoped, and a count that ignored the
 *                     viewer would tell a project member how many decisions
 *                     they are not allowed to see.
 *                 A kind with no `countIn` is therefore not an oversight, and
 *                 `countableKinds()` below is what a caller iterates rather
 *                 than assuming every kind has one.
 * `setProject`  — file in / take out. Owner-only at the store level, ALWAYS:
 *                 filing something into a project exposes it to every member
 *                 without it being org-published, and that is the owner's call.
 *                 The route checks the caller's role on the TARGET project.
 *                 It receives a fourth argument, `ctx` = `{ req, projectId }`:
 *                 the project being edited and the request the move happens in.
 *                 Every kind whose link is a column on its own row ignores it —
 *                 `projectId = null` already says "take it out", and the row
 *                 says which project it was in. Knowledge bases need both
 *                 halves, and the reasons are in
 *                 projects/knowledgeBaseMembership.js.
 * `detaches`    — whether deleting the project clears the reference. True for
 *                 every resource whose link is a `project_id` COLUMN, because
 *                 deleting a project must never destroy what its members built.
 *                 False in exactly two cases, and for opposite reasons:
 *                 approvals (records, not resources — see below) and knowledge
 *                 bases (the link lives on the PROJECT row, so it dies with the
 *                 project by construction and there is nothing left to clear).
 * `containers`  — the project kinds this kind may live in: 'workspace',
 *                 'solution' or both. A legacy project (kind NULL) takes every
 *                 kind until its owner classifies it. The resources listing shows
 *                 only the sections its container takes (`sectionsFor`), and
 *                 filing checks the same list (`isAllowedIn`), so a routine
 *                 cannot be pushed into a workspace nor a meeting note into a
 *                 Solution that would carry it into an export.
 *
 * ── Content that people own: documents, meeting notes and notebooks ─────────
 *
 * Filing one of these into a workspace is what makes it readable to every
 * member, so it is the item OWNER's decision, as for every other kind. Taking it
 * OUT again is the one move with a second actor: the owner of the PROJECT may
 * remove a colleague's document, meeting note or notebook from their project
 * (it goes back to being its owner's private item, never deleted). The route
 * hands that fact in through `ctx.req.projectRole`, which is the role the
 * route's own gate resolved on `ctx.projectId`, the project being edited. A
 * removal is always scoped to that project: nobody takes an item out of a
 * project through another project's endpoint.
 *
 * Approvals are the deliberate odd one out, twice over.
 *
 * First, an approval is a decision, not a thing someone owns — stamped with its
 * project at INSERT, never moved (re-filing an automation moves its future
 * approvals, not past decisions), and never detached (an archived approval
 * keeps naming where the decision was made, exactly as `automation_title`
 * outlives the automation). So it declares a `list` and nothing else, and
 * `setProject` is absent rather than a stub that throws — code asking to move
 * an approval is a bug at the call site.
 *
 * Second, and this is the security-load-bearing half: its listing stays
 * VIEWER-SCOPED. Project role widens what you can see for every other kind, but
 * an approval carries a question, its details and its attachments, addressed to
 * named people. `projectId` therefore goes in as one of listApprovals' NARROWING
 * filters, intersected with the viewer scope that owner/assignee/requester/panel
 * seat/escalation-target already defines — so this can only ever shrink what the
 * caller could already see, never widen it. A project viewer sees the approvals
 * in this project that are theirs to see, not every approval in it.
 */

// The two containers a project can be, and the combinations a kind declares.
const CONTAINER_KINDS = Object.freeze(['workspace', 'solution']);
const ANYWHERE = Object.freeze(['workspace', 'solution']);
const SOLUTION_ONLY = Object.freeze(['solution']);
const WORKSPACE_ONLY = Object.freeze(['workspace']);

/**
 * File an owned content item into a project, or take it out of the project
 * being edited.
 *
 *   attach(id, userId, projectId)        file it in; the store matches the owner
 *   detachOwn(id, userId, fromProjectId)  the item's owner takes it out
 *   detachAny(id, fromProjectId)          the PROJECT owner takes it out, whoever
 *                                         owns the item; only out of that project
 *
 * @param {{ attach: Function, detachOwn: Function, detachAny: Function }} store
 * @param {string} id
 * @param {string} userId
 * @param {string|null} projectId  the target, or null to take it out
 * @param {{ req?: any, projectId?: string }} [ctx]
 * @returns {Promise<boolean>}
 */
async function fileOwnedContent(store, id, userId, projectId, ctx) {
    if (projectId) return store.attach(id, userId, projectId);
    const from = ctx?.projectId;
    // Without the project being edited there is nothing to scope a removal to,
    // and an unscoped removal by someone other than the owner is exactly what
    // this refuses to do.
    if (!from) return false;
    if (await store.detachOwn(id, userId, from)) return true;
    if (ctx?.req?.projectRole === 'owner') return store.detachAny(id, from);
    return false;
}

const documents = () => {
    const s = require('../stores/documentStore');
    return {
        attach: s.setDocumentProject,
        detachOwn: (id, userId, from) => s.detachDocumentFromProject(id, from, userId),
        detachAny: (id, from) => s.detachDocumentFromProject(id, from, null),
    };
};
const meetings = () => {
    const s = require('../stores/transcriptionStore');
    return {
        attach: s.setTranscriptionProject,
        detachOwn: (id, userId, from) => s.detachTranscriptionFromProject(id, from, userId),
        detachAny: (id, from) => s.detachTranscriptionFromProject(id, from, null),
    };
};
// Both removals are scoped to the project being edited, as for documents and
// meeting notes: an owner acting on a stale list of project A must not take a
// notebook out of project B, where it has moved since.
const notebooks = () => {
    const s = require('../stores/notebookStore');
    return {
        attach: s.setNotebookProject,
        detachOwn: (id, userId, from) => s.detachNotebookFromProject(id, from, userId),
        detachAny: (id, from) => s.detachNotebookFromProject(id, from, null),
    };
};

const KINDS = [
    {
        kind: 'notebook',
        section: 'notebooks',
        containers: ANYWHERE,
        detaches: true,
        list: (projectId) => require('../stores/notebookStore').listProjectNotebooks(projectId),
        countIn: (projectIds) => require('../stores/notebookStore').countProjectNotebooks(projectIds),
        setProject: (id, userId, projectId, ctx) => fileOwnedContent(notebooks(), id, userId, projectId, ctx),
        clearProject: (projectId) => require('../stores/notebookStore').clearProjectFromNotebooks(projectId),
    },
    {
        kind: 'document',
        section: 'documents',
        containers: WORKSPACE_ONLY,
        detaches: true,
        list: (projectId) => require('../stores/documentStore').listProjectDocuments(projectId),
        countIn: (projectIds) => require('../stores/documentStore').countProjectDocuments(projectIds),
        setProject: (id, userId, projectId, ctx) => fileOwnedContent(documents(), id, userId, projectId, ctx),
        clearProject: (projectId) => require('../stores/documentStore').clearProjectFromDocuments(projectId),
    },
    {
        kind: 'meeting',
        section: 'meetings',
        containers: WORKSPACE_ONLY,
        detaches: true,
        list: (projectId) => require('../stores/transcriptionStore').listProjectMeetings(projectId),
        countIn: (projectIds) => require('../stores/transcriptionStore').countProjectMeetings(projectIds),
        setProject: (id, userId, projectId, ctx) => fileOwnedContent(meetings(), id, userId, projectId, ctx),
        clearProject: (projectId) => require('../stores/transcriptionStore').clearProjectFromTranscriptions(projectId),
    },
    {
        kind: 'automation',
        section: 'automations',
        containers: SOLUTION_ONLY,
        detaches: true,
        list: (projectId) => require('../stores/automationStore').getAutomationsForProject(projectId),
        countIn: (projectIds) => require('../stores/automationStore').countAutomationsForProject(projectIds),
        // The automation update path has no owner predicate of its own, so the
        // ownership check every other kind gets from its UPDATE ... AND
        // user_id = $n is made explicit here instead.
        setProject: async (id, userId, projectId) => {
            const store = require('../stores/automationStore');
            const automation = await store.getAutomation(id);
            if (!automation || automation.userId !== userId) return false;
            await store.updateAutomation(id, { projectId }, userId);
            return true;
        },
        clearProject: (projectId) => require('../stores/automationStore').clearProjectFromAutomations(projectId),
    },
    {
        kind: 'app',
        section: 'apps',
        containers: SOLUTION_ONLY,
        detaches: true,
        list: (projectId) => require('../stores/studioAppStore').listProjectApps(projectId),
        countIn: (projectIds) => require('../stores/studioAppStore').countProjectApps(projectIds),
        setProject: (id, userId, projectId) =>
            require('../stores/studioAppStore').setAppProject(id, userId, projectId),
        clearProject: (projectId) => require('../stores/studioAppStore').clearProjectFromApps(projectId),
    },
    {
        kind: 'webpage',
        section: 'webpages',
        containers: SOLUTION_ONLY,
        detaches: true,
        list: (projectId) => require('../stores/webpageStore').listProjectWebpages(projectId),
        countIn: (projectIds) => require('../stores/webpageStore').countProjectWebpages(projectIds),
        setProject: (id, userId, projectId) =>
            require('../stores/webpageStore').setWebpageProject(id, userId, projectId),
        clearProject: (projectId) => require('../stores/webpageStore').clearProjectFromWebpages(projectId),
    },
    {
        kind: 'datatable',
        section: 'datatables',
        containers: SOLUTION_ONLY,
        detaches: true,
        list: (projectId) => require('../stores/datatableStore').listDatatablesForProject(projectId),
        countIn: (projectIds) => require('../stores/datatableStore').countDatatablesForProject(projectIds),
        // Deliberately NOT through updateDatatableMeta: `projectId` is not one
        // of META_COLUMNS, and putting it there would let the metadata PATCH
        // file a table into a project the caller has no role on at all. The
        // store's own statement carries the owner predicate instead.
        setProject: (id, userId, projectId) =>
            require('../stores/datatableStore').setDatatableProject(id, userId, projectId),
        clearProject: (projectId) => require('../stores/datatableStore').clearProjectFromDatatables(projectId),
    },
    {
        kind: 'agent',
        section: 'agents',
        containers: SOLUTION_ONLY,
        detaches: true,
        list: (projectId) => require('../stores/agentStore').listProjectAgents(projectId),
        countIn: (projectIds) => require('../stores/agentStore').countProjectAgents(projectIds),
        setProject: (id, userId, projectId) =>
            require('../stores/agentStore').setAgentProject(id, userId, projectId),
        clearProject: (projectId) => require('../stores/agentStore').clearProjectFromAgents(projectId),
    },
    {
        kind: 'knowledge_base',
        section: 'knowledgeBases',
        containers: ANYWHERE,
        // The one kind with no project_id column: the link is an entry in
        // `projects.knowledge_base_ids`, so it goes when the project row goes
        // and a detacher would have nothing to do. `false` + no clearProject is
        // the honest pair, and the registry test below is what forces the
        // choice to be made rather than half-made.
        detaches: false,
        list: (projectId) => require('./knowledgeBaseMembership').listProjectKnowledgeBases(projectId),
        // Takes the ctx every setProject is handed: attaching a base is a READ
        // GRANT (project chat searches these ids with no further check), so it
        // needs the request to answer "may this person read it", and removing
        // needs to know which project to remove it FROM.
        setProject: (id, userId, projectId, ctx) =>
            require('./knowledgeBaseMembership').setKnowledgeBaseProject(id, userId, projectId, ctx),
    },
    {
        kind: 'approval',
        section: 'approvals',
        containers: SOLUTION_ONLY,
        detaches: false,          // a record, not a resource — see the header
        // Viewer-scoped on purpose. Passing no viewer would not show everything
        // — buildApprovalWhere fails CLOSED and returns nothing — but the point
        // is the contract, not the fallback: projectId is a narrowing filter
        // over the caller's own scope.
        list: async (projectId, viewer) => {
            if (!viewer?.userId) return [];
            const { approvals } = await require('../stores/automationStore')
                .listApprovals({ viewer, projectId, limit: 50 });
            return approvals;
        },
    },
];

const BY_KIND = new Map(KINDS.map(k => [k.kind, k]));

/** Every kind, in the order the project page shows them. */
function listKinds() { return KINDS; }

/** One kind by its `kind` string, or undefined. */
function getKind(kind) { return BY_KIND.get(kind); }

/** The kinds a caller may file in and out — i.e. those with a setProject. */
function movableKinds() { return KINDS.filter(k => typeof k.setProject === 'function'); }

/** The kinds a project delete must detach. */
function detachableKinds() { return KINDS.filter(k => k.detaches); }

/**
 * The kinds that can be tallied across a LIST of projects in one query — i.e.
 * those with a `countIn`. See the header for why the other two are absent by
 * design rather than unfinished.
 */
function countableKinds() { return KINDS.filter(k => typeof k.countIn === 'function'); }

/**
 * The kinds a container of this kind holds, in registry order.
 *
 * `null`/`undefined` is a legacy project that has not been classified yet: it
 * holds every kind. An unknown container kind holds nothing — the column is
 * CHECK-constrained, so an unknown value is a bug, and a listing that fails
 * closed is the safe way to meet one.
 *
 * @param {string|null|undefined} containerKind  'workspace' | 'solution' | null
 */
function kindsFor(containerKind) {
    if (containerKind === null || containerKind === undefined) return KINDS;
    if (!CONTAINER_KINDS.includes(containerKind)) return [];
    return KINDS.filter(k => k.containers.includes(containerKind));
}

/**
 * The response SECTION names (`notebooks`, `documents`, ...) a container of
 * this kind shows, in registry order. `null`/`undefined` → every section.
 *
 * @param {string|null|undefined} containerKind
 * @returns {string[]}
 */
function sectionsFor(containerKind) { return kindsFor(containerKind).map(k => k.section); }

/**
 * May an item of `kind` live in a container of `containerKind`?
 *
 * A legacy project (null) takes every registered kind. An unregistered kind,
 * or an unknown container kind, is never allowed.
 *
 * @param {string} kind              a registry kind, e.g. 'document'
 * @param {string|null|undefined} containerKind
 */
function isAllowedIn(kind, containerKind) {
    const entry = BY_KIND.get(kind);
    if (!entry) return false;
    if (containerKind === null || containerKind === undefined) return true;
    return entry.containers.includes(containerKind);
}

module.exports = {
    listKinds, getKind, movableKinds, detachableKinds, countableKinds,
    kindsFor, sectionsFor, isAllowedIn, CONTAINER_KINDS,
};
