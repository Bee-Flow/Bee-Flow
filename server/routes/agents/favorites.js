/**
 * Agent Favorites Routes
 *
 * Per-user favorited agents (DB-backed, replaces client-side localStorage).
 * Mounted before /:id routes so that GET /favorites does not collide with
 * GET /:id.
 */

const express = require('express');
const router = express.Router();
const agentStore = require('../../stores/agentStore');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const AGENT_IDS = 'agentIds is a list of agent ids.';
const BulkFavoritesBody = z.object({
    // A one-time migration of what a browser had in localStorage, so a blank
    // entry is dropped rather than refused: the person's other favourites
    // must still arrive.
    agentIds: z.array(z.string({ invalid_type_error: AGENT_IDS }), { required_error: AGENT_IDS, invalid_type_error: AGENT_IDS })
        .transform((ids) => ids.filter(Boolean)),
}).strict();

function requireUser(req, res) {
    const userId = req.session?.user?.id;
    if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return null;
    }
    return userId;
}

// List the current user's favorite agent IDs
router.get('/favorites', async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const ids = await agentStore.listAgentFavorites(userId);
    res.json(ids);
});

// Add favorite (idempotent)
router.put('/:id/favorite', async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    await agentStore.addAgentFavorite(userId, req.params.id);
    res.json({ success: true });
});

// Remove favorite (idempotent)
router.delete('/:id/favorite', async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    await agentStore.removeAgentFavorite(userId, req.params.id);
    res.json({ success: true });
});

// Bulk add — used for one-time client→DB migration of legacy localStorage favorites.
// Validate each agent exists and the caller can read it before favouriting; without
// this an attacker could favourite (and later enumerate via GET /favorites)
// arbitrary agent IDs they have no business seeing.
const MAX_BULK_FAVORITES = 200;
router.post('/favorites/bulk', validate({ body: BulkFavoritesBody }), async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const { agentIds } = req.body;
    // Size, not shape: too many is a 413, which `validate` cannot answer.
    if (agentIds.length > MAX_BULK_FAVORITES) {
        return res.status(413).json({ error: `Too many agentIds (max ${MAX_BULK_FAVORITES})` });
    }
    const { canReadAgent } = require('./crud');
    for (const id of agentIds) {
        const agent = await agentStore.getAgent(id).catch(() => null);
        if (!agent) continue;
        if (!(await canReadAgent(agent, userId, req))) continue;
        try { await agentStore.addAgentFavorite(userId, id); } catch (_) { /* skip invalid */ }
    }
    const ids = await agentStore.listAgentFavorites(userId);
    res.json(ids);
});

module.exports = router;
