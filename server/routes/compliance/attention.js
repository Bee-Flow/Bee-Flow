/**
 * GET /api/compliance/attention?limit=5 — the "Needs attention" list.
 *
 * Thin: the aggregation lives in compliance/attention.js (`build`). `limit`
 * 0–50, default 5. Org-strict (403 no_organisation): the list is org data.
 * Never triggers a check run.
 */

'use strict';

const express = require('express');
const router = express.Router();

const attention = require('../../compliance/attention');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { requireOrgId } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const LIMIT_TEXT = 'limit must be a whole number of rows.';
/** `?limt=10` used to fall back to five rows without saying so. */
const AttentionQuery = z.object({
    limit: z.coerce.number({ invalid_type_error: LIMIT_TEXT })
        .int(LIMIT_TEXT).min(0, LIMIT_TEXT).max(50, 'limit is at most 50.').optional(),
}).strict();

router.get('/attention', requireAuth, requirePermission('admin_compliance'), validate({ query: AttentionQuery }), async (req, res) => {
    const orgId = await requireOrgId(req, res);
    if (!orgId) return;
    res.set('Cache-Control', 'private, no-store');
    const limit = req.query.limit ?? 5;
    res.json(await attention.build(orgId, { limit, req }));
});

module.exports = router;
