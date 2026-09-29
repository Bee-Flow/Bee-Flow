/**
 * Compliance — the Data Act export matrix (Art. 30): for every kind of data
 * this organisation holds, whether a portable export route exists, is mounted,
 * and in which formats. Read-only; nothing is exported here.
 *
 * Mounted from routes/compliance.js (literal path, ahead of the sub-routers
 * that match a bare '/:param').
 */

const express = require('express');
const router = express.Router();

const { requireAuth, requirePermission } = require('../../auth/permissions');
const { resolveOrgId } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** This route reads nothing from the query; a parameter there is a typo. */
const NoQuery = z.object({}).strict();
const exportRegistry = require('../../compliance/dataPortability/exportRegistry');

router.get('/portability', requireAuth, requirePermission('admin_compliance'), validate({ query: NoQuery }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const matrix = await exportRegistry.coverageMatrix(orgId);
    res.json(matrix);
});

module.exports = router;
