// @typecheck
/**
 * Project Store — PostgreSQL-backed projects.
 *
 * One table holds two kinds of container, told apart by `projects.kind`:
 *   - 'workspace'  a collaborative project (chats, documents, notebooks,
 *                  meetings, knowledge) — the Projects page;
 *   - 'solution'   a Studio Solution (automations, apps, webpages, tables,
 *                  agents) with export/import/install/upgrade;
 *   - NULL         legacy: created before the split and not classifiable from
 *                  its contents. Listed in BOTH places until its owner picks
 *                  one (`setProjectKind`, allowed while it is NULL, and once
 *                  more to correct a kind the backfill only guessed).
 * The ids never change with the kind, so Blueprint keys (`sol_<projectId>`),
 * every `project_id` column, shares and the event feed keep working.
 *
 * Tables:
 *   - projects:          core project data (name, instructions, owner, kind)
 *   - project_shares:    sharing records (user / group), permission ∈ {viewer, editor}
 *   - project_events:    the ordered live feed behind GET /:id/stream
 *   - project_activity:  audit feed (member changes, edits, kb/conversation moves)
 *                        and the content change feed (editing sessions)
 *   - project_member_state / project_item_reads: each member's visits and what
 *                        they last saw (the "since your last visit" and unread
 *                        marks; functions in stores/projectChanges.js)
 *
 * The functions are built by `makeProjectStore(db, { ready })` over a facade
 * with db.js's shape (`run`, `getOne`, `getAll`, `getClient`), so a test can
 * run them against pglite without replacing any module. The default instance
 * (the module's own exports) wraps db.js behind the store's schema init.
 *
 * Since the split the factory only wires the pieces together: the schema and
 * its init in stores/project/schema.js, row mapping and vocabularies in
 * project/rows.js,
 * CRUD in project/projects.js, the conversations filed in a project in
 * project/conversations.js, sharing and access in project/members.js, the
 * activity feed and live events in project/events.js, Solution stages in
 * project/stageLink.js. The exported keys are unchanged.
 */

const dbFacade = require('../db');
const { makeProjectChangeFns } = require('./projectChanges');
const { PROJECT_KINDS, normalizePermission } = require('./project/rows');
const { applyProjectSchema, initDB } = require('./project/schema');
const { makeProjectFns } = require('./project/projects');
const { makeConversationFns } = require('./project/conversations');
const { makeMemberFns } = require('./project/members');
const { EVENT_REPLAY_LIMIT, makeEventFns } = require('./project/events');
const { makeStageLinkFns } = require('./project/stageLink');

/**
 * The store's functions over one database facade.
 *
 * @param {{
 *   run: (sql: string, params?: any[]) => Promise<{ rowCount: number, rows?: any[] }>,
 *   getOne: (sql: string, params?: any[]) => Promise<any>,
 *   getAll: (sql: string, params?: any[]) => Promise<any[]>,
 *   getClient: () => Promise<{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>, release: () => void }>,
 * }} db  db.js, or a facade of the same shape (pglite in the store test)
 * @param {{ ready?: () => Promise<unknown>, managedParts?: { assertManagedWrite: Function } }} [opts]
 *        `ready`: the schema init every function awaits first; `managedParts`:
 *        the stage write guard (stores/lib/managedParts.js), default the app's
 *        instance (stores/managedPartsDefault.js)
 */
function makeProjectStore(db, { ready = async () => {}, managedParts = null } = {}) {
    const initDB = ready;
    // Required lazily: the default guard reads this module's default store.
    const guard = () => managedParts || require('./managedPartsDefault');
    const run = (sql, params) => db.run(sql, params);
    const getOne = (sql, params) => db.getOne(sql, params);
    const getAll = (sql, params) => db.getAll(sql, params);
    const getClient = () => db.getClient();

    const ctx = { run, getOne, getAll, getClient, initDB };
    const { stageOfProject, stageOfProjectFresh, refuseStageBound, createStageProject, detachStage } = makeStageLinkFns(ctx);
    const {
        createProject, getProject, listUserProjects, setProjectKind, setArchived, setInstalledVersion,
        setFilesKbId, updateProject, deleteProject,
    } = makeProjectFns({ ...ctx, guard, refuseStageBound });
    const {
        countChatHoldings, listSharedThreads, getOwnConversationFiling, countSharedThreads,
        assignConversation, unassignConversation,
    } = makeConversationFns(ctx);
    const {
        shareProject, unshareProject, handOverProject, transferOwner, getProjectShares, getShareById,
        updateMemberRole, getProjectRole, userHasAccess,
    } = makeMemberFns({ ...ctx, refuseStageBound });
    const {
        logActivity, listActivity, appendProjectEvent, listProjectEvents, getProjectEventSeq, pruneProjectEvents,
    } = makeEventFns(ctx);

    // The change feed: editing sessions, visits and seen marks.
    const changes = makeProjectChangeFns({ getOne, getAll, run, getClient, ready: initDB });

    return {
        ...changes,
        createProject,
        getProject,
        listUserProjects,
        setProjectKind,
        setArchived,
        stageOfProject,
        stageOfProjectFresh,
        createStageProject,
        detachStage,
        setInstalledVersion,
        countChatHoldings,
        listSharedThreads,
        getOwnConversationFiling,
        setFilesKbId,
        countSharedThreads,
        updateProject,
        deleteProject,
        shareProject,
        unshareProject,
        handOverProject,
        transferOwner,
        getProjectShares,
        getShareById,
        updateMemberRole,
        assignConversation,
        unassignConversation,
        getProjectRole,
        userHasAccess,
        logActivity,
        listActivity,
        appendProjectEvent,
        listProjectEvents,
        getProjectEventSeq,
        pruneProjectEvents,
    };
}

// The instance the app uses: db.js, behind the store's schema init.
const store = makeProjectStore(dbFacade, { ready: initDB });

module.exports = {
    initDB,
    makeProjectStore,
    applyProjectSchema,
    PROJECT_KINDS,
    createProject: store.createProject,
    getProject: store.getProject,
    listUserProjects: store.listUserProjects,
    // The workspace / Solution split (see the header).
    setProjectKind: store.setProjectKind,
    setArchived: store.setArchived,
    // Solution stages (UAT / PRD): see the stage block of applyProjectSchema.
    stageOfProject: store.stageOfProject,
    stageOfProjectFresh: store.stageOfProjectFresh,
    createStageProject: store.createStageProject,
    detachStage: store.detachStage,
    setInstalledVersion: store.setInstalledVersion,
    countChatHoldings: store.countChatHoldings,
    listSharedThreads: store.listSharedThreads,
    getOwnConversationFiling: store.getOwnConversationFiling,
    setFilesKbId: store.setFilesKbId,
    countSharedThreads: store.countSharedThreads,
    updateProject: store.updateProject,
    deleteProject: store.deleteProject,
    shareProject: store.shareProject,
    unshareProject: store.unshareProject,
    handOverProject: store.handOverProject,
    transferOwner: store.transferOwner,
    getProjectShares: store.getProjectShares,
    getShareById: store.getShareById,
    updateMemberRole: store.updateMemberRole,
    assignConversation: store.assignConversation,
    unassignConversation: store.unassignConversation,
    getProjectRole: store.getProjectRole,
    userHasAccess: store.userHasAccess,
    logActivity: store.logActivity,
    listActivity: store.listActivity,
    normalizePermission,
    // Live feed (see the project_events DDL for the gapless-sequence rationale).
    appendProjectEvent: store.appendProjectEvent,
    listProjectEvents: store.listProjectEvents,
    getProjectEventSeq: store.getProjectEventSeq,
    pruneProjectEvents: store.pruneProjectEvents,
    EVENT_REPLAY_LIMIT,
    // The change feed (stores/projectChanges.js): the audit row and its live
    // event in one transaction, editing sessions, visits and seen marks.
    recordActivityEvent: store.recordActivityEvent,
    recordContentSession: store.recordContentSession,
    recordVisit: store.recordVisit,
    markAllSeen: store.markAllSeen,
    getMemberState: store.getMemberState,
    markItemSeen: store.markItemSeen,
    listItemReads: store.listItemReads,
    listChangeRows: store.listChangeRows,
    listChangeLog: store.listChangeLog,
    eraseUserChangeState: store.eraseUserChangeState,
};
