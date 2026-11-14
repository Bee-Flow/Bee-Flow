// @typecheck strict
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
const { z } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');

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
    // Only a category of the caller's own organisation (the ones GET /categories lists); one of another
    // organisation answers as an unknown id. The super admin (no organisation filter) reaches every one.
    const orgIds = await resolveUserOrgIds(req);
    if (orgIds !== null) {
        const orgId = orgIds.size > 0 ? Array.from(orgIds)[0] : null;
        const own = await kbStore.listKBCategories(orgId);
        if (!own.some((/** @type {{ id: string }} */ c) => String(c.id) === String(req.params.id))) {
            return res.status(404).json({ error: 'Category not found', code: 'category_not_found' });
        }
    }
    await kbStore.deleteKBCategory(req.params.id);
    res.json({ success: true });
});
module.exports = router;
