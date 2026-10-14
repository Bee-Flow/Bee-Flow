/**
 * Project Routes — REST API for organizing chats into projects.
 *
 * GET    /?kind=workspace|solution  → list user's projects (legacy rows in both)
 * POST   /                          → create project (kind defaults to workspace)
 * GET    /:id                       → get project details + shares  (viewer+)
 * PUT    /:id                       → update project                (editor+)
 * PUT    /:id/kind                  → classify a legacy project     (owner; routes/projects/kind.js)
 * DELETE /:id                       → delete project                (owner)
 * POST   /:id/share                 → share with user/group         (owner)
 * DELETE /:id/share/:shareId        → unshare                       (owner)
 * PUT    /:id/conversations         → assign/unassign conversations (editor+)
 * DELETE /conversations/:convId     → detach MY OWN conversation    (any authed user; routes/projects/threads.js)
 *
 * Roles are enforced by the shared ladder in auth/projectAccess.js, which the
 * chat, memory, notebook and automation paths use too — one implementation, so
 * the surfaces cannot drift.
 *
 * Members (members are project_shares; "owner" is implicit via projects.owner_id),
 * in routes/projects/members.js:
 * GET    /:id/members               → list owner + members          (viewer+)
 * PUT    /:id/members/:memberId     → change a member's role        (owner)
 * DELETE /:id/members/:memberId     → remove a member or self-leave (owner OR self; the owner cannot leave)
 * POST   /:id/transfer-owner        → hand the project to a member    (owner, or an org admin)
 *
 * Mute, activity feed, live stream and typing, in routes/projects/activity.js:
 * PUT    /:id/mute                  → mute this project's notifications for me   (viewer+)
 * DELETE /:id/mute                  → unmute                                     (viewer+)
 * GET    /:id/activity?limit=&offset=  (viewer+)
 *
 * Resources filed into the project, the graph and completeness, in
 * routes/projects/resources.js.
 *
 * This file is the composition root: it builds the shared collaborators (the
 * change feed, the filing service, the teardown, the role gate) over its own
 * store handles, keeps the core CRUD, and mounts every sub-router in an order
 * routes/projects.routetable.test.js freezes.
 *
 * Every body and query a handler reads is checked by a closed schema in
 * routes/projects/schemas.js (validate()), after the role gate.
 *
 * Two kinds of project live behind this router (stores/projectStore.js):
 * collaborative projects (`kind: 'workspace'`) and Studio Solutions
 * (`kind: 'solution'`); `kind: null` is a legacy row that belongs to both until
 * its owner classifies it. What each may hold is the membership registry's
 * answer (projects/membership.js `sectionsFor` / `isAllowedIn`); chats are
 * never filed into a Solution (SOLUTION_HOLDS_NO_CHATS below, and
 * auth/projectAccess.resolveRequestedProject for the chat paths).
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const projectStore = require('../stores/projectStore');
const notificationPrefsStore = require('../stores/notificationPrefsStore');
const { makeCollabNotifier } = require('../projects/collabNotify');
const membership = require('../projects/membership');
const { buildProjectGraph } = require('../projects/graph');
const { buildGraphForProject: buildGraphFor } = require('../projects/graphForProject');
const userStore = require('../stores/userStore');
const { resolveUserGroups } = require('../auth');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { validate } = require('../core/http/validate');
const { HttpError, notFound } = require('../core/http/errors');
const S = require('./projects/schemas');
const { orgScope } = require('../auth/orgScope');

// The bell for membership changes (routes/projects/members.js tells it).
const collabNotifier = makeCollabNotifier();

// Length caps applied at the boundary so the DB stays tidy and the UI's
// matching maxLength attributes give immediate feedback.
const NAME_MAX = 120;
const DESCRIPTION_MAX = 1000;
const INSTRUCTIONS_MAX = 8000;

function validateLengths({ name, description, customInstructions }) {
    if (name !== undefined && typeof name === 'string' && name.length > NAME_MAX) {
        return `Name exceeds ${NAME_MAX} characters`;
    }
    if (description !== undefined && typeof description === 'string' && description.length > DESCRIPTION_MAX) {
        return `Description exceeds ${DESCRIPTION_MAX} characters`;
    }
    if (customInstructions !== undefined && typeof customInstructions === 'string' && customInstructions.length > INSTRUCTIONS_MAX) {
        return `Custom instructions exceed ${INSTRUCTIONS_MAX} characters`;
    }
    return null;
}

// Caps so a single request can't turn into thousands of sequential round-trips.
const MAX_CONVERSATION_BATCH = 200;

/**
 * The knowledge-base half of a project lives next door, in
 * projects/knowledgeBaseMembership.js.
 *
 * It moved there when knowledge bases became a member KIND: the registry's
 * file-in/file-out switch writes the same `knowledge_base_ids` column this
 * route does, and two copies of "may this person link this base" is two copies
 * that drift — with a cross-tenant KB link as the thing that gets through. The
 * function itself is unchanged; only its address is.
 */
const {
    MAX_KB_IDS, validateKnowledgeBaseIds, checkProjectKnowledgeBaseIds,
} = require('../projects/knowledgeBaseMembership');

/**
 * Write the audit trail AND the live feed, in ONE transaction
 * (projects/changeFeed.recordProjectChange): project_activity is the durable,
 * human-readable history; project_events the ordered channel clients tail.
 * Written together, the two can never disagree (an audit row nobody was told
 * about, or an event with no row behind it); the doorbell rings after the
 * commit. Never throws: an action that was saved has not failed because its
 * feed entry could not be written (the recorder logs it).
 *
 * `kind` is the activity action, so a member change arrives as `member_added`
 * and a client can react to it specifically. `details` holds ids and counts.
 * The feed is built over this router's own projectStore, so the route tests'
 * store doubles see what it writes.
 */
const { recordProjectChange, recordItemMoved } = require('../projects/changeFeed').makeChangeFeed({ store: projectStore });

// Something a project compliance check reads changed (ids only).
const { signalProjectChanged } = require('./projects/complianceSignal');
// What happens to a notebook's or page's co-editing state, comment threads and
// compliance signal when it leaves a project, or the project is deleted.
const itemLifecycle = require('../core/projectContent/itemLifecycle');
const itemFiling = require('../projects/itemFiling').makeItemFiling({
    feed: { recordProjectChange, recordItemMoved }, lifecycle: itemLifecycle,
});

// Fold back, detach, delete, remove the files base: the one order a project
// delete may take, shared with account erasure (projects/projectTeardown.js).
// Built over this router's own stores, so the route tests' doubles see it.
const projectTeardown = require('../projects/projectTeardown').makeProjectTeardown({
    store: projectStore, lifecycle: itemLifecycle, membership, log,
    removeFilesKb: (project) => require('../projects/projectFiles').removeFilesKb(project),
});

function getUserId(req) { return req.session?.user?.id; }
// Read groups from the DB on every request, not from req.session — group
// removals must take effect without forcing a re-login. Mirrors the pattern
// used by the agents and KB routes.
function getUserGroups(req) {
    return resolveUserGroups(getUserId(req));
}

// ── Workspace or Solution ────────────────────────────────
//
// Chats are filed into and shared into collaborative projects only. A legacy
// project (kind null) still takes them until its owner classifies it.
const { SOLUTION_HOLDS_NO_CHATS } = require('./projects/threads');

/**
 * 409 for a delete that would orphan `count` shared conversations.
 *
 * Only a chat's OWN owner can unshare it (it is re-encrypted under their key;
 * routes/projects/threads.js), who may not be the project owner asking, and
 * may no longer even be a member. So the refusal names which chats and whose
 * (`details.chats`: ids only, the member list names the people), so the page
 * can say whom to ask.
 */
async function sharedChatsRemain(projectId, count) {
    const n = Math.max(1, Number(count) || 1);
    const details = { sharedChats: n };
    try {
        details.chats = await projectStore.listSharedThreads(projectId, { limit: 20 });
    } catch (err) {
        log.warn('[Projects] could not list the shared chats blocking a delete:', err.message);
    }
    return new HttpError(409, 'SHARED_CHATS_REMAIN',
        n === 1
            ? 'The 1 chat shared with this project must be made private first, by the person who shared it. A shared chat cannot outlive the project it is shared in.'
            : `The ${n} chats shared with this project must be made private first, by the people who shared them. A shared chat cannot outlive the project it is shared in.`,
        details);
}


// ── Role middleware ──────────────────────────────────────
// Lives in auth/projectAccess.js so the chat, memory, notebook and automation
// paths enforce the same ladder from the same code. Behaviour is unchanged:
// 404 when the caller has no role at all (project existence must not be
// probeable), 403 when the role is too low.
const { requireProjectRole: requireRole } = require('../auth/projectAccess');

// ── List / create ────────────────────────────────────────

// GET / — list user's projects (owned + shared). `?kind=` narrows the list to
// one side of the split; a legacy (unclassified) project is on both sides.
router.get('/', validate({ query: S.ListQuery }), async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const kind = req.query.kind || undefined;
    const includeArchived = req.query.includeArchived === '1';
    const projects = await projectStore.listUserProjects(userId, await getUserGroups(req), { kind, includeArchived });
    res.json(projects);
});

// POST / — create project
router.post('/', validate({ body: S.CreateBody }), async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { name, description, customInstructions, color, icon, knowledgeBaseIds, extractMemories } = req.body;
    // A collaborative project unless the caller asks for a Solution (the
    // Studio form does). Never NULL: only rows from before the split are.
    const kind = req.body.kind || 'workspace';
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

    const lenError = validateLengths({ name, description, customInstructions });
    if (lenError) return res.status(400).json({ error: lenError });

    // The organisation the account acts in: the one on the session, else the one the account resolves to
    // (a member whose organisation comes from a group has none on the session), else none.
    const organizationId = req.session?.user?.organizationId || (await orgScope(req)).orgId || '';

    if (knowledgeBaseIds !== undefined) {
        const kbCheck = await validateKnowledgeBaseIds(req, knowledgeBaseIds, organizationId);
        if (kbCheck.tooMany) {
            return res.status(400).json({ error: `At most ${MAX_KB_IDS} knowledge bases per project` });
        }
        if (!kbCheck.ok) {
            return res.status(400).json({ error: 'Unknown, inaccessible or cross-organisation knowledge bases', invalid: kbCheck.invalid });
        }
    }

    const project = await projectStore.createProject({
        name: name.trim(),
        description,
        customInstructions,
        color,
        icon,
        knowledgeBaseIds,
        extractMemories,
        ownerId: userId,
        organizationId,
        kind,
    });
    await recordProjectChange(project.id, userId, 'project_created', { name: project.name, kind: project.kind });
    res.json(project);
});

// ── Overview ─────────────────────────────────────────────
//
/**
 * GET /summary — one card per Solution for the Solutions overview. Solutions
 * and unclassified legacy projects only; a collaborative project is not listed.
 *
 * ORDERING. A one-segment path, so it MUST stay above the `/:id` family or
 * Express hands "summary" to requireProjectRole as a project id and the whole
 * screen 404s. routes/projects.routetable.test.js freezes that.
 *
 * NO PROJECT ROLE, because there is no project: the answer is a row per project
 * the caller can ALREADY see. listUserProjects (owner + shares) is the
 * authorisation, and projects/summary.js counts exactly the ids it is handed —
 * `?ids=` can only ever INTERSECT that list, never reach past it.
 *
 * WHAT COULD NOT BE READ IS SAID SO. Every tally can come back `null` with its
 * name in `unavailable`; the module header spells out why null and 0 must stay
 * different on this screen in particular. The 500 path carries the same shape
 * with an empty list rather than a bare error, so a client that renders the
 * body without checking the status shows nothing rather than a clean overview.
 *
 * Query: `ids` (comma-separated, narrowing), `checks=0` (skip the completeness
 * aggregation), `since` (ISO; start of "today" for the run tally, clamped to a
 * week so a stray value cannot ask for a full-table scan).
 */
const MAX_SUMMARY_PROJECTS = 60;
const MAX_SUMMARY_SINCE_MS = 7 * 24 * 60 * 60 * 1000;

router.get('/summary', validate({ query: S.SummaryQuery }), async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const groups = await getUserGroups(req);
        // The stage rows this person reaches (the entry point of a stage-only
        // operator). Asked BEFORE the Solutions: a failure here only blanks this
        // one list, never the overview.
        let operatedFailed = false;
        const stageRows = projectStore.listUserProjects(userId, groups, { kind: 'solution', onlyStages: true })
            .catch((err) => { operatedFailed = true; log.warn('[Projects] Summary: could not list the stages you operate:', err.message); return []; });

        // Solutions only, plus the legacy rows nobody has classified yet: a
        // collaborative project is not a Solution and gets no card here.
        // Archived Solutions get no card; they are counted so the overview can say so.
        const everything = await projectStore.listUserProjects(userId, groups, { kind: 'solution', includeArchived: true });
        const all = everything.filter(p => !p.archivedAt);
        const archived = everything.length - all.length;

        const wanted = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
        const picked = wanted.length ? all.filter(p => wanted.includes(p.id)) : all;
        const projects = picked.slice(0, MAX_SUMMARY_PROJECTS);

        // Bounded, and never in the future: a client clock that is ahead would
        // otherwise report every Solution as having run nothing today.
        const now = new Date();
        let since = null;
        const asked = req.query.since ? new Date(String(req.query.since)) : null;
        if (asked && !Number.isNaN(asked.getTime())) {
            since = new Date(Math.min(Math.max(asked.getTime(), now.getTime() - MAX_SUMMARY_SINCE_MS), now.getTime()));
        }

        const { summarizeProjects, stagesForSolutions, operatedStagesOf } = require('../projects/summary');
        const result = await summarizeProjects(projects, {
            stagesFor: stagesForSolutions,
            viewer: { userId, organizationId: req.session?.user?.organizationId || null },
            now,
            since,
            // Opt-OUT rather than opt-in: a card without a health status is the
            // thing this screen exists to show, so the default computes it and
            // the budget in projects/summary.js is what keeps it bounded.
            completenessFor: req.query.checks === '0' ? null : async (projectId) => {
                const { graph, members, unavailable } = await buildGraphForProject(projectId);
                const { collectCompleteness } = require('../projects/completeness');
                return collectCompleteness({ graph, ...members, unavailable });
            },
        });

        // Stage rows whose Dev Solution this person cannot see: `all`, not the
        // narrowed `?ids=` list, is what they can see.
        const operatedStages = operatedStagesOf(await stageRows, new Set(all.map(p => p.id)));
        res.json({
            ...result,
            operatedStages,
            archived,
            unavailable: operatedFailed ? [...result.unavailable, 'operatedStages'] : result.unavailable,
            hasMore: picked.length > projects.length,
        });
    } catch (err) {
        log.error('[Projects] Summary error:', err.message);
        res.status(500).json({
            error: 'Request failed',
            projects: [], operatedStages: [], unavailable: ['all'], hasMore: false,
        });
    }
});

// ── Shared threads, and taking one's own chat back out ───
//
// DELETE /conversations/:convId (self-detach, no project role, registered
// here so it precedes every /:id route) and GET/POST/DELETE /:id/threads live
// in routes/projects/threads.js. A chat's owner can always withdraw it, member
// or not. Built over this router's own store and feed.
router.use('/', require('./projects/threads').makeThreadsRouter({
    requireProjectRole: requireRole,
    store: projectStore,
    recordProjectChange,
}));

// ── Read / update / delete ───────────────────────────────

// GET /:id — get project details + shares
router.get('/:id', requireRole('viewer'), async (req, res) => {
    const project = await projectStore.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const shares = await projectStore.getProjectShares(project.id);
    // The caller's own mute state; best-effort, a failing read must not hide the project.
    const muted = await notificationPrefsStore.isMuted(getUserId(req), project.id).catch(() => false);
    res.json({ ...project, shares, role: req.projectRole, muted: muted === true });
});

// PUT /:id — update project (editor+)
router.put('/:id', requireRole('editor'), validate({ body: S.UpdateBody }), async (req, res) => {
    const userId = getUserId(req);
    const before = await projectStore.getProject(req.params.id);
    if (!before) return res.status(404).json({ error: 'Not found' });

    const { name, description, customInstructions, color, icon, extractMemories, editorsCanInvite } = req.body;
    let { knowledgeBaseIds } = req.body;

    // Who may invite is the owner's call, not an editor's.
    if (editorsCanInvite !== undefined && req.projectRole !== 'owner') {
        throw new HttpError(403, 'owner_only_setting', 'Only the owner can change who may invite people.');
    }

    const lenError = validateLengths({ name, description, customInstructions });
    if (lenError) return res.status(400).json({ error: lenError });

    if (knowledgeBaseIds !== undefined) {
        // The project's own files base is skipped in the check and never
        // dropped (projects/knowledgeBaseMembership.js explains why).
        const kbCheck = await checkProjectKnowledgeBaseIds(req, knowledgeBaseIds, before);
        if (kbCheck.tooMany) {
            return res.status(400).json({ error: `At most ${MAX_KB_IDS} knowledge bases per project` });
        }
        if (!kbCheck.ok) {
            return res.status(400).json({ error: 'Unknown, inaccessible or cross-organisation knowledge bases', invalid: kbCheck.invalid });
        }
        knowledgeBaseIds = kbCheck.ids;
    }

    // Optimistic concurrency. The client sends the whole form — including a
    // whole-array knowledgeBaseIds replace — so without this two editors on
    // the Knowledge tab silently overwrite each other and the activity feed
    // records a kb_removed nobody performed. Clients that don't send a
    // version keep the old last-write-wins behaviour.
    const expectedVersion = req.body.version ?? req.get('If-Match');
    const updated = await projectStore.updateProject(req.params.id, {
        name, description, customInstructions, color, icon, knowledgeBaseIds, extractMemories, editorsCanInvite,
    }, { expectedVersion: expectedVersion === undefined ? undefined : Number(expectedVersion) });

    if (updated && updated.conflict) {
        return res.status(409).json({
            error: 'This project was changed by someone else while you were editing.',
            current: updated.current,
        });
    }
    // Deleted between the read above and the write: there is nothing left
    // to update, and reading fields off `null` below would be a 500.
    if (!updated) return res.status(404).json({ error: 'Not found' });

    // Log activity — diff what changed.
    const changes = {};
    for (const key of ['name', 'description', 'color', 'icon', 'extractMemories', 'editorsCanInvite']) {
        if (req.body[key] !== undefined && before[key] !== updated[key]) {
            changes[key] = { from: before[key], to: updated[key] };
        }
    }
    if (Object.keys(changes).length > 0) {
        await recordProjectChange(req.params.id, userId, 'project_updated', { changes });
    }
    if (req.body.customInstructions !== undefined && before.customInstructions !== updated.customInstructions) {
        await recordProjectChange(req.params.id, userId, 'instructions_updated', {});
    }
    if (knowledgeBaseIds !== undefined) {
        const beforeKBs = new Set(before.knowledgeBaseIds || []);
        const afterKBs = new Set(updated.knowledgeBaseIds || []);
        for (const kb of afterKBs) {
            if (!beforeKBs.has(kb)) {
                await recordProjectChange(req.params.id, userId, 'kb_added', { targetType: 'kb', targetId: kb });
            }
        }
        for (const kb of beforeKBs) {
            if (!afterKBs.has(kb)) {
                await recordProjectChange(req.params.id, userId, 'kb_removed', { targetType: 'kb', targetId: kb });
            }
        }
    }

    res.json(updated);
});

// PUT /:id/kind — classify a legacy project (or correct the backfill's guess,
// once) as a collaborative project or a Studio Solution. Owner only, and
// refused while it holds items the other side cannot hold
// (routes/projects/kind.js, projects/kindChange.js). Built over this router's
// own store, registry and feed, so the route tests' doubles see it too.
router.use('/', require('./projects/kind').makeKindRouter({
    requireProjectRole: requireRole,
    store: projectStore,
    kindChange: require('../projects/kindChange').makeKindChange({
        membership,
        store: projectStore,
        projectFiles: { listFiles: (project) => require('../projects/projectFiles').listFiles(project) },
    }),
    recordProjectChange,
}));

// POST /:id/archive and /:id/restore — the owner closes a project (read-only for everyone, hidden from
// the default list) and opens it again. Both are idempotent and pass `allowArchived`, as does DELETE.
router.post('/:id/archive', requireRole('owner', { allowArchived: true }), validate({ body: S.ArchiveBody }), async (req, res) => {
    const userId = getUserId(req);
    const project = req.project || await projectStore.getProject(req.params.id);
    if (!project) throw notFound();
    if (project.archivedAt) return res.json({ success: true, archivedAt: project.archivedAt });
    const updated = await projectStore.setArchived(project.id, userId);
    await recordProjectChange(project.id, userId, 'project_archived', {});
    signalProjectChanged(project, 'settings');
    res.json({ success: true, archivedAt: updated?.archivedAt || null });
});

router.post('/:id/restore', requireRole('owner', { allowArchived: true }), validate({ body: S.ArchiveBody }), async (req, res) => {
    const userId = getUserId(req);
    const project = req.project || await projectStore.getProject(req.params.id);
    if (!project) throw notFound();
    if (!project.archivedAt) return res.json({ success: true, archivedAt: null });
    await projectStore.setArchived(project.id, null);
    await recordProjectChange(project.id, userId, 'project_restored', {});
    signalProjectChanged(project, 'settings');
    res.json({ success: true, archivedAt: null });
});

// DELETE /:id — delete project (owner only; also while archived)
router.delete('/:id', requireRole('owner', { allowArchived: true }), async (req, res) => {
    const projectId = req.params.id;

    // A conversation shared into the project cannot outlive it: its rows are
    // encrypted under the project key and the schema forbids a shared
    // conversation without a project, so Postgres refuses the whole DELETE.
    // Unsharing re-encrypts under the chat owner's key, which only that
    // person's session holds, so it is asked of them (the refusal names the
    // chats and their owners) rather than attempted here. Checked
    // BEFORE anything is detached, so a refused delete leaves the project
    // exactly as it was.
    const shared = await projectStore.countSharedThreads(projectId);
    if (shared > 0) throw await sharedChatsRemain(projectId, shared);

    // Detach everything that points at this project by SOFT reference before
    // deleting it, after folding co-edited state back into its items; the
    // files base goes only once the delete went through. Deleting a project
    // must never destroy the work its members did inside it.
    let ok;
    try {
        ok = await projectTeardown.deleteProject(projectId);
    } catch (err) {
        // A chat shared between the count above and this statement.
        if (err?.code === '23514' && /shared_needs_project/.test(String(err.constraint || err.message))) {
            throw await sharedChatsRemain(projectId, await projectStore.countSharedThreads(projectId).catch(() => 1));
        }
        throw err;
    }
    // No need to log — the project_activity row cascades away.
    res.json({ success: ok });
});

// ── Members: shares, member list, invite picker, roles, transfer, avatars ──
//
// routes/projects/members.js. Built over this router's own stores, role gate,
// feed and bell, so the route tests' doubles see it.
router.use('/', require('./projects/members').makeMembersRouter({
    requireProjectRole: requireRole,
    projectStore,
    userStore,
    getUserId,
    resolveUserGroups,
    recordProjectChange,
    collabNotifier,
    perUserRateLimit,
}));

// ── Mute, activity feed, live stream, typing ─────────────
//
// routes/projects/activity.js. Same shape; what it loads on first use is
// required from here, so the route tests' doubles see that too.
router.use('/', require('./projects/activity').makeActivityRouter({
    requireProjectRole: requireRole,
    projectStore,
    notificationPrefsStore,
    getUserId,
    perUserRateLimit,
    projectFiles: () => require('../projects/projectFiles'),
    projectEventBus: () => require('../core/projectEventBus'),
}));

// ── Project resources, what comes along, graph, completeness ──
//
// routes/projects/resources.js. Built over this router's own registry, filing
// service and graph loader (buildGraphForProject below).
router.use('/', require('./projects/resources').makeResourcesRouter({
    requireProjectRole: requireRole,
    projectStore,
    membership,
    itemFiling,
    buildGraphForProject,
    completeness: () => require('../projects/completeness'),
    getUserId,
    getUserGroups,
}));


/**
 * The loader itself lives in projects/graphForProject.js (the publish gate in
 * ./projects/packaging.js asks the same question, and a router is not where
 * that belongs). This wrapper hands it the stores THIS module resolves, so the
 * graph, completeness and summary routes keep reading exactly the store
 * handles their route tests replace.
 */
function buildGraphForProject(projectId) {
    return buildGraphFor(projectId, {
        automationStore: require('../stores/automationStore'),
        studioAppStore: require('../stores/studioAppStore'),
        webpageStore: require('../stores/webpageStore'),
        datatableStore: require('../stores/datatableStore'),
        agentStore: require('../stores/agentStore'),
        kbMembership: require('../projects/knowledgeBaseMembership'),
        kbSources: require('../stores/kbSources'),
        buildProjectGraph,
    });
}

// ── Blueprint packaging ──────────────────────────────────
//
// Its own router because it carries a second licence gate that cannot go on the
// shared /api/projects mount. Mounted here rather than in index.js so the
// project routes stay one subtree — the routes/automation.js + routes/automation/
// pairing this repo already uses.
router.use('/', require('./projects/packaging'));

// ── Conversation assignment ──────────────────────────────

// PUT /:id/conversations — assign/unassign conversations (editor+)
router.put('/:id/conversations', requireRole('editor'), validate({ body: S.ConversationsBody }), async (req, res) => {
    const userId = getUserId(req);
    const { assign, unassign } = req.body;
    // assign: [{ id, type: 'direct'|'agent' }]
    // unassign: [{ id, type: 'direct'|'agent' }]

    // Each element costs an UPDATE plus an activity INSERT, so an unbounded
    // array is an unbounded round-trip loop on a route with no rate limit.
    if ((assign?.length || 0) + (unassign?.length || 0) > MAX_CONVERSATION_BATCH) {
        return res.status(400).json({ error: `At most ${MAX_CONVERSATION_BATCH} conversations per request` });
    }

    // A chat shared into a project is sealed under THAT project's key and its shared scope requires a project:
    // moving it would leave it unreadable in the new one, and detaching it would violate that constraint.
    // Checked for the whole batch before anything is applied, so a refusal leaves nothing half done.
    // Stopping the sharing (DELETE /conversations/:convId) is the way out.
    for (const conv of [...(assign || []).map(c => ({ ...c, into: true })), ...(unassign || [])]) {
        const table = conv.type === 'agent' ? 'agent_conversations' : 'direct_conversations';
        const filing = await projectStore.getOwnConversationFiling(conv.id, userId, table);
        if (filing?.shared && !(conv.into && filing.projectId === req.params.id)) {
            return res.status(409).json({
                error: 'A chat shared with a project cannot be moved or detached. Stop sharing it first.',
                code: 'CONVERSATION_SHARED', conversationId: conv.id,
            });
        }
    }

    // Filing chats INTO a Solution is refused. Taking them out is not:
    // a legacy project classified as a Solution may still hold some.
    if (Array.isArray(assign) && assign.length > 0) {
        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });
        if (project.kind === 'solution') return res.status(409).json(SOLUTION_HOLDS_NO_CHATS);
    }

    const results = { assigned: 0, unassigned: 0 };

    if (Array.isArray(assign)) {
        for (const conv of assign) {
            const table = conv.type === 'agent' ? 'agent_conversations' : 'direct_conversations';
            // Pass userId so the store WHERE clause rejects conversations
            // belonging to other users (IDOR guard).
            const ok = await projectStore.assignConversation(conv.id, req.params.id, userId, table);
            if (ok) {
                results.assigned++;
                await recordProjectChange(req.params.id, userId, 'conversation_assigned', {
                    targetType: 'conversation', targetId: conv.id, conversationType: conv.type,
                });
            }
        }
    }
    if (Array.isArray(unassign)) {
        for (const conv of unassign) {
            const table = conv.type === 'agent' ? 'agent_conversations' : 'direct_conversations';
            const ok = await projectStore.unassignConversation(conv.id, userId, table);
            if (ok) {
                results.unassigned++;
                await recordProjectChange(req.params.id, userId, 'conversation_unassigned', {
                    targetType: 'conversation', targetId: conv.id, conversationType: conv.type,
                });
            }
        }
    }

    res.json({ success: true, ...results });
});

// ── Collaborative project routers ────────────────────────
//
// Team chats (WS-B), files / my chats / presence, and new documents and
// notebooks made inside a project. Factory routers with their own role gate on
// every route and no path-less middleware, so mounting them here adds routes
// and nothing that runs for a request meant elsewhere. Every path is
// `/:id/<word>…`, so none of them can shadow the one-segment routes above.
router.use('/', require('./projects/chats'));
router.use('/', require('./projects/tasks'));
router.use('/', require('./projects/sprints'));
router.use('/', require('./projects/memberColors'));
router.use('/', require('./projects/workspace'));
router.use('/', require('./projects/discovery'));
router.use('/', require('./projects/board'));
router.use('/', require('./projects/content'));
// Real-time co-editing of notebooks and project pages (the HTTP half of the
// sync; the other half rides on GET /:id/stream above).
router.use('/', require('./projects/collab'));
// What changed since your last visit and the seen marks, comment threads on
// notebooks and documents, and the one gentle compliance hint. Same shape:
// factory routers, a role gate first on every route, `/:id/<word>…` paths.
router.use('/', require('./projects/changes'));
router.use('/', require('./projects/comments'));
router.use('/', require('./projects/complianceHints'));
// The Dev / UAT / PRD pipeline of a Solution (routes/projects/stages): stages,
// releases, bindings, variables, deployments. A factory router over this
// router's project store; every route carries its own licence gate and its own
// role resolution (projects/stages/stageAuth.js), and nothing is loaded before
// a request needs it. The drain-exempt half (on/off, pause, detach) is
// routes/solutionStages.js, mounted in index.js without the projects licence.
router.use('/', require('./projects/stages').makeStagesRouter({ projectStore }));

module.exports = router;
// The loader behind GET /:id/graph, GET /:id/completeness and GET /summary.
// The loader itself is projects/graphForProject.js; this wrapper stays
// exported so routes/studio/attention.js can ask the SAME question
// about a Solution that this file's own routes ask — including its `unavailable`
// list, which is what keeps "could not read half of it" from reading as "clean".
// It authorises nothing on its own: every caller resolves the project role, or
// the project list, before it hands an id over.
module.exports.buildGraphForProject = buildGraphForProject;
