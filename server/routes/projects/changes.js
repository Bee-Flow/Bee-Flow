// @typecheck
/**
 * What changed in a project, per reader.
 *
 *   GET  /:id/changes?since=visit|unread|<iso>&group=item|person   viewer
 *        → { groups, truncated, since, prevVisitAt, visitStartedAt }   `truncated`: older changes are not in the groups
 *   GET  /:id/changes/log?limit=&offset=                           viewer
 *        → { items, hasMore }   the Activity tab's "Changes only" view
 *   POST /:id/visit                                               viewer
 *        → { prevVisitAt, visitStartedAt }   the page was opened (or is still open)
 *   POST /:id/seen                                                viewer
 *        → { ok, seenAt }   "mark everything as seen"
 *   POST /:id/items/:type/:itemId/seen { versionId? }             viewer
 *        → { ok, seenAt, seenVersionId }   the reader has seen this item
 *
 * Groups (`group=item`): `{ item: {type, id, title, available}, lastChangedAt,
 * changeCount, contributors: [{userId, kind}], stats, latestVersionId,
 * seenVersionId, seenAt, kinds, aiAssisted, minor, unread }`. The reader's own changes
 * are never in them. `since=unread` is the unread marks: only unread groups,
 * of items still in the project.
 *
 * Titles are resolved HERE, per request, with the reader's access
 * (projects/changeTitles.js): the feed itself stores ids and counts only. An
 * item that left the project comes back without a title (`available: false`)
 * and is shown only when leaving is the change being reported.
 *
 * A FACTORY router (`makeChangesRouter(deps)`), tested with fakes and no
 * module mocking; routes/projects.js mounts the default instance behind the
 * /api/projects session and licence gates. Every route starts with
 * `requireProjectRole`: 404 for a non-member, 403 for a role that is too low.
 * Seen marks are the reader's own, so a viewer records them too; none of
 * these routes writes to the project's feed.
 */

'use strict';

const express = require('express');
const { validate } = require('../../core/http/validate');
const { lazyProjectRoleGate } = require('./roleGate');
const { notFound } = require('../../core/http/errors');
const S = require('./changesSchemas');

/** How many change rows one read of the feed looks at. */
const CHANGE_ROWS_READ = 500;

/**
 * @param {object} [deps]
 * @param {Function} [deps.requireProjectRole]  (minRole) => middleware named requireProjectRoleMw
 * @param {object}   [deps.store]              projectStore change-feed surface
 * @param {object}   [deps.titles]             projects/changeTitles surface ({ resolveTitles })
 * @param {object}   [deps.feed]               projects/changeFeed surface ({ summarizeChangesPage, changeWindow, VISIT_GAP_MS })
 * @param {Function} [deps.markLimiter]        rate limit for the visit and seen writes
 */
function makeChangesRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });

    const requireRole = deps.requireProjectRole || lazyProjectRoleGate;
    const store = () => deps.store || require('../../stores/projectStore');
    const titles = () => deps.titles || require('../../projects/changeTitles');
    const feed = () => deps.feed || require('../../projects/changeFeed');
    // The page pings on open and every few minutes while it stays open, and
    // marks an item after it has been in view for a moment: this leaves room
    // for several tabs and stops a loop from turning marks into a flood.
    const markLimiter = deps.markLimiter || require('../../utils/perUserRateLimit').perUserRateLimit({
        windowMs: 60_000,
        max: 60,
        keyFn: (req) => `${req.session?.user?.id || req.ip}:${req.params?.id || ''}:marks`,
    });

    const userIdOf = (req) => req.session?.user?.id;
    const keyOf = (item) => `${item.type}:${item.id}`;

    /** Stamp title + availability on every item, with this reader's access. */
    async function withTitles(projectId, items) {
        const unique = new Map();
        for (const item of items) unique.set(keyOf(item), item);
        const found = await titles().resolveTitles(projectId, [...unique.values()]);
        return (item) => {
            const hit = found.get(keyOf(item));
            return { type: item.type, id: item.id, title: hit ? hit.title : null, available: !!hit };
        };
    }

    router.get('/:id/changes', requireRole('viewer'), validate({ query: S.ChangesQuery }), async (req, res) => {
        const projectId = req.params.id;
        const userId = userIdOf(req);
        const since = req.query.since || 'visit';
        const groupBy = req.query.group === 'person' ? 'person' : 'item';
        const { summarizeChangesPage, changeWindow } = feed();

        const state = await store().getMemberState(projectId, userId);
        const base = {
            since,
            prevVisitAt: state ? state.prevVisitAt : null,
            visitStartedAt: state ? state.visitStartedAt : null,
        };
        const start = changeWindow(since, state);
        if (!start) return res.json({ groups: [], ...base });

        const rows = await store().listChangeRows(projectId, {
            sinceAt: start.toISOString(), excludeActorId: userId, limit: CHANGE_ROWS_READ,
        });
        const touched = new Map();
        for (const r of rows) {
            const type = r.itemType || r.targetType;
            const id = r.itemId || r.targetId;
            if (type && id) touched.set(`${type}:${id}`, { type, id });
        }
        const reads = await store().listItemReads(projectId, userId, [...touched.values()]);
        const page = summarizeChangesPage(rows, { state, reads, groupBy, onlyUnread: since === 'unread' });
        const summary = page.groups;
        // Either the groups were cut to the newest few, or the rows read were (what lies beyond them is not counted at all).
        const truncated = page.truncated || rows.length >= CHANGE_ROWS_READ;

        if (groupBy === 'person') {
            const named = await withTitles(projectId, summary.flatMap((p) => p.items));
            const groups = summary
                .map((p) => ({ ...p, items: p.items.map(named).filter((i) => i.available) }))
                .filter((p) => p.items.length > 0);
            return res.json({ groups, truncated, ...base });
        }

        const named = await withTitles(projectId, summary.map((g) => g.item));
        const groups = summary
            .map((g) => ({ ...g, item: named(g.item) }))
            // Leaving the project is itself worth saying; anything else about
            // an item the reader can no longer open is not.
            .filter((g) => g.item.available || (since !== 'unread' && g.kinds.includes('removed')));
        return res.json({ groups, truncated, ...base });
    });

    router.get('/:id/changes/log', requireRole('viewer'), validate({ query: S.ChangeLogQuery }), async (req, res) => {
        const projectId = req.params.id;
        const limit = req.query.limit || 50;
        const offset = req.query.offset || 0;
        const rows = await store().listChangeLog(projectId, { limit: limit + 1, offset });
        const page = rows.slice(0, limit);
        const itemOf = (r) => {
            const type = r.itemType || r.targetType;
            const id = r.itemId || r.targetId;
            return type && id ? { type, id } : null;
        };
        const named = await withTitles(projectId, page.map(itemOf).filter(Boolean));
        const items = page.map((r) => {
            const item = itemOf(r);
            const resolved = item ? named(item) : null;
            return {
                id: r.id,
                action: r.action,
                actorId: r.actorId,
                actorKind: r.actorKind,
                targetType: r.targetType,
                targetId: r.targetId,
                itemType: r.itemType,
                itemId: r.itemId,
                versionId: r.versionId,
                details: r.details,
                createdAt: r.createdAt,
                updatedAt: r.updatedAt,
                title: resolved ? resolved.title : null,
            };
        });
        res.json({ items, hasMore: rows.length > limit });
    });

    router.post('/:id/visit', requireRole('viewer'), markLimiter, validate({ body: S.VisitBody }), async (req, res) => {
        const state = await store().recordVisit(req.params.id, userIdOf(req), { gapMs: feed().VISIT_GAP_MS });
        if (!state) throw notFound('not_found', 'Not found');
        res.json({ prevVisitAt: state.prevVisitAt, visitStartedAt: state.visitStartedAt });
    });

    router.post('/:id/seen', requireRole('viewer'), markLimiter, validate({ body: S.SeenBody }), async (req, res) => {
        const state = await store().markAllSeen(req.params.id, userIdOf(req));
        if (!state) throw notFound('not_found', 'Not found');
        res.json({ ok: true, seenAt: state.seenAt });
    });

    router.post('/:id/items/:type/:itemId/seen', requireRole('viewer'), markLimiter,
        validate({ params: S.ItemParams, body: S.ItemSeenBody }), async (req, res) => {
            const { id: projectId, type, itemId } = req.params;
            // Only an item that is in this project, which is also what makes
            // it readable to this member.
            const found = await titles().resolveTitles(projectId, [{ type, id: itemId }]);
            if (!found.has(`${type}:${itemId}`)) throw notFound('item_not_found', 'That item is not in this project.');
            const mark = await store().markItemSeen(projectId, userIdOf(req), type, itemId, req.body.versionId || null);
            if (!mark) throw notFound('not_found', 'Not found');
            res.json({ ok: true, seenAt: mark.seenAt, seenVersionId: mark.seenVersionId });
        });

    return router;
}

module.exports = makeChangesRouter();
module.exports.makeChangesRouter = makeChangesRouter;
