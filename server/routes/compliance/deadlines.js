/**
 * GET /api/compliance/deadlines — every running statutory clock of the org.
 *
 * Thin: the clocks are computed in compliance/deadlines.js (`build`), which
 * also decides `state` from the regulation's own thresholds so the client
 * never invents one. Org-strict (403 no_organisation). Never triggers a run.
 */

'use strict';

const express = require('express');
const router = express.Router();

const deadlines = require('../../compliance/deadlines');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { requireOrgId } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** This route reads nothing from the query; a parameter there is a typo. */
const NoQuery = z.object({}).strict();

router.get('/deadlines', requireAuth, requirePermission('admin_compliance'), validate({ query: NoQuery }), async (req, res) => {
    const orgId = await requireOrgId(req, res);
    if (!orgId) return;
    res.set('Cache-Control', 'private, no-store');
    res.json(await deadlines.build(orgId));
});

module.exports = router;
