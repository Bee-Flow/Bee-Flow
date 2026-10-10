/**
 * The organisation's MCP access policy. Org admins only, on their own org.
 *
 *   GET /api/org/mcp-access → { policy, callerIp }
 *   PUT /api/org/mcp-access   (a full policy) → the saved policy
 *
 * `callerIp` is the address this request came from, so the UI can warn an
 * admin before they save an IP allow-list that locks their own client out.
 * Storage, validation and the audit row are auth/mcpAccess/orgPolicy.js.
 */

const express = require('express');
const { requirePrimaryOrgAdmin } = require('../auth/permissions');
const { validate } = require('../core/http/validate');
const { PolicySchema, getOrgMcpPolicy, saveOrgMcpPolicy } = require('../auth/mcpAccess/orgPolicy');
const { z } = require('zod');

const router = express.Router();

const NO_QUERY = z.object({}).strict('This route takes no query parameters.');

router.get('/', requirePrimaryOrgAdmin(), validate({ query: NO_QUERY }), async (req, res) => {
    const policy = await getOrgMcpPolicy(req.primaryOrgId);
    res.json({ policy, callerIp: req.ip || null });
});

router.put('/', requirePrimaryOrgAdmin(), validate({ body: PolicySchema }), async (req, res) => {
    const policy = await saveOrgMcpPolicy(req.primaryOrgId, req.body, req.session.user.id);
    res.json({ policy });
});

module.exports = router;
