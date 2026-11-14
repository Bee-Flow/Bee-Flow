// @typecheck strict
/**
 * Knowledge Bases — per-user favorites (DB-backed).
 */

const express = require('express');
const router = express.Router();
const kbStore = require('../../stores/knowledgeBases');
const { requireAuth } = require('../../auth');
const { getUserId } = require('./shared');
// Favouriting needs read access to the base (core/kb/kbAccess.js, the one
// place that decides it): a published or shared base stays favouritable, an
// unknown or foreign id answers the same 404. Removing a favourite is the
// caller's own list, so it takes any id: a base unshared since must still be
// removable.
const { canAccessKB, requireKbGrade } = require('../../core/kb/kbAccess');
const { validate } = require('../../core/http/validate');
const { bodyOf } = require('../../core/http/schemaParts');
const { z, typeError } = require('../../utils/zod');
const { bestEffort } = require('../../utils/bestEffort');

const KB_IDS = 'kbIds is a list of knowledge base ids.';
const BulkFavoritesBody = z.object({
    // A one-time migration of what a browser had in localStorage, so a blank
    // entry is dropped rather than refused: the person's other favourites
    // must still arrive.
    kbIds: z.array(z.string({ error: typeError({ invalid: KB_IDS }) }), { error: KB_IDS })
        .transform((ids) => ids.filter(Boolean)),
}).strict();

// ── KB Favorites ────────────────────────────────────────────────────
// Per-user favorited KBs (DB-backed; replaces client-side localStorage).
// Defined before /:id routes so GET /favorites is not captured by GET /:id.

router.get('/favorites', requireAuth, async (req, res) => {
    const userId = getUserId(req);
    const ids = await kbStore.listFavorites(userId);
    res.json(ids);
});

router.post('/favorites/bulk', requireAuth, validate({ body: BulkFavoritesBody }), async (req, res) => {
    const userId = getUserId(req);
    for (const id of req.body.kbIds) {
        const kb = await kbStore.getKB(id).catch((/** @type {unknown} */ err) => { bestEffort('routes/knowledgeBases/favorites:bulk#getKB', err); return null; });
        if (!kb || !(await canAccessKB(req, kb))) continue;
        try { await kbStore.addFavorite(userId, id); } catch (err) { bestEffort('routes/knowledgeBases/favorites:anon', err); /* skip invalid */ }
    }
    const ids = await kbStore.listFavorites(userId);
    res.json(ids);
});

router.put('/:id/favorite', requireAuth, requireKbGrade('read'), validate({ body: bodyOf({}, 'Marking a favourite') }), async (req, res) => {
    const userId = getUserId(req);
    await kbStore.addFavorite(userId, req.params.id);
    res.json({ success: true });
});

router.delete('/:id/favorite', requireAuth, async (req, res) => {
    const userId = getUserId(req);
    await kbStore.removeFavorite(userId, req.params.id);
    res.json({ success: true });
});
module.exports = router;
