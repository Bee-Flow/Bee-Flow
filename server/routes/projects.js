/**
 * Project Routes — REST API for organizing chats into projects.
 *
 * GET    /                          → list user's projects
 * POST   /                          → create project
 * GET    /:id                       → get project details + shares  (viewer+)
 * PUT    /:id                       → update project                (editor+)
 * DELETE /:id                       → delete project                (owner)
 * POST   /:id/share                 → share with user/group         (owner)
 * DELETE /:id/share/:shareId        → unshare                       (owner)
 * PUT    /:id/conversations         → assign/unassign conversations (editor+)
 * DELETE /conversations/:convId     → detach MY OWN conversation    (any authed user)
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
    MAX_KB_IDS, validateKnowledgeBaseIds,
} = require('../projects/knowledgeBaseMembership');

// Persist-then-publish lives in core/projectFeed.js — the ordering rule it
// documents is the basis of the whole delivery model, and it had been
// hand-copied into three producers before this.
const { emitProjectEvent } = require('../core/projectFeed');

/**
 * Write the audit trail AND the live feed.
 *
 * project_activity stays the durable, human-readable history; project_events is
 * the ordered channel clients tail. Routing every audit entry through here is
 * what makes the Activity tab live instead of polled — the UI stops asking every
 * 15 seconds and starts being told.
 *
 * `kind` defaults to the activity action, so a member change arrives as
 * `member_added` and a client can react to it specifically rather than
 * re-fetching on any change at all.
 */
async function logAndEmit(projectId, actorId, action, details = {}) {
    await projectStore.logActivity(projectId, actorId, action, details);
    await emitProjectEvent(projectId, {
        kind: action,
        actorId,
        targetType: details.targetType || null,
        targetId: details.targetId || null,
        payload: details,
    });
}

/**
 * Release every soft reference to a project that is about to be deleted.
 *
 * Each store is tried independently and failures are logged rather than
 * propagated: a notebook store that is unavailable must not block the delete
 * and leave the project half-removed. The worst case of a miss is an orphaned
 * project_id, which the stores' own boot-time cleanup also sweeps.
 */
async function detachProjectResources(projectId) {
    for (const { section, clearProject } of membership.detachableKinds()) {
        try { await clearProject(projectId); } catch (err) {
            log.warn(`[Projects] could not detach ${section} from ${projectId}:`, err.message);
        }
    }
}

function getUserId(req) { return req.session?.user?.id; }
// Read groups from the DB on every request, not from req.session — group
// removals must take effect without forcing a re-login. Mirrors the pattern
// used by the agents and KB routes.
function getUserGroups(req) {
    return resolveUserGroups(getUserId(req));
}

// ── Role middleware ──────────────────────────────────────
// Lives in auth/projectAccess.js so the chat, memory, notebook and automation
// paths enforce the same ladder from the same code. Behaviour is unchanged:
// 404 when the caller has no role at all (project existence must not be
// probeable), 403 when the role is too low.
const { requireProjectRole: requireRole } = require('../auth/projectAccess');

// ── List / create ────────────────────────────────────────

// GET / — list user's projects (owned + shared)
router.get('/', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const projects = await projectStore.listUserProjects(userId, await getUserGroups(req));
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
        });
        await logAndEmit(project.id, userId, 'project_created', { name: project.name });
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
 * GET /summary — one card per Solution for the Solutions overview.
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

        const all = await projectStore.listUserProjects(userId, await getUserGroups(req));

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

// ── Self-service detach ──────────────────────────────────
//
// DELETE /conversations/:convId — take MY conversation out of whatever project
// it is filed under. No project role required, because the alternative is a
// one-way door: filing goes through the chat request body, but unfiling went
// through PUT /:id/conversations, which needs editor. A user downgraded to
// viewer, removed from the project, or who filed a chat into a project they
// were only ever a viewer on, could never clean it up again.
//
// Safe by construction: unassignConversation matches on user_id, so this can
// only ever touch a conversation the caller owns.
//
// Registered before /:id so the three-segment path is unambiguous.
router.delete('/conversations/:convId', validate({ query: S.TypeQuery }), async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const type = req.query.type === 'agent' ? 'agent_conversations' : 'direct_conversations';
        const ok = await projectStore.unassignConversation(req.params.convId, userId, type);
        if (!ok) return res.status(404).json({ error: 'Conversation not found' });
        res.json({ success: true });
    } catch (err) {
        log.error('[Projects] Self-detach error:', err.message);
        res.status(500).json({ error: 'Could not detach conversation' });
    }
});

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

        const { name, description, customInstructions, color, icon, knowledgeBaseIds, extractMemories } = req.body;

        const lenError = validateLengths({ name, description, customInstructions });
        if (lenError) return res.status(400).json({ error: lenError });

        if (knowledgeBaseIds !== undefined) {
            const kbCheck = await validateKnowledgeBaseIds(req, knowledgeBaseIds, before.organizationId);
            if (kbCheck.tooMany) {
                return res.status(400).json({ error: `At most ${MAX_KB_IDS} knowledge bases per project` });
            }
            if (!kbCheck.ok) {
                return res.status(400).json({ error: 'Unknown, inaccessible or cross-organisation knowledge bases', invalid: kbCheck.invalid });
            }
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

        // Log activity — diff what changed.
        const changes = {};
        for (const key of ['name', 'description', 'color', 'icon', 'extractMemories']) {
            if (req.body[key] !== undefined && before[key] !== updated[key]) {
                changes[key] = { from: before[key], to: updated[key] };
            }
        }
        if (Object.keys(changes).length > 0) {
            await logAndEmit(req.params.id, userId, 'project_updated', { changes });
        }
        if (req.body.customInstructions !== undefined && before.customInstructions !== updated.customInstructions) {
            await logAndEmit(req.params.id, userId, 'instructions_updated', {});
        }
        if (req.body.knowledgeBaseIds !== undefined) {
            const beforeKBs = new Set(before.knowledgeBaseIds || []);
            const afterKBs = new Set(updated.knowledgeBaseIds || []);
            for (const kb of afterKBs) {
                if (!beforeKBs.has(kb)) {
                    await logAndEmit(req.params.id, userId, 'kb_added', { targetType: 'kb', targetId: kb });
                }
            }
            for (const kb of beforeKBs) {
                if (!afterKBs.has(kb)) {
                    await logAndEmit(req.params.id, userId, 'kb_removed', { targetType: 'kb', targetId: kb });
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

// DELETE /:id — delete project (owner only)
router.delete('/:id', requireRole('owner'), async (req, res) => {
    try {
        // Detach everything that points at this project by SOFT reference before
        // deleting it. Conversations and memories have real FKs (SET NULL /
        // CASCADE) and take care of themselves; notebooks, automations and apps
        // do not, so without this they keep a project_id pointing at nothing —
        // invisible in the project list and unfindable in the standalone one.
        //
        // The original automations migration's header promised exactly this
        // cleanup, by name. It was never written. Deleting a project must never
        // destroy the work its members did inside it.
        await detachProjectResources(req.params.id);

        const ok = await projectStore.deleteProject(req.params.id);
        // No need to log — the project_activity row cascades away.
        res.json({ success: ok });
    } catch (err) {
        log.error('[Projects] Delete error:', err.message);
        // Raw err.message can carry SQL text, column names and constraint names.
        // The console.error above keeps the detail for operators.
        res.status(500).json({ error: 'Request failed' });
    }
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
            const allGroups = await userStore.getAllGroups();
            const targetGroup = allGroups.find(g => g.id === sharedWithId);
            if (!targetGroup) return res.status(400).json({ error: 'Unknown group' });
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
        await logAndEmit(req.params.id, userId, 'member_added', {
            targetType: sharedWithType, targetId: sharedWithId, role,
        });
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
        await logAndEmit(req.params.id, userId, 'member_removed', {
            targetType: share.sharedWithType, targetId: share.sharedWithId,
        });
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

// GET /:id/members — owner + members list (viewer+)
router.get('/:id/members', requireRole('viewer'), async (req, res) => {
    try {
        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });
        const shares = await projectStore.getProjectShares(req.params.id);
        res.json({ ownerId: project.ownerId, members: shares });
    } catch (err) {
        log.error('[Projects] Members list error:', err.message);
        // Raw err.message can carry SQL text, column names and constraint names.
        // The console.error above keeps the detail for operators.
        res.status(500).json({ error: 'Request failed' });
    }
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

        await logAndEmit(req.params.id, userId, 'member_role_changed', {
            targetType: before.sharedWithType, targetId: before.sharedWithId,
            from: before.permission, to: normalized,
        });
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
        await logAndEmit(req.params.id, userId, 'member_removed', {
            targetType: share.sharedWithType, targetId: share.sharedWithId,
            selfLeave: isSelf && !isOwner,
        });
        res.json({ success: ok });
    } catch (err) {
        log.error('[Projects] Remove member error:', err.message);
        // Raw err.message can carry SQL text, column names and constraint names.
        // The console.error above keeps the detail for operators.
        res.status(500).json({ error: 'Request failed' });
    }
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
        res.json({ items: hasMore ? items.slice(0, limit) : items, hasMore });
    } catch (err) {
        log.error('[Projects] Activity error:', err.message);
        // Raw err.message can carry SQL text, column names and constraint names.
        // The console.error above keeps the detail for operators.
        res.status(500).json({ error: 'Request failed' });
    }
});

// ── Live stream ──────────────────────────────────────────

/**
 * GET /:id/stream — the project's live feed.
 *
 * Delivery is CURSOR-BASED, not push-only. Every durable frame carries
 * `id: <seq>`, so a client that drops reconnects with Last-Event-ID (or
 * ?since=) and replays exactly what it missed. Reconnect and live delivery are
 * the same code path, which is what makes "you never miss a message" true
 * rather than aspirational.
 *
 * The bus (core/projectEventBus.js) is only a doorbell: it says "project X
 * moved", and this handler reads forward from its cursor. Without Redis the
 * doorbell is in-process and the poll below covers cross-replica delivery.
 */
const STREAM_POLL_MS = 1500;
const STREAM_ROLE_RECHECK_MS = 60_000;

router.get('/:id/stream', requireRole('viewer'), validate({ query: S.StreamQuery }), async (req, res) => {
    const projectId = req.params.id;
    const userId = getUserId(req);
    const { setupSSE, startSseHeartbeat } = require('../core/http/sseHelpers');
    const bus = require('../core/projectEventBus');
    const { getProjectRole } = require('../auth/projectAccess');

    const { sendEvent } = setupSSE(res);

    // Cursor: Last-Event-ID is what EventSource sends automatically on
    // reconnect; ?since= is for the fetch-based client.
    let cursor = Number(req.headers['last-event-id'] ?? req.query.since ?? 0) || 0;

    // A brand-new subscriber (no cursor) starts from HEAD. Replaying a week of
    // history to someone who just opened the page is noise, and the page loads
    // its own current state anyway.
    if (!cursor) {
        try { cursor = await projectStore.getProjectEventSeq(projectId); } catch (_) { cursor = 0; }
    }
    sendEvent('ready', { since: cursor, distributed: bus.isDistributed() });

    let draining = false;
    let closed = false;

    // Serialised: two overlapping drains would emit out of order and could
    // advance the cursor past events the client never received.
    async function drain() {
        if (draining || closed) return;
        draining = true;
        try {
            const { events, truncated } = await projectStore.listProjectEvents(projectId, cursor);
            for (const ev of events) {
                res.write(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
                cursor = ev.seq;
            }
            if (truncated) {
                // Too far behind to replay. Refetching is cheaper than
                // streaming a backlog, and leaves the client definitely correct.
                sendEvent('resync', { since: cursor });
            }
        } catch (err) {
            log.warn('[Projects] stream drain failed:', err.message);
        } finally {
            draining = false;
        }
    }

    // Transient events (typing, presence, run deltas) bypass the cursor
    // entirely: no row, no `id:` frame, so they never move the client forward.
    const unsubscribe = bus.subscribeProject(projectId, (ev) => {
        if (closed) return;
        if (ev?.transient) {
            sendEvent(ev.kind || 'transient', ev);
            return;
        }
        drain();
    });

    // Cross-replica safety net when Redis is absent, and a backstop for a
    // dropped publish when it is not.
    const poll = setInterval(drain, STREAM_POLL_MS);

    // A stream outlives a revocation unless it re-checks. Groups are resolved
    // fresh per call, so a removal takes effect here within a minute rather
    // than whenever the user next reloads.
    const roleCheck = setInterval(async () => {
        try {
            if (!await getProjectRole(userId, projectId)) {
                sendEvent('forbidden', { reason: 'access_revoked' });
                cleanup();
                res.end();
            }
        } catch (_) { /* transient failure: keep the stream, try again next tick */ }
    }, STREAM_ROLE_RECHECK_MS);

    const stopHeartbeat = startSseHeartbeat(res, 10_000, { onDead: () => cleanup() });

    function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(poll);
        clearInterval(roleCheck);
        stopHeartbeat();
        try { unsubscribe(); } catch (_) { /* already gone */ }
    }

    req.on('close', cleanup);

    await drain();   // anything that landed between the cursor read and subscribe
});

// ── Shared threads ───────────────────────────────────────

// GET /:id/threads — conversations shared into this project (viewer+)
router.get('/:id/threads', requireRole('viewer'), validate({ query: S.PageQuery }), async (req, res) => {
    try {
        const shared = require('../stores/agent/sharedConversations');
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const offset = parseInt(req.query.offset, 10) || 0;
        const threads = await shared.listProjectThreads(req.params.id, { limit, offset });
        res.json({ threads, role: req.projectRole });
    } catch (err) {
        log.error('[Projects] Threads list error:', err.message);
        res.status(500).json({ error: 'Request failed' });
    }
});

/**
 * POST /:id/threads — share one of MY conversations into this project.
 *
 * Requires editor on the project AND ownership of the conversation. Ownership
 * is not merely a permission rule: sharing re-encrypts the messages, and on the
 * `zk` tier the key that opens them exists only in the owner's live session.
 * Nobody else can perform the conversion, so nobody else may request it.
 */
router.post('/:id/threads', requireRole('editor'), validate({ body: S.ShareThreadBody }), async (req, res) => {
    try {
        const userId = getUserId(req);
        const { conversationId, type } = req.body || {};
        if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });

        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });

        const shared = require('../stores/agent/sharedConversations');
        const result = await shared.shareConversationToProject({
            conversationId,
            type: type === 'agent' ? 'agent' : 'direct',
            projectId: req.params.id,
            ownerId: userId,
            orgId: project.organizationId,
            encryptionKey: req.session?.encryptionKey || null,
        });

        // logAndEmit writes the audit row AND the live event — the other members'
        // thread lists update without a refresh.
        await logAndEmit(req.params.id, userId, 'thread_shared', {
            targetType: 'conversation', targetId: conversationId,
            conversationType: type === 'agent' ? 'agent' : 'direct',
        });

        res.json(result);
    } catch (err) {
        if (err.code === 'NOT_FOUND') return res.status(404).json({ error: 'Conversation not found' });
        if (err.code === 'PROJECT_KEY_UNAVAILABLE') {
            // Never fall back to plaintext here — this path rewrites rows that
            // are already encrypted.
            log.error('[Projects] share blocked, project key unavailable:', err.message);
            return res.status(503).json({
                error: 'Encryption key unavailable for this project. Check MASTER_ENCRYPTION_KEY and the org root key.',
            });
        }
        log.error('[Projects] Share thread error:', err.message);
        res.status(500).json({ error: 'Request failed' });
    }
});

// DELETE /:id/threads/:convId — take my conversation back out of the project.
// Owner-only for the same reason sharing is: it re-encrypts.
router.delete('/:id/threads/:convId', requireRole('viewer'), validate({ query: S.TypeQuery }), async (req, res) => {
    try {
        const userId = getUserId(req);
        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });

        const shared = require('../stores/agent/sharedConversations');
        const result = await shared.unshareConversation({
            conversationId: req.params.convId,
            type: req.query.type === 'agent' ? 'agent' : 'direct',
            ownerId: userId,
            orgId: project.organizationId,
            encryptionKey: req.session?.encryptionKey || null,
        });

        await logAndEmit(req.params.id, userId, 'thread_unshared', {
            targetType: 'conversation', targetId: req.params.convId,
        });

        res.json(result);
    } catch (err) {
        if (err.code === 'NOT_FOUND') return res.status(404).json({ error: 'Conversation not found' });
        if (err.code === 'OWNER_KEY_REQUIRED') return res.status(409).json({ error: err.message });
        log.error('[Projects] Unshare thread error:', err.message);
        res.status(500).json({ error: 'Request failed' });
    }
});

// POST /:id/typing — transient presence. No row, no seq, no replay.
router.post('/:id/typing', requireRole('viewer'), validate({ body: S.TypingBody }), async (req, res) => {
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

    const kinds = membership.listKinds();
    const sections = await Promise.all(
        kinds.map(k => load(k.section, () => k.list(projectId, viewer))),
    );

    const body = { role: req.projectRole };
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

        const target = attach ? req.params.id : null;
        // The fourth argument is the context a kind may need to answer the
        // move: the project being edited (which `target` cannot carry when the
        // caller is taking something OUT) and the request an access check is
        // made against. Kinds whose link is a column on their own row ignore it.
        const ok = await entry.setProject(id, userId, target, { req, projectId: req.params.id });

        if (!ok) return res.status(404).json({ error: 'Not found, or not yours to move' });

        await logAndEmit(req.params.id, userId, attach ? 'resource_added' : 'resource_removed', {
            targetType: kind, targetId: id,
        });
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

        const results = { assigned: 0, unassigned: 0 };

        if (Array.isArray(assign)) {
            for (const conv of assign) {
                const table = conv.type === 'agent' ? 'agent_conversations' : 'direct_conversations';
                // Pass userId so the store WHERE clause rejects conversations
                // belonging to other users (IDOR guard).
                const ok = await projectStore.assignConversation(conv.id, req.params.id, userId, table);
                if (ok) {
                    results.assigned++;
                    await logAndEmit(req.params.id, userId, 'conversation_assigned', {
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
                    await logAndEmit(req.params.id, userId, 'conversation_unassigned', {
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

module.exports = router;
// The loader behind GET /:id/graph, GET /:id/completeness and GET /summary.
// Exported (not moved) so routes/studio/attention.js can ask the SAME question
// about a Solution that this file's own routes ask — including its `unavailable`
// list, which is what keeps "could not read half of it" from reading as "clean".
// It authorises nothing on its own: every caller resolves the project role, or
// the project list, before it hands an id over.
module.exports.buildGraphForProject = buildGraphForProject;
