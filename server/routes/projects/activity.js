// @typecheck
/**
 * What happens in a project, as it happens, and the caller's own quiet switch.
 *
 *   PUT    /:id/mute                  mute this project's notifications for me   (viewer+)
 *   DELETE /:id/mute                  unmute                                     (viewer+)
 *   GET    /:id/activity?limit=&offset=  the audit trail, paged                  (viewer+)
 *   GET    /:id/stream                the live feed (and one co-edited document) (viewer+)
 *   POST   /:id/typing                transient presence                         (viewer+)
 *
 * Moved here unchanged from routes/projects.js. A FACTORY router:
 * `makeActivityRouter(deps)` takes the stores, the role gate and the lazily
 * loaded collaborators, so routes/projects.js mounts it over the same handles
 * its route tests replace, at the same place in the route table
 * (routes/projects.routetable.test.js).
 */

'use strict';

const express = require('express');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const S = require('./schemas');
const CollabS = require('./collabSchemas');
const { makeProjectStreamHandler } = require('./collabStream');

/**
 * @param {object} deps
 * @param {Function} deps.requireProjectRole        (minRole) => middleware named requireProjectRoleMw
 * @param {object}   deps.projectStore              stores/projectStore
 * @param {object}   deps.notificationPrefsStore    stores/notificationPrefsStore
 * @param {Function} deps.getUserId                 (req) => the caller's user id
 * @param {Function} deps.perUserRateLimit          utils/perUserRateLimit perUserRateLimit
 * @param {Function} deps.projectFiles              () => projects/projectFiles (loaded on first use)
 * @param {Function} deps.projectEventBus           () => core/projectEventBus (loaded on first use)
 */
function makeActivityRouter(deps) {
    const router = express.Router();
    const { projectStore, notificationPrefsStore, getUserId, perUserRateLimit, projectFiles, projectEventBus } = deps;
    const requireRole = deps.requireProjectRole;

    // ── Mute: stop the bell and the mail for this project (mine only) ─

    router.put('/:id/mute', requireRole('viewer'), validate({ body: S.MuteBody }), async (req, res) => {
        await notificationPrefsStore.setMuted(getUserId(req), req.params.id, true);
        res.json({ muted: true });
    });

    router.delete('/:id/mute', requireRole('viewer'), async (req, res) => {
        await notificationPrefsStore.setMuted(getUserId(req), req.params.id, false);
        res.json({ muted: false });
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
            const named = await projectFiles().nameFileActivity(project || { id: req.params.id }, page);
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
            const bus = projectEventBus();
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

    return router;
}

module.exports = { makeActivityRouter };
