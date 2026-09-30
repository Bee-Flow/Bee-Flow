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
 * Members (members are project_shares; "owner" is implicit via projects.owner_id):
 * GET    /:id/members               → list owner + members          (viewer+)
 * PUT    /:id/members/:memberId     → change a member's role        (owner)
 * DELETE /:id/members/:memberId     → remove a member or self-leave (owner OR self)
 *
 * Activity feed:
 * GET    /:id/activity?limit=&offset=  (viewer+)
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
const membership = require('../projects/membership');
const { buildProjectGraph } = require('../projects/graph');
const userStore = require('../stores/userStore');
const { resolveUserGroups } = require('../auth');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { validate } = require('../core/http/validate');
const { HttpError, notFound } = require('../core/http/errors');
const S = require('./projects/schemas');

// Single shared budget across all membership mutations (invite / role change /
// removal / unshare). Keeps a runaway client or accidental spam loop from
// flooding the activity log without rejecting reasonable interactive use.
const memberMutationLimiter = perUserRateLimit({ windowMs: 60_000, max: 30 });

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
 * The sections the resources listing shows for a project of this kind, or
 * null for "every section". The registry (projects/membership.js) decides
 * which kinds each container holds; an older registry without that answer
 * keeps the listing as it was.
 * @param {'workspace'|'solution'|null} containerKind
 * @returns {Set<string>|null}
 */
function sectionsAllowedIn(containerKind) {
    if (typeof membership.sectionsFor !== 'function') return null;
    const sections = membership.sectionsFor(containerKind);
    if (!Array.isArray(sections)) return null;
    return new Set(sections
        .map(entry => (typeof entry === 'string' ? entry : entry?.section))
        .filter(Boolean));
}

/**
 * May a resource of `kind` be filed into a project of `containerKind`?
 * Same registry, same fallback.
 */
function kindAllowedIn(kind, containerKind) {
    if (typeof membership.isAllowedIn !== 'function') return true;
    return membership.isAllowedIn(kind, containerKind) !== false;
}

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

/**
 * How a member's own avatar reaches the list: an emoji, a path or a url inline;
 * an uploaded picture (a data URL of up to hundreds of KB) NOT inline, since it
 * would ride along on every member list, but as a link to the avatar route
 * below, versioned by its content so a changed picture is fetched again.
 *
 * @returns {{ avatar: string, avatarType: 'emoji'|'image'|'url' }|null}
 */
function memberAvatar(projectId, userId, user) {
    const avatar = typeof user.avatar === 'string' ? user.avatar : '';
    if (!avatar || !['emoji', 'image', 'url'].includes(user.avatarType)) return null;
    if (avatar.startsWith('data:image/')) {
        const v = require('crypto').createHash('sha256').update(avatar).digest('hex').slice(0, 10);
        return { avatar: `/api/projects/${projectId}/avatars/${encodeURIComponent(userId)}?v=${v}`, avatarType: 'image' };
    }
    return avatar.length <= 2048 ? { avatar, avatarType: user.avatarType } : null;
}

/** The display name a member list shows for a user row (the same rule as the documents' people). */
const { displayNameOf } = require('../core/documents/documentPeople');

/**
 * Names for the owner and the member rows of one project.
 *
 * Only principals of the PROJECT'S organisation are described (org-less
 * projects: org-less principals only), from an explicit allow-list of fields:
 * a user is `{ name, avatar?, avatarType? }`, a group `{ name }`. Never an e-mail address: any
 * viewer may read this list, and the organisation's directory
 * (users.getOrgMembersForDirectory) gives a non-admin no addresses either; a
 * picker or a member list needs a label, not an address. A share row pointing across
 * a tenant boundary, which the share route refuses to create but older rows
 * may carry, stays an id without a name. A lookup that fails leaves that
 * principal unnamed rather than failing the member list.
 *
 * @returns {Promise<{ people: Record<string, {name?: string}>, groups: Record<string, {name?: string}> }>}
 */
async function describeMembers(project, shares) {
    const org = project.organizationId || '';
    const userIds = new Set([project.ownerId]);
    const groupIds = new Set();
    for (const share of shares) {
        if (share.sharedWithType === 'user') userIds.add(share.sharedWithId);
        else if (share.sharedWithType === 'group') groupIds.add(share.sharedWithId);
    }

    const people = {};
    await Promise.all([...userIds].filter(Boolean).map(async (id) => {
        let user = null;
        try { user = await userStore.getUser(id); } catch (err) {
            log.warn('[Projects] member lookup failed:', err.message);
        }
        if (!user || (user.organizationId || '') !== org) return;
        const name = displayNameOf(user);
        const entry = name ? { name } : {};
        const picture = memberAvatar(project.id, id, user);
        if (picture) Object.assign(entry, picture);
        people[id] = entry;
    }));

    // One targeted read per group the project is shared with, never the whole
    // groups table of the install: this list is read on every project page.
    const groups = {};
    await Promise.all([...groupIds].filter(Boolean).map(async (id) => {
        let group = null;
        try { group = await userStore.getGroup(id); } catch (err) {
            log.warn('[Projects] group lookup failed:', err.message);
        }
        if (!group || group.id !== id || (group.organizationId || '') !== org) return;
        groups[id] = typeof group.name === 'string' && group.name ? { name: group.name } : {};
    }));
    return { people, groups };
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
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const kind = req.query.kind || undefined;
        const projects = await projectStore.listUserProjects(userId, await getUserGroups(req), { kind });
        res.json(projects);
    } catch (err) {
        log.error('[Projects] List error:', err.message);
        // Raw err.message can carry SQL text, column names and constraint names.
        // The console.error above keeps the detail for operators.
        res.status(500).json({ error: 'Request failed' });
    }
});

// POST / — create project
router.post('/', validate({ body: S.CreateBody }), async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const { name, description, customInstructions, color, icon, knowledgeBaseIds, extractMemories } = req.body;
        // A collaborative project unless the caller asks for a Solution (the
        // Studio form does). Never NULL: only rows from before the split are.
        const kind = req.body.kind || 'workspace';
        if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

        const lenError = validateLengths({ name, description, customInstructions });
        if (lenError) return res.status(400).json({ error: lenError });

        const organizationId = req.session?.user?.organizationId || '';

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
    } catch (err) {
        log.error('[Projects] Create error:', err.message);
        // Raw err.message can carry SQL text, column names and constraint names.
        // The console.error above keeps the detail for operators.
        res.status(500).json({ error: 'Request failed' });
    }
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

        // Solutions only, plus the legacy rows nobody has classified yet: a
        // collaborative project is not a Solution and gets no card here.
        const all = await projectStore.listUserProjects(userId, await getUserGroups(req), { kind: 'solution' });

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

        const { summarizeProjects } = require('../projects/summary');
        const result = await summarizeProjects(projects, {
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

        res.json({ ...result, hasMore: picked.length > projects.length });
    } catch (err) {
        log.error('[Projects] Summary error:', err.message);
        res.status(500).json({
            error: 'Request failed',
            projects: [], unavailable: ['all'], hasMore: false,
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
    try {
        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });
        const shares = await projectStore.getProjectShares(project.id);
        res.json({ ...project, shares, role: req.projectRole });
    } catch (err) {
        log.error('[Projects] Get error:', err.message);
        // Raw err.message can carry SQL text, column names and constraint names.
        // The console.error above keeps the detail for operators.
        res.status(500).json({ error: 'Request failed' });
    }
});

// PUT /:id — update project (editor+)
router.put('/:id', requireRole('editor'), validate({ body: S.UpdateBody }), async (req, res) => {
    try {
        const userId = getUserId(req);
        const before = await projectStore.getProject(req.params.id);
        if (!before) return res.status(404).json({ error: 'Not found' });

        const { name, description, customInstructions, color, icon, extractMemories } = req.body;
        let { knowledgeBaseIds } = req.body;

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
            name, description, customInstructions, color, icon, knowledgeBaseIds, extractMemories,
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
        for (const key of ['name', 'description', 'color', 'icon', 'extractMemories']) {
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
    } catch (err) {
        log.error('[Projects] Update error:', err.message);
        // Raw err.message can carry SQL text, column names and constraint names.
        // The console.error above keeps the detail for operators.
        res.status(500).json({ error: 'Request failed' });
    }
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

// DELETE /:id — delete project (owner only)
router.delete('/:id', requireRole('owner'), async (req, res) => {
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

// ── Shares (legacy) — kept for back-compat, aliased to /members semantics ──

// POST /:id/share — share with user or group (owner only)
router.post('/:id/share', memberMutationLimiter, requireRole('owner'), validate({ body: S.ShareBody }), async (req, res) => {
    try {
        const userId = getUserId(req);
        const { sharedWithType, sharedWithId, permission } = req.body;
        if (!sharedWithType || !sharedWithId) return res.status(400).json({ error: 'sharedWithType and sharedWithId required' });
        if (!['user', 'group'].includes(sharedWithType)) return res.status(400).json({ error: 'sharedWithType must be user or group' });

        const role = projectStore.normalizePermission(permission || 'viewer');
        if (!['viewer', 'editor'].includes(role)) return res.status(400).json({ error: 'permission must be viewer or editor' });

        // Cross-tenant guard: an owner could otherwise share their project
        // with a foreign-org group/user ID and leak project content + KB IDs
        // to members of another tenant. Match the target's org against the
        // project's org before persisting.
        // The guards used to be conditional on both org ids being truthy, which
        // meant they never ran for an org-less project — and projects.organization_id
        // DEFAULTS TO '' (self-host, consumer and admin-created projects all land
        // there). An owner could then share with any user or group id in any tenant.
        // Compare normalised values instead: '' is a real bucket, and only an
        // equally org-less counterpart matches it.
        const project = await projectStore.getProject(req.params.id);
        const projectOrg = project?.organizationId || '';
        if (sharedWithType === 'group') {
            const targetGroup = await userStore.getGroup(sharedWithId);
            if (!targetGroup || targetGroup.id !== sharedWithId) return res.status(400).json({ error: 'Unknown group' });
            if ((targetGroup.organizationId || '') !== projectOrg) {
                return res.status(400).json({ error: 'Group does not belong to this project\'s organisation' });
            }
        } else if (sharedWithType === 'user') {
            const targetUser = await userStore.getUser(sharedWithId);
            if (!targetUser) return res.status(400).json({ error: 'Unknown user' });
            if ((targetUser.organizationId || '') !== projectOrg) {
                return res.status(400).json({ error: 'User does not belong to this project\'s organisation' });
            }
        }

        const shareId = await projectStore.shareProject(req.params.id, sharedWithType, sharedWithId, role, userId);
        await recordProjectChange(req.params.id, userId, 'member_added', {
            targetType: sharedWithType, targetId: sharedWithId, role,
        });
        signalProjectChanged(project, 'members');
        const shares = await projectStore.getProjectShares(req.params.id);
        res.json({ shareId, shares });
    } catch (err) {
        log.error('[Projects] Share error:', err.message);
        // Raw err.message can carry SQL text, column names and constraint names.
        // The console.error above keeps the detail for operators.
        res.status(500).json({ error: 'Request failed' });
    }
});

// DELETE /:id/share/:shareId — remove share (owner only)
router.delete('/:id/share/:shareId', memberMutationLimiter, requireRole('owner'), async (req, res) => {
    try {
        const userId = getUserId(req);
        const share = await projectStore.getShareById(req.params.shareId);
        // Guard against IDOR: confirm the share actually belongs to this project,
        // otherwise an owner of project A could delete shares from project B.
        if (!share || share.projectId !== req.params.id) {
            return res.status(404).json({ error: 'Member not found' });
        }
        const ok = await projectStore.unshareProject(req.params.shareId);
        await recordProjectChange(req.params.id, userId, 'member_removed', {
            targetType: share.sharedWithType, targetId: share.sharedWithId,
        });
        if (ok) signalProjectChanged(await projectStore.getProject(req.params.id), 'members');
        const shares = await projectStore.getProjectShares(req.params.id);
        res.json({ success: ok, shares });
    } catch (err) {
        log.error('[Projects] Unshare error:', err.message);
        // Raw err.message can carry SQL text, column names and constraint names.
        // The console.error above keeps the detail for operators.
        res.status(500).json({ error: 'Request failed' });
    }
});

// ── Members API ──────────────────────────────────────────

// GET /:id/members — owner + members list (viewer+), with names for the
// people and groups of the project's own organisation (see describeMembers).
router.get('/:id/members', requireRole('viewer'), async (req, res) => {
    const project = await projectStore.getProject(req.params.id);
    if (!project) throw notFound();
    const shares = await projectStore.getProjectShares(req.params.id);
    const { people, groups } = await describeMembers(project, shares);
    // The colour the project gave each person (none: the client picks the automatic one).
    try {
        const colors = await require('../stores/projectMemberColorStore').listColors(project.id);
        for (const [id, person] of Object.entries(people)) if (colors[id]) person.color = colors[id];
    } catch (err) {
        log.warn('[Projects] member colours unavailable:', err.message);
    }
    res.json({ ownerId: project.ownerId, members: shares, people, groups });
});

// PUT /:id/members/:memberId — change role (owner only)
router.put('/:id/members/:memberId', memberMutationLimiter, requireRole('owner'), validate({ body: S.MemberRoleBody }), async (req, res) => {
    try {
        const userId = getUserId(req);
        const { role } = req.body;
        const normalized = projectStore.normalizePermission(role);
        if (!['viewer', 'editor'].includes(normalized)) return res.status(400).json({ error: 'role must be viewer or editor' });

        const before = await projectStore.getShareById(req.params.memberId);
        if (!before || before.projectId !== req.params.id) return res.status(404).json({ error: 'Member not found' });

        const ok = await projectStore.updateMemberRole(req.params.memberId, normalized);
        if (!ok) return res.status(404).json({ error: 'Member not found' });

        await recordProjectChange(req.params.id, userId, 'member_role_changed', {
            targetType: before.sharedWithType, targetId: before.sharedWithId,
            from: before.permission, to: normalized,
        });
        signalProjectChanged(await projectStore.getProject(req.params.id), 'members');
        res.json({ success: true });
    } catch (err) {
        log.error('[Projects] Update member error:', err.message);
        // Raw err.message can carry SQL text, column names and constraint names.
        // The console.error above keeps the detail for operators.
        res.status(500).json({ error: 'Request failed' });
    }
});

// DELETE /:id/members/:memberId — owner removes OR member self-leaves
router.delete('/:id/members/:memberId', memberMutationLimiter, async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });
        const share = await projectStore.getShareById(req.params.memberId);
        if (!share || share.projectId !== req.params.id) return res.status(404).json({ error: 'Member not found' });

        const isOwner = project.ownerId === userId;
        const isSelf = share.sharedWithType === 'user' && share.sharedWithId === userId;
        if (!isOwner && !isSelf) return res.status(403).json({ error: 'Forbidden' });

        const ok = await projectStore.unshareProject(req.params.memberId);
        await recordProjectChange(req.params.id, userId, 'member_removed', {
            targetType: share.sharedWithType, targetId: share.sharedWithId,
            selfLeave: isSelf && !isOwner,
        });
        if (ok) signalProjectChanged(project, 'members');
        if (ok && share.sharedWithType === 'user') {
            // Someone who left holds no tasks here any more; best-effort, the removal stands.
            try { await require('../stores/projectMemberColorStore').clearFor(req.params.id, share.sharedWithId); } catch (err) {
                log.warn('[Projects] could not clear a removed member\'s colour:', err.message);
            }
            try { await require('../stores/projectTaskStore').unassignUser(req.params.id, share.sharedWithId); } catch (err) {
                log.warn('[Projects] could not unassign a removed member from tasks:', err.message);
            }
        }
        res.json({ success: ok });
    } catch (err) {
        log.error('[Projects] Remove member error:', err.message);
        // Raw err.message can carry SQL text, column names and constraint names.
        // The console.error above keeps the detail for operators.
        res.status(500).json({ error: 'Request failed' });
    }
});

// GET /:id/avatars/:userId — the picture an owner or member uploaded, as an image (viewer+). Only for a person
// of this project, only the raster types, and served as the bytes it holds: nothing else is ever read from it.
const AVATAR_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/;
router.get('/:id/avatars/:userId', requireRole('viewer'), async (req, res) => {
    const project = await projectStore.getProject(req.params.id);
    if (!project) throw notFound();
    const shares = await projectStore.getProjectShares(project.id);
    const isMember = project.ownerId === req.params.userId
        || shares.some((s) => s.sharedWithType === 'user' && s.sharedWithId === req.params.userId);
    const user = isMember ? await userStore.getUser(req.params.userId) : null;
    const match = user && (user.organizationId || '') === (project.organizationId || '') && typeof user.avatar === 'string'
        ? AVATAR_DATA_URL.exec(user.avatar) : null;
    if (!match) throw notFound();
    res.set({
        'Content-Type': match[1],
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.send(Buffer.from(match[2].replace(/\s+/g, ''), 'base64'));
});

// ── Activity feed ────────────────────────────────────────

router.get('/:id/activity', requireRole('viewer'), validate({ query: S.PageQuery }), async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const offset = parseInt(req.query.offset, 10) || 0;
        // Fetch one extra row to cheaply detect "more available" without a
        // second COUNT(*) query against the activity table.
        const items = await projectStore.listActivity(req.params.id, limit + 1, offset);
        const hasMore = items.length > limit;
        const page = hasMore ? items.slice(0, limit) : items;
        // File rows carry an id, never the name; it is read now, while the
        // file is still in the project (projects/projectFiles.js). Without the
        // project there is nothing to name from, and any stored name is dropped.
        const project = await projectStore.getProject(req.params.id);
        const named = await require('../projects/projectFiles').nameFileActivity(project || { id: req.params.id }, page);
        res.json({ items: named, hasMore });
    } catch (err) {
        log.error('[Projects] Activity error:', err.message);
        // Raw err.message can carry SQL text, column names and constraint names.
        // The console.error above keeps the detail for operators.
        res.status(500).json({ error: 'Request failed' });
    }
});

// ── Live stream ──────────────────────────────────────────

/**
 * GET /:id/stream — the project's live feed (cursor-based: every durable
 * frame carries `id: <seq>`, and a reconnect replays from Last-Event-ID or
 * ?since=), and with `?doc=&docSince=` one co-edited document on the same
 * connection. The handler and its delivery model live in
 * routes/projects/collabStream.js; the skeleton in core/http/cursorStream.js.
 */
const CollabS = require('./projects/collabSchemas');
const { makeProjectStreamHandler } = require('./projects/collabStream');

router.get('/:id/stream', requireRole('viewer'), validate({ query: CollabS.StreamQuery }), makeProjectStreamHandler());

// POST /:id/typing — transient presence. No row, no seq, no replay.
// A composer sends at most one every few seconds; the limiter stops a loop
// from turning presence into a flood on every open stream of the project.
const typingLimiter = perUserRateLimit({
    windowMs: 10_000, max: 20, name: 'project-typing',
    keyFn: (req) => `${req.session?.user?.id || req.ip}:${req.params?.id || ''}`,
});
router.post('/:id/typing', requireRole('viewer'), typingLimiter, validate({ body: S.TypingBody }), async (req, res) => {
    try {
        const bus = require('../core/projectEventBus');
        await bus.publishTransient(req.params.id, {
            kind: 'presence.typing',
            actorId: getUserId(req),
            conversationId: req.body?.conversationId || null,
        });
        res.json({ ok: true });
    } catch (err) {
        // Presence is decoration. Never fail a request over it.
        res.json({ ok: false });
    }
});

// ── Project resources: notebooks, apps, routines, webpages, approvals ──
//
// One project, one place to see everything in it. Each resource keeps working
// standalone (project_id NULL); membership is additive, never a move that takes
// something away from its owner.
//
// The set of kinds lives in projects/membership.js, not here: the listing, the
// file-in/out switch below and the delete-time detacher all read from it, and
// the last time those three were maintained by hand they drifted far enough
// apart that a shipped column was never created at all.

// GET /:id/resources — everything filed into this project (viewer+)
router.get('/:id/resources', requireRole('viewer'), async (req, res) => {
    const projectId = req.params.id;
    const project = await projectStore.getProject(projectId);
    if (!project) throw notFound();
    // Only the sections this kind of project holds: a Solution has no
    // meetings, a collaborative project no automations. A legacy project
    // (kind null) shows every section.
    const allowed = sectionsAllowedIn(project.kind);
    // Independently, so one unavailable store degrades that section rather than
    // blanking the whole project page.
    const load = async (label, fn) => {
        try { return await fn(); } catch (err) {
            log.warn(`[Projects] could not list ${label}:`, err.message);
            return null;   // null = "unavailable", distinct from [] = "none"
        }
    };

    // Approvals are listed against the caller, not the project — the registry
    // header explains why they alone stay viewer-scoped.
    const viewer = { userId: getUserId(req), groupIds: await getUserGroups(req) };

    const kinds = membership.listKinds().filter(k => !allowed || allowed.has(k.section));
    const sections = await Promise.all(
        kinds.map(k => load(k.section, () => k.list(projectId, viewer))),
    );

    const body = { role: req.projectRole, kind: project.kind };
    kinds.forEach((k, i) => { body[k.section] = sections[i]; });
    res.json(body);
});

/**
 * PUT /:id/resources — file a resource into this project, or take it out.
 *
 * Body: { kind, id, attach: boolean } — kind being any registered MOVABLE kind
 * (see projects/membership.js). Approvals are not movable: they are stamped
 * with their project when they are created and never re-filed.
 *
 * Requires editor on the project AND ownership of the resource. Ownership is
 * enforced by the stores (each setter matches on user_id), so a member cannot
 * pull a colleague's notebook into a project, and cannot push one out either.
 */
router.put('/:id/resources', requireRole('editor'), validate({ body: S.ResourceBody }), async (req, res) => {
    try {
        const userId = getUserId(req);
        const { kind, id, attach = true } = req.body || {};
        if (!kind || !id) return res.status(400).json({ error: 'kind and id are required' });

        const entry = membership.getKind(kind);
        // A kind with no setProject is not movable by design (approvals are
        // stamped at INSERT and never re-filed), so it is rejected here rather
        // than reaching a stub that throws.
        if (!entry || typeof entry.setProject !== 'function') {
            const movable = membership.movableKinds().map(k => k.kind).join(', ');
            return res.status(400).json({ error: `kind must be one of: ${movable}` });
        }

        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });
        // Filing IN must fit the container (no automations in a collaborative
        // project, no documents in a Solution). Taking something OUT is always
        // allowed: that is how a project classified after the fact is tidied.
        if (attach && !kindAllowedIn(kind, project.kind)) {
            // `kind` is a registered kind by now (checked above), never free text.
            const label = kind.replace(/_/g, ' ');
            return res.status(400).json({
                error: project.kind === 'solution'
                    ? `A Studio Solution does not hold items of kind "${label}"; they belong in a project.`
                    : `A project does not hold items of kind "${label}"; they belong in a Studio Solution.`,
                code: 'KIND_NOT_ALLOWED',
            });
        }

        // The move itself, the feed entry of every project it touched, and
        // the co-editing state, comment threads and compliance signal that
        // belong to the project an item leaves (projects/itemFiling.js).
        const ok = await itemFiling.fileItem({ entry, kind, id, userId, projectId: req.params.id, attach, req });
        if (!ok) return res.status(404).json({ error: 'Not found, or not yours to move' });
        res.json({ success: true });
    } catch (err) {
        // A refusal a kind states DELIBERATELY (a lost race on the project row,
        // a cap it would exceed) carries its own status and a message written
        // to be read. Anything else is a 500 with the detail kept in the log:
        // a raw err.message can carry SQL text, column names and constraint
        // names, which is why only errors that opted in are surfaced.
        const status = Number(err?.status);
        if (Number.isInteger(status) && status >= 400 && status < 500) {
            return res.status(status).json({ error: err.message, code: err.code || undefined });
        }
        log.error('[Projects] Resource update error:', err.message);
        res.status(500).json({ error: 'Request failed' });
    }
});

/**
 * GET /:id/graph — how the pieces of this Solution are wired to each other.
 *
 * Viewer+, because it says nothing the Content tab does not already list — it
 * only draws the lines between those entries. The reading is done by
 * buildGraphForProject() just below, which GET /:id/completeness shares.
 *
 * Three loading decisions worth stating:
 *
 *  1. EVERY automation KIND, not just top-level ones. A `call_block` pointing
 *     at a reusable Step that IS in this project would otherwise be reported as
 *     an external dependency, purely because the listing query filters it out.
 *  2. FULL app definitions, one query each. listProjectApps returns meta only,
 *     and the wiring lives in the definition. N is a project's worth of apps.
 *  3. TWO PASSES, so "outside this project" can be told apart from "gone".
 *     The first pass names the references it could not place; only those ids
 *     are looked up, and the second pass says which exist. Reporting a routine
 *     as deleted when the truth is "I did not check" is the worse error, and
 *     the graph refuses to do it — see PROBLEM.UNRESOLVED.
 *  4. THE SECOND PASS IS FOR ROUTINES ONLY, and deliberately so. A datatable
 *     is scope-addressed: answering "does this id exist anywhere" would mean
 *     naming a tenant to look in, and guessing one is worse than not knowing.
 *     A knowledge base could be looked up, and is not: the only thing the
 *     answer changes is whether the sentence says "gone" or "not in this
 *     project", and buying that wording with an existence oracle over another
 *     tenant's ids is a bad trade. A skill is never a project member at all.
 *     All three stay UNRESOLVED, which is the honest word for them and still
 *     counts as a dependency.
 *  5. AGENT CONFIGS ARE LOADED IN FULL, and never leave the server. The wiring
 *     (`knowledge_base_ids`, `attachedSkillIds`) lives in the config, which the
 *     Content-tab listing deliberately does not carry. Only the EDGES reach the
 *     client — ids the caller can already see in this project, never the
 *     agent's instructions or its tool grants.
 */
/**
 * Read everything a Solution's graph is drawn from, and SAY what could not be
 * read.
 *
 * The old shape of this loader returned `[]` for a store it could not reach,
 * which is indistinguishable from "this Solution has no agents". The Content
 * listing one route up already had the honest convention — `null` =
 * unavailable, `[]` = none (see GET /:id/resources) — and this is the same rule
 * applied here: a kind that could not be read is NAMED in `unavailable`, the
 * graph is drawn from what IS there, and `complete` says whether the picture is
 * whole. It matters beyond the Flow tab: the "Te controleren" aggregator reads
 * this, and a publish button that unlocks because half the Solution silently
 * failed to load is the failure this convention exists to prevent.
 *
 * Three reads can fail INSIDE a kind, and each is counted rather than dropped:
 *   - an app's full definition (the listing gives meta only) — a missing one
 *     used to delete the app from the graph entirely: node, edges AND problems;
 *   - an agent's config, which is where its wiring lives, same story;
 *   - a knowledge base's sources, which is where "every meeting tagged X" is.
 *
 * The existence pass is ALL-OR-NOTHING for the same reason graph.js refuses to
 * guess: with `knownAutomationIds` supplied, an id that is not in the set is
 * reported as MISSING — "the routine no longer exists", an error. One failed
 * lookup would produce that sentence about a routine nobody checked. So a pass
 * that cannot complete is abandoned, every unplaced routine stays UNRESOLVED
 * ("not in this project"), and the gap is named instead.
 *
 * @returns {Promise<{nodes,edges,externals,problems,projectId,unavailable:string[],complete:boolean}>}
 */
async function buildGraphForProject(projectId) {
    const automationStore = require('../stores/automationStore');
    const studioAppStore = require('../stores/studioAppStore');
    const webpageStore = require('../stores/webpageStore');
    const datatableStore = require('../stores/datatableStore');
    const agentStore = require('../stores/agentStore');
    const kbMembership = require('../projects/knowledgeBaseMembership');

    // Machine-readable section keys, so the client can name them in the
    // reader's own language instead of rendering a server-side English label.
    const unavailable = [];
    const miss = (section) => { if (!unavailable.includes(section)) unavailable.push(section); };

    // Each member kind loads INDEPENDENTLY and an unreachable store costs its
    // own lines, not the whole picture — the same rule the Content tab follows.
    // A graph drawn from four of six kinds is still true about those four;
    // refusing to draw anything would say nothing at all. What it must NOT do
    // is let those two kinds read as empty.
    const some = async (section, fn) => {
        try { return await fn(); } catch (err) {
            log.warn(`[Projects] graph: could not load ${section}:`, err.message);
            miss(section);
            return null;
        }
    };

    const [automations, appMetas, webpages, datatables, agentMetas, knowledgeBases] = await Promise.all([
        some('automations', () => automationStore.getAutomationsForProject(projectId, { kinds: ['automation', 'block', 'layer'] })),
        some('apps', () => studioAppStore.listProjectApps(projectId)),
        some('webpages', () => webpageStore.listProjectWebpages(projectId)),
        some('datatables', () => datatableStore.listDatatablesForProject(projectId)),
        some('agents', () => agentStore.listProjectAgents(projectId)),
        some('knowledgeBases', () => kbMembership.listProjectKnowledgeBases(projectId)),
    ]);

    const appReads = await Promise.all(
        (appMetas || []).map(m => studioAppStore.getStudioApp(m.id).catch(() => null)),
    );
    // An app whose definition would not load is NOT an app without wiring: it
    // is an app nobody could look at. Dropping it silently removed its broken
    // edges along with it.
    if (appReads.some(a => !a)) miss('apps');
    const apps = appReads.filter(Boolean);

    // See note 5 above: the config is what carries the wiring, and it stays
    // on this side of the wire.
    const agentReads = await Promise.all(
        (agentMetas || []).map(m => agentStore.getAgent(m.id).catch(() => null)),
    );
    if (agentReads.some(a => !a)) miss('agents');
    const agents = agentReads.filter(Boolean).map(a => ({ id: a.id, name: a.name, ownerId: a.owner_id, config: a.config }));

    // "Every meeting tagged X" is a knowledge SOURCE, so it is read here
    // and passed in — projects/graph.js does no I/O of its own.
    const kbSources = require('../stores/kbSources');
    const meetingSources = [];
    for (const kb of (knowledgeBases || [])) {
        let sources;
        try { sources = await kbSources.listByKb(kb.id); } catch (err) {
            log.warn('[Projects] graph: could not load knowledge sources:', err.message);
            miss('knowledgeSources');
            continue;
        }
        for (const src of (sources || [])) {
            if (src?.kind !== 'meeting_tag') continue;
            const tag = src.config?.tag;
            if (typeof tag === 'string' && tag.trim()) {
                meetingSources.push({ knowledgeBaseId: kb.id, tag: tag.trim() });
            }
        }
    }

    const input = {
        project: { id: projectId },
        automations: automations || [], apps, webpages: webpages || [],
        datatables: datatables || [], agents, knowledgeBases: knowledgeBases || [], meetingSources,
    };
    let graph = buildProjectGraph(input);

    const unplacedRoutines = graph.externals.filter(e => e.kind === 'automation');
    if (unplacedRoutines.length) {
        const known = new Set();
        let checkedAll = true;
        for (const ext of unplacedRoutines) {
            try {
                if (await automationStore.getAutomation(ext.id)) known.add(ext.id);
            } catch (err) {
                log.warn('[Projects] graph: could not check routine existence:', err.message);
                checkedAll = false;
                break;
            }
        }
        // Only a COMPLETE pass may promote UNRESOLVED to MISSING — see the
        // header. A partial one is thrown away rather than used to tell someone
        // their routine was deleted.
        if (checkedAll) graph = buildProjectGraph({ ...input, knownAutomationIds: known });
        else miss('routineExistence');
    }

    // The members travel back with the graph so GET /:id/completeness can run
    // the validators over the SAME rows this walk was drawn from — a second
    // read would let the two screens disagree about what is in the Solution.
    return {
        graph: { ...graph, unavailable, complete: unavailable.length === 0 },
        members: { apps, automations: automations || [], knowledgeBases: knowledgeBases || [] },
        unavailable,
    };
}

router.get('/:id/graph', requireRole('viewer'), async (req, res) => {
    try {
        const { graph } = await buildGraphForProject(req.params.id);
        res.json({ ...graph, role: req.projectRole });
    } catch (err) {
        log.error('[Projects] Graph build error:', err.message);
        res.status(500).json({ error: 'Request failed' });
    }
});

/**
 * GET /:id/completeness — "Te controleren": everything in this Solution that
 * needs a person, and the one verdict the publish button reads.
 *
 * Viewer+, like the graph it is built on: it names the same objects the Content
 * listing already shows and adds the validators' own sentences about them.
 *
 * THE FAILURE PATH IS THE CONTRACT. A 500 here must be read by the client as
 * "blocked", never as "no findings" — an empty list is what a clean Solution
 * and an unreachable database look like from the outside, and only one of them
 * may publish. The 200 path says so explicitly (`blocked`, `complete`,
 * `unavailable`); the 500 path carries `blocked: true` for the same reason, so
 * a client that renders the body without checking the status still fails shut.
 */
router.get('/:id/completeness', requireRole('viewer'), async (req, res) => {
    try {
        const { graph, members, unavailable } = await buildGraphForProject(req.params.id);
        const { collectCompleteness } = require('../projects/completeness');
        const result = await collectCompleteness({ graph, ...members, unavailable });
        res.json({ ...result, role: req.projectRole });
    } catch (err) {
        log.error('[Projects] Completeness error:', err.message);
        res.status(500).json({
            error: 'Request failed',
            blocked: true, complete: false, findings: [], unavailable: ['all'],
        });
    }
});

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
    try {
        const userId = getUserId(req);
        const { assign, unassign } = req.body;
        // assign: [{ id, type: 'direct'|'agent' }]
        // unassign: [{ id, type: 'direct'|'agent' }]

        // Each element costs an UPDATE plus an activity INSERT, so an unbounded
        // array is an unbounded round-trip loop on a route with no rate limit.
        if ((assign?.length || 0) + (unassign?.length || 0) > MAX_CONVERSATION_BATCH) {
            return res.status(400).json({ error: `At most ${MAX_CONVERSATION_BATCH} conversations per request` });
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
    } catch (err) {
        log.error('[Projects] Assign conversations error:', err.message);
        // Raw err.message can carry SQL text, column names and constraint names.
        // The console.error above keeps the detail for operators.
        res.status(500).json({ error: 'Request failed' });
    }
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
router.use('/', require('./projects/memberColors'));
router.use('/', require('./projects/workspace'));
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

module.exports = router;
// The loader behind GET /:id/graph, GET /:id/completeness and GET /summary.
// Exported (not moved) so routes/studio/attention.js can ask the SAME question
// about a Solution that this file's own routes ask — including its `unavailable`
// list, which is what keeps "could not read half of it" from reading as "clean".
// It authorises nothing on its own: every caller resolves the project role, or
// the project list, before it hands an id over.
module.exports.buildGraphForProject = buildGraphForProject;
