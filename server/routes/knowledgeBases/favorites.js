/**
 * Knowledge Bases — per-user favorites (DB-backed).
 */

const express = require('express');
const router = express.Router();
const kbStore = require('../../stores/knowledgeBases');
const { requireAuth } = require('../../auth');
const { getUserId } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const KB_IDS = 'kbIds is a list of knowledge base ids.';
const BulkFavoritesBody = z.object({
    // A one-time migration of what a browser had in localStorage, so a blank
    // entry is dropped rather than refused: the person's other favourites
    // must still arrive.
    kbIds: z.array(z.string({ invalid_type_error: KB_IDS }), { required_error: KB_IDS, invalid_type_error: KB_IDS })
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
        try { await kbStore.addFavorite(userId, id); } catch (_) { /* skip invalid */ }
    }
    const ids = await kbStore.listFavorites(userId);
    res.json(ids);
});

router.put('/:id/favorite', requireAuth, async (req, res) => {
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
