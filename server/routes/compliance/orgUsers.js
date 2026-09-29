/**
 * Compliance — the org member directory behind the DPO / breach-recipient
 * pickers.
 */

const express = require('express');
const router = express.Router();

const { getAll } = require('../../db');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { resolveOrgId } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** This route reads nothing from the query; a parameter there is a typo. */
const NoQuery = z.object({}).strict();

// ───────────────── Org member directory ─────────────────
//
// Minimal directory for the DPO / breach-recipient pickers. Deliberately NOT
// GET /auth/users: that gate (manage_users/admin_security/org_admin) 403s a
// pure-DPO caller. Same access story as /auto-detect-settings above:
// admin_compliance may read org member names/emails, nothing more.

router.get('/org-users', requireAuth, requirePermission('admin_compliance'), validate({ query: NoQuery }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    let rows = [];
    try {
        rows = await getAll(
            `SELECT id, username, "displayName", "firstName", "lastName", email, phone, "orgRole"
                 FROM users
                 WHERE "organizationId" = $1
                   AND email IS NOT NULL AND email <> ''
                   AND id <> 'admin'
                 ORDER BY LOWER(COALESCE(NULLIF("displayName", ''), username))`,
            [orgId],
        );
    } catch { rows = []; }
    res.json((rows || []).map(u => ({
        id: u.id,
        displayName: u.displayName
            || [u.firstName, u.lastName].filter(Boolean).join(' ').trim()
            || u.username,
        email: u.email,
        phone: u.phone || null,
        orgRole: u.orgRole || null,
    })));
});

module.exports = router;
