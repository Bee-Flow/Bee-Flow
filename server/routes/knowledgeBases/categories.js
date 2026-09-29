/**
 * Knowledge Bases — categories (org-level, mirrors agent_categories).
 *
 * Registered ahead of the /:id routes so GET /categories is not captured by
 * GET /:id, and DELETE /categories/:id not by DELETE /:id/favorite.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const kbStore = require('../../stores/knowledgeBases');
const { requireAuth, requirePermission, resolveUserOrgIds } = require('../../auth');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const NAME_TEXT = 'A category needs a name.';
const CategoryBody = z.object({
    name: worded(NAME_TEXT).trim().min(1, NAME_TEXT).max(100, 'A category name is at most 100 characters.'),
    icon: worded('A category icon must be text.').trim().max(16, 'A category icon is at most 16 characters.').optional(),
    color: worded('A category colour must be text.').trim().max(32, 'A category colour is at most 32 characters.').nullish(),
}).strict();

// ── KB Categories (org-level, mirrors agent_categories) ─────────────

router.get('/categories', requireAuth, async (req, res) => {
    const orgIds = await resolveUserOrgIds(req);
    const orgId = orgIds !== null && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
    const categories = await kbStore.listKBCategories(orgId);
    res.json(categories);
});

router.post('/categories', requireAuth, requirePermission('manage_knowledge'), validate({ body: CategoryBody }), async (req, res) => {
    const { name, icon, color } = req.body;
    const orgIds = await resolveUserOrgIds(req);
    const orgId = orgIds !== null && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
    const id = crypto.randomUUID();
    const category = await kbStore.createKBCategory({ id, organizationId: orgId, name, icon, color });
    res.status(201).json(category);
});

router.delete('/categories/:id', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    await kbStore.deleteKBCategory(req.params.id);
    res.json({ success: true });
});
module.exports = router;
