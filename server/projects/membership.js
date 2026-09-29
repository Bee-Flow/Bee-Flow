/**
 * What can live inside a Solution, and the three things each kind must be able
 * to do.
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

const KINDS = [
    {
        kind: 'notebook',
        section: 'notebooks',
        detaches: true,
        list: (projectId) => require('../stores/notebookStore').listProjectNotebooks(projectId),
        countIn: (projectIds) => require('../stores/notebookStore').countProjectNotebooks(projectIds),
        setProject: (id, userId, projectId) =>
            require('../stores/notebookStore').setNotebookProject(id, userId, projectId),
        clearProject: (projectId) => require('../stores/notebookStore').clearProjectFromNotebooks(projectId),
    },
    {
        kind: 'automation',
        section: 'automations',
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

module.exports = { listKinds, getKind, movableKinds, detachableKinds, countableKinds };
